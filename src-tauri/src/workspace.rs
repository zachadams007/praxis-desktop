//! Filesystem boundary for the acceptance chain. Every command runs its IO and
//! child process work on the blocking pool, never the Tauri webview thread.
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, serde::Serialize)]
pub struct ManifestFile {
    pub rel: String,
    pub bytes: u64,
}
#[derive(Debug, Clone, serde::Serialize)]
pub struct ManifestEntry {
    pub rel: String,
    pub abs: String,
    pub bytes: u64,
    pub title: Option<String>,
    pub head: String,
}
#[derive(Debug, Clone, serde::Serialize)]
pub struct WorkspaceManifest {
    pub root: String,
    pub files: Vec<ManifestFile>,
    pub total_bytes: u64,
    pub entry: Option<ManifestEntry>,
}

fn builds_root() -> Result<PathBuf, String> {
    if let Some(root) =
        std::env::var_os("PRAXIS_BUILDS_DIR").filter(|s| !s.to_string_lossy().trim().is_empty())
    {
        return Ok(PathBuf::from(root));
    }
    std::env::var_os("USERPROFILE")
        .map(|p| PathBuf::from(p).join("praxis-builds"))
        .ok_or_else(|| "USERPROFILE is not set".into())
}

/// Where an agent step with no project folder of its own runs.
///
/// A neutral folder beside the builds.
pub(crate) fn scratch_dir() -> Option<String> {
    let dir = builds_root().ok()?.join("scratch");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.to_string_lossy().into_owned())
}

fn sanitize_slug(slug: &str) -> String {
    let mut out = String::new();
    let mut separator = false;
    for c in slug.chars() {
        if c.is_ascii_alphanumeric() {
            if separator && !out.is_empty() {
                out.push('-');
            }
            out.push(c.to_ascii_lowercase());
            separator = false;
        } else {
            separator = true;
        }
    }
    out.truncate(out.len().min(48));
    let out = out.trim_end_matches('-');
    if out.is_empty() {
        "build".into()
    } else {
        out.into()
    }
}

/// Both arguments are canonical paths; equality is deliberately not "inside".
fn inside_root(path: &Path, root: &Path) -> bool {
    path != root && path.starts_with(root)
}

fn checked_root(root: &Path, builds: &Path) -> Result<PathBuf, String> {
    let builds = builds
        .canonicalize()
        .map_err(|e| format!("builds root: {e}"))?;
    let root = root
        .canonicalize()
        .map_err(|e| format!("workspace root: {e}"))?;
    if !root.is_dir() || !inside_root(&root, &builds) {
        return Err("workspace must be a directory inside the builds root".into());
    }
    Ok(root)
}

fn relative_path(rel: &str) -> Result<PathBuf, String> {
    // Check both separator styles on every platform. Colon also blocks Windows
    // drive-relative paths and NTFS alternate data streams.
    if rel.is_empty() || rel.starts_with(['/', '\\']) || rel.contains([':', '\0']) {
        return Err("file path must be relative without drive or UNC prefix".into());
    }
    let mut path = PathBuf::new();
    for part in rel.split(['/', '\\']) {
        if part == ".." {
            return Err("parent traversal is not allowed".into());
        }
        if part.is_empty() || part == "." {
            continue;
        }
        // Win32 strips trailing dots/spaces and interprets device names. Refuse
        // ambiguous components rather than validating one path and writing another.
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || stem
                .strip_prefix("COM")
                .or_else(|| stem.strip_prefix("LPT"))
                .is_some_and(|s| s.len() == 1 && matches!(s.as_bytes()[0], b'1'..=b'9'));
        if part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "<>\"|?*".contains(c))
            || device
        {
            return Err("ambiguous or reserved file path component".into());
        }
        path.push(part);
    }
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("file path must name a relative file".into());
    }
    Ok(path)
}

fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

fn ensure_plain(path: &Path) -> Result<fs::Metadata, String> {
    let meta =
        fs::symlink_metadata(path).map_err(|e| format!("inspect {}: {e}", path.display()))?;
    if is_link(&meta) {
        return Err(format!(
            "links and junctions are not allowed: {}",
            path.display()
        ));
    }
    Ok(meta)
}

/// Win32 provides the local date without another dependency or timezone guesses.
#[cfg(windows)]
fn local_date() -> Result<String, String> {
    #[repr(C)]
    #[derive(Default)]
    struct SystemTime {
        year: u16,
        month: u16,
        weekday: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        millis: u16,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetLocalTime(time: *mut SystemTime);
    }
    let mut time = SystemTime::default();
    // SAFETY: writable, correctly laid out SYSTEMTIME for the duration of the call.
    unsafe {
        GetLocalTime(&mut time);
    }
    Ok(format!(
        "{:04}-{:02}-{:02}",
        time.year, time.month, time.day
    ))
}

#[cfg(not(windows))]
fn local_date() -> Result<String, String> {
    let out = Command::new("date")
        .arg("+%Y-%m-%d")
        .output()
        .map_err(|e| format!("local date: {e}"))?;
    let date = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || date.len() != 10 {
        return Err("local date unavailable".into());
    }
    Ok(date)
}

// Serializes this module's prepare/write calls to avoid two concurrent requests
// selecting the same empty workspace. External agents still own their files.
static WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());
static TEMP_ID: AtomicU64 = AtomicU64::new(0);

fn prepare_in(builds: &Path, slug: &str, date: &str) -> Result<String, String> {
    let _guard = WRITES.lock().map_err(|_| "workspace lock poisoned")?;
    fs::create_dir_all(builds).map_err(|e| format!("create builds root: {e}"))?;
    let builds = builds.canonicalize().map_err(|e| e.to_string())?;
    let name = format!("{}-{date}", sanitize_slug(slug));
    for attempt in 1..=50 {
        let name = if attempt == 1 {
            name.clone()
        } else {
            format!("{name}-{attempt}")
        };
        let dir = builds.join(name);
        match fs::create_dir(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let meta = ensure_plain(&dir)?;
                if !meta.is_dir()
                    || fs::read_dir(&dir)
                        .map_err(|e| e.to_string())?
                        .next()
                        .is_some()
                {
                    continue;
                }
            }
            Err(e) => return Err(format!("create workspace: {e}")),
        }
        let dir = checked_root(&dir, &builds)?;
        let ignore = dir.join(".gitignore");
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&ignore)
        {
            Ok(mut file) => file
                .write_all(b"node_modules/\n")
                .map_err(|e| format!("write .gitignore: {e}"))?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("create .gitignore: {e}")),
        }
        let mut cmd = Command::new("git");
        cmd.args(["init", "-q"])
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        if let Ok(mut child) = cmd.spawn() {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if std::time::Instant::now() < deadline => {
                        std::thread::sleep(std::time::Duration::from_millis(20))
                    }
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                }
            }
        }
        return Ok(plain_path(&dir));
    }
    Err("all 50 workspace names are occupied".into())
}

/// A canonical path WITHOUT the `\\?\` verbatim prefix. These strings become a coding
/// agent's working directory and the file a browser opens; cmd, node tooling and
/// ShellExecute all mishandle `\\?\C:\...`, so nothing handed out may carry it.
pub(crate) fn plain_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.into_owned()
    }
}

#[tauri::command]
pub async fn workspace_prepare(slug: String, resume: Option<bool>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let builds = builds_root()?;
        let date = local_date()?;
        if resume == Some(true) {
            if let Some(dir) = unfinished_in(&builds, &slug, &date)? {
                return Ok(dir);
            }
            // The boundary used to be the calendar day: a build started at 23:50 and re-asked
            // at 00:10 was abandoned and paid for again. Yesterday's unfinished build still
            // counts while its brief was touched within the recency window.
            if let Some(yesterday) = previous_date(&date) {
                if let Some(dir) = unfinished_in(&builds, &slug, &yesterday)? {
                    if touched_within(Path::new(&dir), RESUME_WINDOW) {
                        return Ok(dir);
                    }
                }
            }
        }
        prepare_in(&builds, &slug, &date)
    })
    .await
    .map_err(|e| format!("workspace prepare worker: {e}"))?
}

/// Marker a verified-done run writes into its workspace. A workspace without it is
/// an UNFINISHED build that a same-day re-ask should continue instead of redoing.
pub(crate) const DONE_MARKER: &str = ".praxis-done";

/// How recently an unfinished build from YESTERDAY must have been worked on to be resumed
/// rather than started over. Twelve hours covers "late last night"; a stale attempt from
/// yesterday afternoon still starts fresh.
const RESUME_WINDOW: std::time::Duration = std::time::Duration::from_secs(12 * 60 * 60);

/// "2026-09-17" -> "2026-09-16" (proleptic Gregorian; handles month/year/leap edges).
pub(crate) fn previous_date(date: &str) -> Option<String> {
    let mut it = date.split('-');
    let (y, m, d): (i64, i64, i64) = (it.next()?.parse().ok()?, it.next()?.parse().ok()?, it.next()?.parse().ok()?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // days_from_civil / civil_from_days (Howard Hinnant).
    let (yy, mm) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = if yy >= 0 { yy } else { yy - 399 } / 400;
    let yoe = yy - era * 400;
    let doy = (153 * mm + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let z = era * 146_097 + doe - 1; // minus one day
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dd = doy - (153 * mp + 2) / 5 + 1;
    let m2 = if mp < 10 { mp + 3 } else { mp - 9 };
    let y2 = yoe + era * 400 + i64::from(m2 <= 2);
    Some(format!("{y2:04}-{m2:02}-{dd:02}"))
}

/// Was anything Praxis's agents write in this workspace modified within `window`?
fn touched_within(dir: &Path, window: std::time::Duration) -> bool {
    let newest = fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok()?.modified().ok())
        .max();
    newest.and_then(|t| t.elapsed().ok()).is_some_and(|age| age <= window)
}

/// The newest of today's `<slug>-<date>[-n]` workspaces that Praxis made (it has
/// PRAXIS-BRIEF.md) and that no run finished (no DONE_MARKER). Live 2026-09-16 a run
/// left a real 65 KB site behind after its agents timed out; asking again created a
/// fresh folder and would have paid for the whole build a second time.
fn unfinished_in(builds: &Path, slug: &str, date: &str) -> Result<Option<String>, String> {
    let Ok(builds) = builds.canonicalize() else {
        return Ok(None); // no builds root yet - nothing to resume
    };
    let base = format!("{}-{date}", sanitize_slug(slug));
    let mut best: Option<(u32, PathBuf)> = None;
    for attempt in 1..=50u32 {
        let name = if attempt == 1 { base.clone() } else { format!("{base}-{attempt}") };
        let dir = builds.join(&name);
        let Ok(meta) = fs::symlink_metadata(&dir) else {
            continue;
        };
        if !meta.is_dir() || meta.file_type().is_symlink() {
            continue;
        }
        if dir.join("PRAXIS-BRIEF.md").is_file() && !dir.join(DONE_MARKER).exists() {
            best = Some((attempt, dir));
        }
    }
    Ok(best.map(|(_, dir)| plain_path(&dir)))
}

fn write_in(builds: &Path, root: &Path, rel: &str, content: &str) -> Result<String, String> {
    let _guard = WRITES.lock().map_err(|_| "workspace lock poisoned")?;
    let root = checked_root(root, builds)?;
    let rel = relative_path(rel)?;
    let mut parent = root.clone();
    if let Some(dirs) = rel.parent() {
        for part in dirs.components() {
            parent.push(part);
            match fs::create_dir(&parent) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(format!("create parent: {e}")),
            }
            if !ensure_plain(&parent)?.is_dir()
                || !inside_root(&parent.canonicalize().map_err(|e| e.to_string())?, &root)
            {
                return Err("parent escapes workspace or is not a directory".into());
            }
        }
    }
    let destination = parent.join(rel.file_name().ok_or("missing filename")?);
    match fs::symlink_metadata(&destination) {
        Ok(meta) if is_link(&meta) || !meta.is_file() => {
            return Err("destination must be a regular file".into())
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("inspect destination: {e}")),
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = parent.join(format!(
        ".praxis-write-{}-{nonce}-{}.tmp",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| format!("create temp file: {e}"))?;
    let result = (|| {
        file.write_all(content.as_bytes())
            .map_err(|e| format!("write temp: {e}"))?;
        file.sync_all().map_err(|e| format!("sync temp: {e}"))?;
        drop(file);
        // std's Windows rename uses MoveFileExW(REPLACE_EXISTING); no delete gap.
        fs::rename(&temp, &destination).map_err(|e| format!("replace file: {e}"))?;
        Ok(plain_path(&destination))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[tauri::command]
pub async fn workspace_write_file(
    root: String,
    rel: String,
    content: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_in(&builds_root()?, Path::new(&root), &rel, &content)
    })
    .await
    .map_err(|e| format!("workspace write worker: {e}"))?
}

fn pick_entry<'a>(files: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let mut files: Vec<_> = files.into_iter().collect();
    files.sort_unstable();
    for preferred in [
        "index.html",
        "dist/index.html",
        "build/index.html",
        "site/index.html",
        "public/index.html",
        "docs/index.html",
    ] {
        if files.contains(&preferred) {
            return Some(preferred.into());
        }
    }
    files
        .into_iter()
        .find(|s| s.matches('/').count() <= 2 && s.to_ascii_lowercase().ends_with(".html"))
        .map(str::to_string)
}

fn parse_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut search = 0;
    while let Some(offset) = lower[search..].find("<title") {
        let start = search + offset + 6;
        if !lower[start..].starts_with('>') && !lower[start..].starts_with(char::is_whitespace) {
            search = start;
            continue;
        }
        let content = start + lower[start..].find('>')? + 1;
        let end = content + lower[content..].find("</title>")?;
        let title = html[content..end]
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&amp;", "&")
            .trim()
            .to_string();
        return if title.is_empty() { None } else { Some(title) };
    }
    None
}

/// A sorted frontier emits files in global relative-path order before the cap,
/// including when sibling filenames sort before a directory's children.
fn manifest_in(builds: &Path, root: &Path) -> Result<WorkspaceManifest, String> {
    let root = checked_root(root, builds)?;
    let mut pending = std::collections::BTreeMap::from([(String::new(), root.clone())]);
    let mut files = Vec::new();
    while files.len() < 400 {
        let Some((rel, path)) = pending.pop_first() else {
            break;
        };
        let meta = fs::symlink_metadata(&path).map_err(|e| format!("manifest inspect: {e}"))?;
        if is_link(&meta) {
            continue;
        }
        if meta.is_dir() {
            for entry in fs::read_dir(&path).map_err(|e| format!("manifest read dir: {e}"))? {
                let entry = entry.map_err(|e| e.to_string())?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.eq_ignore_ascii_case(".git") || name.eq_ignore_ascii_case("node_modules") {
                    continue;
                }
                pending.insert(format!("{rel}{name}"), entry.path());
                // Directory keys need a trailing slash to preserve global order.
                if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                    let key = format!("{rel}{name}");
                    if let Some(p) = pending.remove(&key) {
                        pending.insert(format!("{key}/"), p);
                    }
                }
            }
        } else if meta.is_file() {
            files.push(ManifestFile {
                rel,
                bytes: meta.len(),
            });
        }
    }
    // Preferred entries must remain discoverable even beyond the 400-file cap.
    let mut entry_paths = shallow_html_entries(&root)?;
    for preferred in [
        "index.html",
        "dist/index.html",
        "build/index.html",
        "site/index.html",
        "public/index.html",
        "docs/index.html",
    ] {
        if safe_entry_path(&root, preferred).is_some() {
            entry_paths.push(preferred.into());
        }
    }
    let entry = pick_entry(entry_paths.iter().map(String::as_str))
        .and_then(|rel| safe_entry_path(&root, &rel).map(|abs| (rel, abs)))
        .map(|(rel, abs)| -> Result<ManifestEntry, String> {
            let file = fs::File::open(&abs).map_err(|e| format!("read entry: {e}"))?;
            let bytes = file.metadata().map_err(|e| e.to_string())?.len();
            // Read the entry to find a title even when it appears past head's cap.
            let mut content = Vec::new();
            file.take(bytes)
                .read_to_end(&mut content)
                .map_err(|e| format!("read entry: {e}"))?;
            let html = String::from_utf8_lossy(&content);
            Ok(ManifestEntry {
                rel,
                abs: plain_path(&abs),
                bytes,
                title: parse_title(&html),
                head: html.chars().take(1500).collect(),
            })
        })
        .transpose()?;
    Ok(WorkspaceManifest {
        root: plain_path(&root),
        total_bytes: files.iter().map(|f| f.bytes).sum(),
        files,
        entry,
    })
}

fn safe_entry_path(root: &Path, rel: &str) -> Option<PathBuf> {
    let mut path = root.to_path_buf();
    for part in relative_path(rel).ok()?.components() {
        path.push(part);
        ensure_plain(&path).ok()?;
    }
    if path.is_file() && inside_root(&path.canonicalize().ok()?, root) {
        Some(path)
    } else {
        None
    }
}

/// Entry discovery is independent of the manifest's 400-file response cap.
/// Only shallow HTML can be a fallback, so no full second recursive walk is needed.
fn shallow_html_entries(root: &Path) -> Result<Vec<String>, String> {
    let mut pending = vec![(root.to_path_buf(), String::new(), 0)];
    let mut entries = Vec::new();
    while let Some((dir, prefix, depth)) = pending.pop() {
        for entry in fs::read_dir(dir).map_err(|e| format!("entry discovery: {e}"))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.eq_ignore_ascii_case(".git") || name.eq_ignore_ascii_case("node_modules") {
                continue;
            }
            let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            if is_link(&meta) {
                continue;
            }
            let rel = format!("{prefix}{name}");
            if meta.is_dir() && depth < 2 {
                pending.push((entry.path(), format!("{rel}/"), depth + 1));
            } else if meta.is_file() && name.to_ascii_lowercase().ends_with(".html") {
                entries.push(rel);
            }
        }
    }
    Ok(entries)
}

#[tauri::command]
pub async fn workspace_manifest(root: String) -> Result<WorkspaceManifest, String> {
    tauri::async_runtime::spawn_blocking(move || manifest_in(&builds_root()?, Path::new(&root)))
        .await
        .map_err(|e| format!("workspace manifest worker: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target/test-fixtures")
                .join(format!(
                    "workspace-{}-{nonce}-{}",
                    std::process::id(),
                    TEMP_ID.fetch_add(1, Ordering::Relaxed)
                ));
            fs::create_dir_all(path.join("builds/site")).unwrap();
            Self(path)
        }
        fn builds(&self) -> PathBuf {
            self.0.join("builds")
        }
        fn root(&self) -> PathBuf {
            self.builds().join("site")
        }
        fn write(&self, rel: &str, content: &str) -> String {
            write_in(&self.builds(), &self.root(), rel, content).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn slug_edges_are_bounded_ascii_and_nonempty() {
        for (input, expected) in [
            ("Hello, WORLD!", "hello-world"),
            ("  a___---b  ", "a-b"),
            ("", "build"),
            ("--💡é--", "build"),
            ("A1 / B2", "a1-b2"),
            ("foo---", "foo"),
        ] {
            assert_eq!(sanitize_slug(input), expected);
        }
        assert_eq!(sanitize_slug(&"a".repeat(100)), "a".repeat(48));
        assert_eq!(
            sanitize_slug(&format!("{} xyz", "a".repeat(47))),
            "a".repeat(47)
        );
    }

    #[test]
    fn relative_paths_reject_traversal_absolute_unc_drives_and_ads() {
        for bad in [
            "",
            ".",
            "..",
            "../file",
            "a/../file",
            "a\\..\\file",
            "/absolute",
            "\\absolute",
            "C:\\file",
            "C:file",
            "C:/file",
            "\\\\server\\share\\file",
            "//server/share/file",
            "\\\\?\\C:\\file",
            "a/file:stream",
            "a/.. /file",
            "a/../",
            "NUL",
            "CON.txt",
            "a/COM1.txt",
            "a/trailing.",
            "a\0b",
        ] {
            assert!(relative_path(bad).is_err(), "accepted {bad:?}");
        }
        assert_eq!(
            relative_path("./assets/site.css").unwrap(),
            PathBuf::from("assets").join("site.css")
        );
        assert_eq!(
            relative_path("assets\\site.css").unwrap(),
            PathBuf::from("assets").join("site.css")
        );
    }

    #[test]
    fn outside_root_and_root_itself_are_rejected() {
        let f = Fixture::new();
        let sibling = f.0.join("builds-other");
        fs::create_dir_all(&sibling).unwrap();
        assert!(checked_root(&sibling, &f.builds()).is_err());
        assert!(checked_root(&f.builds(), &f.builds()).is_err());
        assert!(checked_root(&f.root(), &f.builds()).is_ok());
        assert!(write_in(&f.builds(), &sibling, "oops.txt", "oops").is_err());
        assert!(manifest_in(&f.builds(), &sibling).is_err());
        assert!(!sibling.join("oops.txt").exists());
        assert!(!inside_root(
            Path::new("/builds-other/site"),
            Path::new("/builds")
        ));
    }

    #[test]
    fn entry_preference_and_fallback_depth() {
        let preferred = [
            "index.html",
            "dist/index.html",
            "build/index.html",
            "site/index.html",
            "public/index.html",
            "docs/index.html",
        ];
        for i in 0..preferred.len() {
            let mut options = preferred[i..].to_vec();
            options.push("aaa.html");
            assert_eq!(pick_entry(options), Some(preferred[i].to_string()));
        }
        assert_eq!(
            pick_entry(["z.html", "deep/a/b/no.html", "a/b/yes.HTML"]),
            Some("a/b/yes.HTML".into())
        );
        assert_eq!(pick_entry(["a/b/c/no.html", "README.md"]), None);
    }

    #[test]
    fn title_case_entities_unicode_and_empty() {
        assert_eq!(
            parse_title(
                "<html><TiTlE>  Café &amp; &lt;tag&gt; &quot;hi&quot; &#39;ok&#39; </tItLe>"
            ),
            Some("Café & <tag> \"hi\" 'ok'".into())
        );
        assert_eq!(
            parse_title("<title>One</title><title>Two</title>"),
            Some("One".into())
        );
        assert_eq!(
            parse_title("<title class='x'>Hello</title>"),
            Some("Hello".into())
        );
        assert_eq!(
            parse_title("<titleish>No</titleish><title>Yes</title>"),
            Some("Yes".into())
        );
        assert_eq!(
            parse_title("<title> &amp;lt; </title>"),
            Some("&lt;".into())
        );
        for html in [
            "<title>  </title>",
            "<html>none</html>",
            "<title>unfinished",
        ] {
            assert_eq!(parse_title(html), None);
        }
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temps() {
        let f = Fixture::new();
        let path = f.write("assets/nested/file.txt", "old");
        assert!(Path::new(&path).is_absolute());
        f.write("assets/nested/file.txt", "new 🌍");
        assert_eq!(fs::read_to_string(&path).unwrap(), "new 🌍");
        assert_eq!(
            fs::read_dir(Path::new(&path).parent().unwrap())
                .unwrap()
                .count(),
            1
        );
        assert!(write_in(&f.builds(), &f.root(), "../outside.txt", "bad").is_err());
        assert!(write_in(&f.builds(), &f.root(), "assets", "bad").is_err());
    }

    #[test]
    fn prepare_reuses_empty_then_suffixes_and_writes_ignore() {
        let f = Fixture::new();
        let empty = f.builds().join("my-site-2026-09-16");
        fs::create_dir(&empty).unwrap();
        let first = PathBuf::from(prepare_in(&f.builds(), " My SITE ", "2026-09-16").unwrap());
        assert_eq!(first, PathBuf::from(plain_path(&empty.canonicalize().unwrap())));
        assert!(!first.to_string_lossy().starts_with(r"\\?\"), "no verbatim prefix handed out");
        assert_eq!(
            fs::read_to_string(first.join(".gitignore")).unwrap(),
            "node_modules/\n"
        );
        let second = prepare_in(&f.builds(), "My SITE", "2026-09-16").unwrap();
        assert!(second.ends_with("my-site-2026-09-16-2"));
        assert!(Path::new(&second).is_absolute());
    }

    #[test]
    fn a_same_day_reask_resumes_the_newest_unfinished_build_only() {
        let f = Fixture::new();
        let date = "2026-09-16";
        assert_eq!(unfinished_in(&f.builds(), "site", date).unwrap(), None, "nothing to resume yet");
        let one = PathBuf::from(prepare_in(&f.builds(), "site", date).unwrap());
        fs::write(one.join("PRAXIS-BRIEF.md"), "brief").unwrap();
        let two = PathBuf::from(prepare_in(&f.builds(), "site", date).unwrap());
        fs::write(two.join("PRAXIS-BRIEF.md"), "brief").unwrap();
        let resumed = unfinished_in(&f.builds(), "site", date).unwrap().expect("unfinished build");
        assert!(resumed.ends_with("site-2026-09-16-2"), "newest unfinished wins: {resumed}");
        assert!(!resumed.starts_with(r"\\?\"), "plain path handed out");
        fs::write(two.join(DONE_MARKER), "done").unwrap();
        let older = unfinished_in(&f.builds(), "site", date).unwrap().expect("older unfinished");
        assert!(older.ends_with("site-2026-09-16"), "a finished build is never resumed: {older}");
        fs::write(one.join(DONE_MARKER), "done").unwrap();
        assert_eq!(unfinished_in(&f.builds(), "site", date).unwrap(), None);
        assert_eq!(unfinished_in(&f.builds(), "site", "2026-09-17").unwrap(), None, "another day starts fresh");
        let other = PathBuf::from(prepare_in(&f.builds(), "other", date).unwrap());
        assert_eq!(unfinished_in(&f.builds(), "other", date).unwrap(), None, "a folder Praxis never briefed is not a build: {}", other.display());
    }

    #[test]
    fn the_resume_window_can_reach_back_across_midnight() {
        assert_eq!(previous_date("2026-09-17").as_deref(), Some("2026-09-16"));
        assert_eq!(previous_date("2026-10-01").as_deref(), Some("2026-09-30"));
        assert_eq!(previous_date("2026-01-01").as_deref(), Some("2025-12-31"));
        assert_eq!(previous_date("2028-03-01").as_deref(), Some("2028-02-29"), "leap year");
        assert_eq!(previous_date("2027-03-01").as_deref(), Some("2027-02-28"));
        assert_eq!(previous_date("not-a-date"), None);

        let f = Fixture::new();
        let late = PathBuf::from(prepare_in(&f.builds(), "site", "2026-09-16").unwrap());
        fs::write(late.join("PRAXIS-BRIEF.md"), "brief").unwrap();
        // Just written, so it is inside the window; an empty folder has nothing touched.
        assert!(touched_within(&late, RESUME_WINDOW));
        assert!(!touched_within(&late, std::time::Duration::ZERO) || late.join("PRAXIS-BRIEF.md").exists());
        let found = unfinished_in(&f.builds(), "site", &previous_date("2026-09-17").unwrap()).unwrap();
        assert!(found.is_some_and(|d| d.ends_with("site-2026-09-16")), "yesterday's late build is findable");
    }

    #[test]
    fn prepare_stops_at_fifty_candidates() {
        let f = Fixture::new();
        for i in 1..=50 {
            let suffix = if i == 1 {
                String::new()
            } else {
                format!("-{i}")
            };
            let dir = f.builds().join(format!("full-2026-09-16{suffix}"));
            fs::create_dir(&dir).unwrap();
            fs::write(dir.join("keep"), "occupied").unwrap();
        }
        assert!(prepare_in(&f.builds(), "full", "2026-09-16").is_err());
        assert!(!f.builds().join("full-2026-09-16-51").exists());
    }

    #[test]
    fn manifest_sorted_capped_totals_and_preferred_entry_beyond_cap() {
        let f = Fixture::new();
        fs::create_dir_all(f.root().join(".git")).unwrap();
        fs::write(f.root().join(".git/ignored"), "hidden").unwrap();
        fs::create_dir_all(f.root().join("node_modules")).unwrap();
        fs::write(f.root().join("node_modules/ignored"), "hidden").unwrap();
        for i in 0..405 {
            fs::write(f.root().join(format!("a{i:03}.txt")), "abc").unwrap();
        }
        f.write("dist/index.html", "<title>Generated &amp; real</title>");
        let manifest = manifest_in(&f.builds(), &f.root()).unwrap();
        assert_eq!(manifest.files.len(), 400);
        assert_eq!(manifest.total_bytes, 1200);
        assert_eq!(manifest.files.first().unwrap().rel, "a000.txt");
        assert_eq!(manifest.files.last().unwrap().rel, "a399.txt");
        assert_eq!(manifest.entry.as_ref().unwrap().rel, "dist/index.html");
        assert_eq!(
            manifest.entry.unwrap().title.as_deref(),
            Some("Generated & real")
        );
    }

    #[test]
    fn manifest_head_is_lossy_utf8_and_character_bounded() {
        let f = Fixture::new();
        let mut bytes = b"<title>Real</title>\xff".to_vec();
        bytes.extend("🌍".repeat(1600).as_bytes());
        fs::write(f.root().join("index.html"), &bytes).unwrap();
        let manifest = manifest_in(&f.builds(), &f.root()).unwrap();
        let entry = manifest.entry.unwrap();
        assert_eq!(entry.bytes, bytes.len() as u64);
        assert_eq!(entry.head.chars().count(), 1500);
        assert!(entry.head.contains('\u{fffd}'));
        assert_eq!(entry.title.as_deref(), Some("Real"));
    }

    #[test]
    fn manifest_nested_sort_and_empty_workspace() {
        let f = Fixture::new();
        let empty = manifest_in(&f.builds(), &f.root()).unwrap();
        assert!(empty.entry.is_none());
        assert_eq!(empty.total_bytes, 0);
        f.write("a/child.txt", "child");
        f.write("a.txt", "parent");
        f.write("nested/fallback.html", "<title>Fallback</title>");
        let manifest = manifest_in(&f.builds(), &f.root()).unwrap();
        assert_eq!(
            manifest
                .files
                .iter()
                .map(|f| f.rel.as_str())
                .collect::<Vec<_>>(),
            ["a.txt", "a/child.txt", "nested/fallback.html"]
        );
        assert_eq!(manifest.entry.unwrap().rel, "nested/fallback.html");
    }

    #[test]
    #[cfg(windows)]
    fn junctions_cannot_escape_write_or_manifest_scope() {
        use std::os::windows::process::CommandExt;
        let f = Fixture::new();
        let outside = f.0.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("index.html"), "private").unwrap();
        let junction = f.root().join("dist");
        let status = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:PRAXIS_TEST_LINK -Target $env:PRAXIS_TEST_TARGET | Out-Null"])
            .env("PRAXIS_TEST_LINK", &junction)
            .env("PRAXIS_TEST_TARGET", &outside)
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "fixture junction creation failed");
        assert!(write_in(&f.builds(), &f.root(), "dist/index.html", "overwrite").is_err());
        let manifest = manifest_in(&f.builds(), &f.root()).unwrap();
        assert!(manifest.files.is_empty());
        assert!(manifest.entry.is_none());
        assert_eq!(
            fs::read_to_string(outside.join("index.html")).unwrap(),
            "private"
        );
        // Remove the junction itself before fixture cleanup, never its target.
        fs::remove_dir(&junction).unwrap();
    }

    #[test]
    fn fallback_entry_is_found_beyond_manifest_cap() {
        let f = Fixture::new();
        for i in 0..400 {
            fs::write(f.root().join(format!("a{i:03}.txt")), "abc").unwrap();
        }
        f.write("z/deep/landing.html", "<title>Beyond cap</title>");
        f.write("a/deep/too/far.html", "<title>Too deep</title>");
        let manifest = manifest_in(&f.builds(), &f.root()).unwrap();
        assert_eq!(manifest.files.len(), 400);
        assert_eq!(manifest.entry.unwrap().rel, "z/deep/landing.html");
    }
}
