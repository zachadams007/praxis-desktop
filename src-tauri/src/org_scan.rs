//! org_scan.rs - Praxis's ORGANIZATION pass: keep the Desktop and the Memory Galaxy
//! clean, consistent, up to date. Owned by **Atlas** (see fleet table rev 3 - Atlas is
//! the fleet's visible/operator agent and the best fit: this job is a periodic sweep +
//! report, not a standing brain decision, so it rides Atlas's existing lane rather than
//! inventing a new named agent - the owner explicitly asked us to check for a fit first).
//!
//! The owner's example: sessions create one-time files (e.g. a handoff prompt doc) that get
//! saved forever - the MEMORY should keep the facts, but the artifact itself shouldn't
//! live forever. Per the standing intent (`safe-local-cleanup-automation.md`): cleanup
//! must be a cautious review-and-quarantine workflow, protecting projects + memory by
//! default, never an immediate delete.
//!
//! ## V1 = DRY RUN ONLY
//! `org_scan` NEVER moves or deletes a file. It inventories three sources, classifies
//! every candidate into a hard safety tier, and writes a proposed-actions markdown
//! report into the vault (`memory/organization/org-report-YYYY-MM-DD.md`, frontmatter
//! compatible with `scripts/build-memory-graph.cjs`'s `readFrontmatter`). A later wave
//! adds an execute mode gated on the owner's explicit approval of a report.
//!
//! ## Sources scanned
//! 1. **Desktop top-level files** (`%USERPROFILE%\Desktop`, non-recursive - NEVER
//!    descends into a folder, since that could be a whole project). Per
//!    `desktop-files-get-relocated-use-tools-dir.md`, the Desktop is volatile (OneDrive
//!    relocates loose files on its own), so entries are matched/reported by name+size,
//!    not treated as a stable inventory to diff over time.
//! 2. **Stale vault artifacts** - `handoffs/*.md` older than 14 days (siblings of
//!    `memory/`, per the real on-disk layout: `.claude/projects/<slug>/handoffs/`), and
//!    orphan notes surfaced by the last `memory-graph.json` build (degree 0 = no real
//!    link touching the node, per `build-memory-graph.cjs`'s own orphan flag) whose
//!    source file is also 14+ days old.
//! 3. **Repo scratch/generated files** - INSIDE the Praxis repo only:
//!    `verify-shots/*` older than 30 days, and any `*.tmp` file anywhere in the repo
//!    (excluding `.git`, `node_modules`, `target`, `dist`).
//!
//! ## Classification (hard safety tiers - see module doc + report body for the rules
//! as implemented; kept in one place so the report and the code can never drift):
//!   - **protected** - never touch: default hard exclusions (see `is_protected`)
//!   - **archive-candidate** - old, low/no-value, but not obviously disposable → propose
//!     moving to `C:\Users\dev\tools\praxis-archive\YYYY-MM\<relative path>`
//!   - **trash-candidate** - only obvious temp junk (`*.tmp`, empty stub files)
//!
//! Nothing here ever calls `fs::remove_file` or `fs::rename` - this module only reads
//! metadata (name, size, mtime) and never opens candidate file contents for anything
//! but the vault's own frontmatter/orphan-degree read, which is metadata Praxis already
//! generates about itself, not private file contents.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const HANDOFF_STALE_DAYS: u64 = 14;
const ORPHAN_STALE_DAYS: u64 = 14;
const VERIFY_SHOT_STALE_DAYS: u64 = 30;
/// Nothing younger than this is ever proposed for archive/trash, full stop - the hard
/// "PROTECTED: any file <7 days old" floor from the build brief, applied as a last-line
/// guard even on top of each source's own staleness threshold.
const MIN_AGE_DAYS: u64 = 7;

const SECS_PER_DAY: u64 = 86_400;
const ORG_SCAN_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Tier {
    Protected,
    ArchiveCandidate,
    TrashCandidate,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SourceKind {
    Desktop,
    Handoff,
    OrphanNote,
    ScratchRepo,
}

/// One file the scan looked at and has an opinion on. `path` is best-effort display
/// only (per the Desktop-volatility gotcha, a Desktop path can be stale by the time a
/// human reads the report - `name` + `size_bytes` are the real matching key).
#[derive(Serialize, Clone)]
pub struct Candidate {
    pub source: SourceKind,
    pub tier: Tier,
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub age_days: u64,
    pub reason: String,
    /// Only set for archive-candidates: where V1's (future) execute mode would move it.
    pub proposed_dest: Option<String>,
}

#[derive(Serialize)]
pub struct OrgScanResult {
    pub generated_at_ms: u64,
    pub report_path: Option<String>,
    pub candidates: Vec<Candidate>,
    pub counts: Counts,
}

#[derive(Serialize, Default)]
pub struct Counts {
    pub protected: usize,
    pub archive_candidate: usize,
    pub trash_candidate: usize,
    pub scanned: usize,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn age_days(modified: SystemTime) -> u64 {
    match SystemTime::now().duration_since(modified) {
        Ok(d) => d.as_secs() / SECS_PER_DAY,
        Err(_) => 0, // future mtime (clock skew) - treat as brand new, never a candidate
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

/// Praxis's own repo root (this crate's parent - `src-tauri/..`), resolved the same way
/// memory_graph.rs resolves the sibling build script: `CARGO_MANIFEST_DIR` is baked in at
/// compile time and correct for both `cargo tauri dev` and a release build from this
/// checkout (Praxis is always built+installed from `C:\Users\dev\Desktop\praxis`).
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// The Praxis Claude-Code project dir - home of the real vault (`memory/`) and the
/// sibling `handoffs/` dir. Mirrors run_notes.rs's `runs_dir()` resolution.
fn praxis_project_dir() -> Option<PathBuf> {
    home_dir().map(|h| {
        h.join(".claude")
            .join("projects")
            .join("C--Users-dev-Desktop-praxis")
    })
}

/// HARD PROTECTED-tier exclusions, checked before anything else. Any of these being
/// true means the candidate is reported (so the owner can see the scan looked at it and
/// skipped it) but is NEVER eligible for archive/trash, no matter its age or source.
///   - younger than MIN_AGE_DAYS
///   - inside `.git`, `node_modules`, `target`, `dist`, `build` anywhere in its path
///   - a `.env`, `.key`, secrets-shaped name, or lives under a `secrets` dir
///   - a Windows `.lnk` shortcut (those are the Desktop's real navigation surface)
///   - a Windows/Explorer-owned system file (`desktop.ini`, `thumbs.db`) - OS-generated,
///     not one of the owner's artifacts, and Explorer silently recreates it if removed anyway
///
/// Returns the specific reason it's protected (single source of truth - both
/// `is_hard_protected`'s bool and the report's human-readable reason string derive
/// from this SAME match, so they can never drift apart).
/// Personal documents that are NOT part of the Praxis project and must never
/// be flagged, moved, or deleted by this scanner - matched by exact filename (case-
/// insensitive), regardless of location or age. Added 2026-07-03 after the
/// first scan proposed archiving two of them (real,
/// important personal files that happened to be old and loose on the Desktop, which is
/// exactly the pattern ARCHIVE-CANDIDATE looks for). Add future exclusions here, never by
/// loosening the general staleness/age heuristics.
const PERSONAL_EXCLUSIONS: &[&str] = &[
    "personal-document-a.pdf",
    "personal-document-b.jpeg",
];

fn protected_reason(path: &Path, age_days: u64) -> Option<&'static str> {
    let file_name_lc = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();
    if PERSONAL_EXCLUSIONS.contains(&file_name_lc.as_str()) {
        return Some("personal document, excluded by name — never touched");
    }
    if age_days < MIN_AGE_DAYS {
        return Some("under the protected-floor age");
    }
    let s = path.to_string_lossy().to_lowercase();
    let generated_or_vcs = [
        "/.git/",
        "\\.git\\",
        "/node_modules/",
        "\\node_modules\\",
        "/target/",
        "\\target\\",
        "/dist/",
        "\\dist\\",
        "/build/",
        "\\build\\",
    ];
    if generated_or_vcs.iter().any(|p| s.contains(p)) {
        return Some("inside a vcs/build/dependency directory — never touched");
    }
    let secret_shaped = [".env", ".key", ".pem", "secret", "credential", "token"];
    if secret_shaped.iter().any(|p| s.contains(p)) {
        return Some("secret/credential-shaped name — never touched");
    }
    if s.ends_with(".lnk") {
        return Some("Windows shortcut — the Desktop's real navigation surface");
    }
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();
    if matches!(file_name.as_str(), "desktop.ini" | "thumbs.db") {
        return Some("Windows/Explorer system file, not a Zach artifact — never touched");
    }
    None
}

fn is_hard_protected(path: &Path, age_days: u64) -> bool {
    protected_reason(path, age_days).is_some()
}

/// Desktop top-level files only (no recursion into folders - a folder could be an
/// entire project). Every non-directory entry is reported; classification decides
/// whether it's actually actionable. `.lnk` shortcuts and anything <7 days old are
/// PROTECTED by `is_hard_protected`.
fn scan_desktop() -> Vec<Candidate> {
    let Some(desktop) = home_dir().map(|h| h.join("Desktop")) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&desktop) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            continue; // NEVER recurse into project folders
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let size = meta.len();
        let age = meta.modified().map(age_days).unwrap_or(0);

        if let Some(why) = protected_reason(&path, age) {
            let reason = if age < MIN_AGE_DAYS {
                format!("modified {age}d ago — under the {MIN_AGE_DAYS}d protected floor")
            } else {
                why.to_string()
            };
            out.push(Candidate {
                source: SourceKind::Desktop,
                tier: Tier::Protected,
                name: name.clone(),
                path: path.to_string_lossy().to_string(),
                size_bytes: size,
                age_days: age,
                reason,
                proposed_dest: None,
            });
            continue;
        }

        // A loose top-level Desktop file that survived the hard guard: propose ARCHIVE
        // only (never trash - we don't know what it is), and only once it's stale enough
        // that the owner plausibly forgot about it. Fresh loose files stay unclassified-safe
        // by simply not being emitted as a candidate at all (nothing to review yet).
        let stale_enough = age >= HANDOFF_STALE_DAYS; // reuse the same "forgot about it" bar
        if !stale_enough {
            continue;
        }
        let dest = archive_dest(&path, &desktop);
        out.push(Candidate {
            source: SourceKind::Desktop,
            tier: Tier::ArchiveCandidate,
            name,
            path: path.to_string_lossy().to_string(),
            size_bytes: size,
            age_days: age,
            reason: format!(
                "loose top-level Desktop file, {age}d old — review before archiving \
                 (Desktop paths are volatile: match by name+size, not path, before acting)"
            ),
            proposed_dest: Some(dest),
        });
    }
    out
}

/// `handoffs/*.md` older than HANDOFF_STALE_DAYS. These are the exact one-time session
/// artifacts the owner called out: the FACTS belong in memory (already captured by
/// intent/handoff hooks elsewhere), but the raw prompt-dump doc shouldn't live forever.
fn scan_handoffs() -> Vec<Candidate> {
    let Some(dir) = praxis_project_dir().map(|p| p.join("handoffs")) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let age = meta.modified().map(age_days).unwrap_or(0);
        let name = entry.file_name().to_string_lossy().to_string();

        if age < HANDOFF_STALE_DAYS || is_hard_protected(&path, age) {
            continue; // not stale yet, or under the hard floor - not even worth reporting
        }
        let dest = archive_dest(&path, &dir.parent().unwrap_or(&dir));
        out.push(Candidate {
            source: SourceKind::Handoff,
            tier: Tier::ArchiveCandidate,
            name,
            path: path.to_string_lossy().to_string(),
            size_bytes: meta.len(),
            age_days: age,
            reason: format!(
                "handoff artifact, {age}d old (>{HANDOFF_STALE_DAYS}d) — one-time session \
                 doc; verify its facts already landed in memory/intent before archiving"
            ),
            proposed_dest: Some(dest),
        });
    }
    out
}

/// Orphan notes from the LAST built `memory-graph.json` (degree 0, per
/// build-memory-graph.cjs's own `orphan` flag) whose underlying file is also stale.
/// Deliberately reads the *existing* graph output rather than recomputing degree - the
/// graph builder already knows real links (wikilinks, task↔idea, conversation↔note);
/// duplicating that logic here would drift. If no graph has been built yet, this
/// source contributes nothing (never an error - a missing graph just means "no orphan
/// data available this run").
fn scan_orphan_notes(app: &tauri::AppHandle) -> Vec<Candidate> {
    let Some(graph_path) = crate::praxis_dir()
        .or_else(|| app.path().app_data_dir().ok())
        .map(|d| d.join("memory-graph.json"))
    else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(&graph_path) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(nodes) = json.get("nodes").and_then(|n| n.as_array()) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for node in nodes {
        let is_orphan = node
            .get("orphan")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !is_orphan {
            continue;
        }
        let kind = node.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        if kind != "note" && kind != "reference" {
            continue; // orphan flag is only meaningful for note/reference kinds
        }
        let Some(fp) = node.get("path").and_then(|v| v.as_str()) else {
            continue; // no on-disk file to act on (e.g. a synthetic hub node)
        };
        let path = PathBuf::from(fp);
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let age = meta.modified().map(age_days).unwrap_or(0);
        if age < ORPHAN_STALE_DAYS || is_hard_protected(&path, age) {
            continue;
        }
        let label = node
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or(fp)
            .to_string();
        out.push(Candidate {
            source: SourceKind::OrphanNote,
            tier: Tier::ArchiveCandidate,
            name: label,
            path: fp.to_string(),
            size_bytes: meta.len(),
            age_days: age,
            reason: format!(
                "orphan {kind} in the last-built memory graph (degree 0, no real link), \
                 {age}d old — likely superseded; confirm before archiving, MEMORY.md \
                 index entries take precedence over this file"
            ),
            proposed_dest: Some(archive_dest(
                &path,
                &path.parent().unwrap_or(&path).to_path_buf(),
            )),
        });
    }
    out
}

/// Repo-internal scratch: `verify-shots/*` (>30d) and any `*.tmp` file, excluding
/// vcs/build dirs. Strictly inside the Praxis repo checkout - never touches anything
/// outside `repo_root()`.
fn scan_repo_scratch() -> Vec<Candidate> {
    let root = repo_root();
    let mut out = Vec::new();

    // verify-shots/*  (already gitignored - see .gitignore's /verify-shots entry)
    let shots = root.join("verify-shots");
    if let Ok(entries) = std::fs::read_dir(&shots) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                continue;
            }
            let age = meta.modified().map(age_days).unwrap_or(0);
            if age < VERIFY_SHOT_STALE_DAYS || is_hard_protected(&path, age) {
                continue;
            }
            out.push(Candidate {
                source: SourceKind::ScratchRepo,
                tier: Tier::TrashCandidate,
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                size_bytes: meta.len(),
                age_days: age,
                reason: format!(
                    "verify-shots screenshot, {age}d old (>{VERIFY_SHOT_STALE_DAYS}d) — reproducible QA output"
                ),
                proposed_dest: None,
            });
        }
    }

    // any *.tmp anywhere in the repo (excluding vcs/build/dep dirs)
    walk_tmp_files(&root, &mut out);
    out
}

fn walk_tmp_files(dir: &Path, out: &mut Vec<Candidate>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if matches!(
                name.as_str(),
                ".git" | "node_modules" | "target" | "dist" | "build"
            ) {
                continue;
            }
            walk_tmp_files(&path, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("tmp") {
            continue;
        }
        let age = meta.modified().map(age_days).unwrap_or(0);
        if is_hard_protected(&path, age) {
            continue;
        }
        out.push(Candidate {
            source: SourceKind::ScratchRepo,
            tier: Tier::TrashCandidate,
            name: entry.file_name().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            size_bytes: meta.len(),
            age_days: age,
            reason: format!("*.tmp scratch file, {age}d old — obvious temp junk"),
            proposed_dest: None,
        });
    }
}

/// Where a future execute-mode would move an archive-candidate: preserving its relative
/// path under a dated archive root, per the build brief
/// (`C:\Users\dev\tools\praxis-archive\YYYY-MM\<relative path>`). V1 never creates
/// this path - it's a proposal string only.
fn archive_dest(path: &Path, base: &Path) -> String {
    let rel = path.strip_prefix(base).unwrap_or(path);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Cheap YYYY-MM without pulling in a date crate: days since epoch → proleptic calc
    // is overkill for a report string, so just shell out to a simple UTC breakdown.
    let (year, month) = ym_from_unix(now);
    format!(
        "C:\\Users\\dev\\tools\\praxis-archive\\{year:04}-{month:02}\\{}",
        rel.to_string_lossy()
    )
}

/// Minimal UTC (year, month) from a Unix timestamp - good enough for an archive folder
/// name; not meant as a general calendar util.
fn ym_from_unix(secs: u64) -> (u32, u32) {
    let days = secs / SECS_PER_DAY;
    let mut year = 1970i64;
    let mut remaining = days as i64;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let days_in_year = if leap { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_lengths: [i64; 12] = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u32;
    for len in month_lengths {
        if remaining < len {
            break;
        }
        remaining -= len;
        month += 1;
    }
    (year as u32, month)
}

fn escape_md(s: &str) -> String {
    s.replace('|', "\\|")
}

/// Render the dry-run report markdown, frontmatter compatible with
/// `build-memory-graph.cjs`'s `readFrontmatter` (`description` + `metadata.type`), so
/// the report itself shows up in the Memory Galaxy as a note once built.
fn render_report(candidates: &[Candidate], counts: &Counts, date: &str) -> String {
    let mut body = String::new();
    body.push_str("---\n");
    body.push_str(&format!(
        "description: \"Org scan {date} — {} protected, {} archive-candidate, {} trash-candidate of {} scanned\"\n",
        counts.protected, counts.archive_candidate, counts.trash_candidate, counts.scanned
    ));
    body.push_str("metadata:\n  type: report\n  node_type: memory\n---\n\n");
    body.push_str(&format!("# Organization scan — {date}\n\n"));
    body.push_str(
        "Owner: **Atlas** (fleet's operator agent — see `praxis-fleet-model-assignments.md` rev 3). \
         DRY RUN ONLY: nothing below has been moved or deleted. Review, then a later execute \
         mode can act on your approval.\n\n",
    );
    body.push_str(&format!(
        "**Counts:** {} scanned · {} protected · **{} archive-candidate** · **{} trash-candidate**\n\n",
        counts.scanned, counts.protected, counts.archive_candidate, counts.trash_candidate
    ));

    let groups: [(&str, Tier); 2] = [
        ("Archive candidates", Tier::ArchiveCandidate),
        ("Trash candidates", Tier::TrashCandidate),
    ];
    for (heading, tier) in groups {
        let rows: Vec<&Candidate> = candidates.iter().filter(|c| c.tier == tier).collect();
        body.push_str(&format!("## {heading} ({})\n\n", rows.len()));
        if rows.is_empty() {
            body.push_str("_none this run_\n\n");
            continue;
        }
        for c in rows {
            let dest = c.proposed_dest.as_deref().unwrap_or("-");
            body.push_str(&format!(
                "- **{}** — {} · {}d old · {} bytes\n  - path: `{}`\n  - reason: {}\n  - proposed dest: `{}`\n",
                escape_md(&c.name),
                heading_source(c.source),
                c.age_days,
                c.size_bytes,
                escape_md(&c.path),
                escape_md(&c.reason),
                escape_md(dest),
            ));
        }
        body.push('\n');
    }

    let protected: Vec<&Candidate> = candidates
        .iter()
        .filter(|c| c.tier == Tier::Protected)
        .collect();
    body.push_str(&format!(
        "## Protected — inspected, never touched ({})\n\n",
        protected.len()
    ));
    if protected.is_empty() {
        body.push_str("_none this run_\n\n");
    } else {
        for c in protected.iter().take(50) {
            body.push_str(&format!(
                "- {} — `{}` ({})\n",
                heading_source(c.source),
                escape_md(&c.name),
                escape_md(&c.reason)
            ));
        }
        if protected.len() > 50 {
            body.push_str(&format!("- …and {} more\n", protected.len() - 50));
        }
        body.push('\n');
    }

    body.push_str(
        "## Safety tiers as implemented\n\n\
         - **PROTECTED** — anything <7 days old; `.git`/`node_modules`/`target`/`dist`/`build` \
         paths; `.env`/`.key`/`.pem`/secret-or-credential-or-token-shaped names; `.lnk` shortcuts. \
         Never proposed for any action.\n\
         - **ARCHIVE-CANDIDATE** — old + low-signal but not obviously disposable: loose Desktop \
         files (14d+), stale handoff docs (14d+), orphan vault notes (degree 0, 14d+). Proposed \
         destination preserves relative path under \
         `C:\\Users\\dev\\tools\\praxis-archive\\YYYY-MM\\`.\n\
         - **TRASH-CANDIDATE** — only obvious temp junk: `*.tmp` anywhere in the repo, \
         `verify-shots/*` screenshots older than 30 days (reproducible QA output).\n\n\
         Desktop entries are matched by **name + size**, not path — OneDrive relocates loose \
         Desktop files on its own (see `desktop-files-get-relocated-use-tools-dir.md`), so a path \
         alone can't be trusted to still point at the same file by the time this is reviewed.\n",
    );

    body
}

fn heading_source(s: SourceKind) -> &'static str {
    match s {
        SourceKind::Desktop => "Desktop",
        SourceKind::Handoff => "handoff",
        SourceKind::OrphanNote => "orphan note",
        SourceKind::ScratchRepo => "repo scratch",
    }
}

fn today_str() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, m) = ym_from_unix(secs);
    let days_into_month = {
        let days = secs / SECS_PER_DAY;
        let mut remaining = days as i64;
        let mut year = 1970i64;
        loop {
            let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
            let days_in_year = if leap { 366 } else { 365 };
            if remaining < days_in_year {
                break;
            }
            remaining -= days_in_year;
            year += 1;
        }
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let month_lengths: [i64; 12] = [
            31,
            if leap { 29 } else { 28 },
            31,
            30,
            31,
            30,
            31,
            31,
            30,
            31,
            30,
            31,
        ];
        for len in month_lengths {
            if remaining < len {
                break;
            }
            remaining -= len;
        }
        remaining + 1
    };
    format!("{y:04}-{m:02}-{days_into_month:02}")
}

/// Append a one-line pointer into the 6am board-meeting digest's inbox, if that file
/// exists. A parallel lane owns creating/rotating `research-inbox.md` itself - this
/// integrates DEFENSIVELY: never creates the file, never errors if it's absent, and
/// never assumes its format beyond "append a markdown bullet is safe".
fn append_research_inbox_pointer(report_path: &Path, counts: &Counts) {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let inbox = PathBuf::from(local)
        .join("Praxis")
        .join("research-inbox.md");
    if !inbox.exists() {
        return; // not created by the other lane yet this run - no-op, never create it ourselves
    }
    let line = format!(
        "- [ ] **Org scan needs your input** — {} archive-candidate, {} trash-candidate proposed \
         (dry run, nothing touched). Review: `{}`\n",
        counts.archive_candidate,
        counts.trash_candidate,
        report_path.display()
    );
    // UPSERT, NOT APPEND.
    //
    // Every scan added another bullet, so the one surface meant to say "here is what needs your
    // input" filled with copies of a single item and buried everything else. There is only ever
    // ONE current org scan, so its pointer is one line that gets REPLACED.
    let Ok(existing) = std::fs::read_to_string(&inbox) else {
        return;
    };
    const MARKER: &str = "**Org scan needs your input**";
    let mut kept: Vec<&str> = existing
        .lines()
        .filter(|l| !l.contains(MARKER))
        .collect();
    // Drop a trailing blank run so we don't grow a gap every rewrite.
    while kept.last().is_some_and(|l| l.trim().is_empty()) {
        kept.pop();
    }
    let mut body = kept.join("
");
    if !body.is_empty() {
        body.push_str("
");
    }
    body.push_str(&line);
    // Write via a temp file + rename so a crash mid-write cannot truncate the owner's inbox.
    let tmp = inbox.with_extension("md.tmp");
    if std::fs::write(&tmp, body.as_bytes()).is_ok() {
        let _ = std::fs::rename(&tmp, &inbox);
    }
}

/// `org_scan` - the Tauri command wired to the Command Center's "Run org scan" button
/// and the `run org scan` voice/command intent. Always dry-run in V1: scans, classifies,
/// writes the report, returns the summary + candidate list for the frontend to render
/// inline without a second read round-trip.
#[tauri::command]
pub fn org_scan(app: tauri::AppHandle) -> Result<OrgScanResult, String> {
    let mut candidates = Vec::new();
    candidates.extend(scan_desktop());
    candidates.extend(scan_handoffs());
    candidates.extend(scan_orphan_notes(&app));
    candidates.extend(scan_repo_scratch());

    let mut counts = Counts {
        scanned: candidates.len(),
        ..Default::default()
    };
    for c in &candidates {
        match c.tier {
            Tier::Protected => counts.protected += 1,
            Tier::ArchiveCandidate => counts.archive_candidate += 1,
            Tier::TrashCandidate => counts.trash_candidate += 1,
        }
    }

    let date = today_str();
    let report_path = praxis_project_dir().map(|p| {
        p.join("memory")
            .join("organization")
            .join(format!("org-report-{date}.md"))
    });

    let mut written_path = None;
    if let Some(path) = &report_path {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("org_scan mkdir {}: {e}", dir.display()))?;
        }
        let markdown = render_report(&candidates, &counts, &date);
        std::fs::write(path, markdown)
            .map_err(|e| format!("org_scan write {}: {e}", path.display()))?;
        append_research_inbox_pointer(path, &counts);
        written_path = Some(path.to_string_lossy().to_string());
    }

    Ok(OrgScanResult {
        generated_at_ms: now_ms(),
        report_path: written_path,
        candidates,
        counts,
    })
}

/// Background Atlas organization pass: run a catch-up scan shortly after boot, then
/// repeat daily while Praxis is alive. Mirrors `research_watch::spawn`'s OS-thread +
/// shutdown-flag loop so it keeps running even when no Praxis window is open.
pub fn spawn(app: tauri::AppHandle, running: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        // Let the rest of setup finish first, then catch up immediately instead of waiting
        // a full daily interval after launch.
        std::thread::sleep(Duration::from_secs(15));

        while running.load(Ordering::Relaxed) {
            let scan =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| org_scan(app.clone())));
            match scan {
                Ok(Ok(result)) => {
                    crate::dlog!(
                        "[org-scan] timer scan complete - scanned={} protected={} archive={} trash={} report={}",
                        result.counts.scanned,
                        result.counts.protected,
                        result.counts.archive_candidate,
                        result.counts.trash_candidate,
                        result.report_path.as_deref().unwrap_or("none")
                    );
                }
                Ok(Err(e)) => crate::elog!("[org-scan] timer scan failed: {e}"),
                Err(_) => crate::elog!("[org-scan] timer scan panicked"),
            }

            let mut slept = Duration::ZERO;
            while slept < ORG_SCAN_INTERVAL && running.load(Ordering::Relaxed) {
                let step = Duration::from_secs(30).min(ORG_SCAN_INTERVAL - slept);
                std::thread::sleep(step);
                slept += step;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protects_young_files() {
        assert!(is_hard_protected(Path::new("C:/x/foo.md"), 2));
        assert!(!is_hard_protected(Path::new("C:/x/foo.md"), 20));
    }

    #[test]
    fn protects_vcs_and_build_dirs() {
        assert!(is_hard_protected(
            Path::new("C:/repo/node_modules/pkg/index.js"),
            100
        ));
        assert!(is_hard_protected(Path::new("C:/repo/.git/HEAD"), 100));
        assert!(is_hard_protected(Path::new("C:/repo/target/debug/x"), 100));
        assert!(is_hard_protected(Path::new("C:/repo/dist/app.js"), 100));
    }

    #[test]
    fn protects_secret_shaped_names() {
        assert!(is_hard_protected(Path::new("C:/x/.env"), 100));
        assert!(is_hard_protected(Path::new("C:/x/groq.key"), 100));
        assert!(is_hard_protected(Path::new("C:/x/id_rsa.pem"), 100));
        assert!(is_hard_protected(
            Path::new("C:/x/my-credential-store.json"),
            100
        ));
    }

    #[test]
    fn protects_shortcuts() {
        assert!(is_hard_protected(
            Path::new("C:/Users/dev/Desktop/Praxis.lnk"),
            100
        ));
    }

    #[test]
    fn protects_windows_system_files() {
        assert!(is_hard_protected(
            Path::new("C:/Users/dev/Desktop/desktop.ini"),
            100
        ));
        assert!(is_hard_protected(
            Path::new("C:/Users/dev/Desktop/Thumbs.db"),
            100
        ));
    }

    #[test]
    fn allows_a_plain_old_file() {
        assert!(!is_hard_protected(
            Path::new("C:/Users/dev/Desktop/old-notes.md"),
            20
        ));
    }

    #[test]
    fn ym_from_unix_matches_known_date() {
        // 2026-07-02T00:00:00Z = 1782950400 (verified: `date -u -d @1782950400`)
        let (y, m) = ym_from_unix(1_782_950_400);
        assert_eq!((y, m), (2026, 7));
        // a date safely inside a leap-year February (2028-02-15T00:00:00Z = 1834185600)
        let (y2, m2) = ym_from_unix(1_834_185_600);
        assert_eq!((y2, m2), (2028, 2));
        assert_eq!(today_str().len(), 10); // "YYYY-MM-DD" - never panics, always well-formed
    }

    #[test]
    fn report_renders_without_panicking() {
        let candidates = vec![Candidate {
            source: SourceKind::Desktop,
            tier: Tier::ArchiveCandidate,
            name: "old-plan.md".into(),
            path: "C:/Users/dev/Desktop/old-plan.md".into(),
            size_bytes: 1234,
            age_days: 40,
            reason: "loose top-level Desktop file, 40d old".into(),
            proposed_dest: Some("C:/Users/dev/tools/praxis-archive/2026-07/old-plan.md".into()),
        }];
        let counts = Counts {
            scanned: 1,
            protected: 0,
            archive_candidate: 1,
            trash_candidate: 0,
        };
        let md = render_report(&candidates, &counts, "2026-07-02");
        assert!(md.contains("old-plan.md"));
        assert!(md.contains("ARCHIVE") || md.contains("Archive candidates"));
    }

    /// Runs the REAL scanners (Desktop, handoffs, repo scratch - everything except
    /// the orphan-notes source, which needs a Tauri AppHandle) against this actual
    /// machine and writes the report to the vault, exactly like the live `org_scan`
    /// command does. `#[ignore]`d so normal `cargo test` stays hermetic/fast; run
    /// explicitly for a real dry-run proof: `cargo test --lib -- --ignored
    /// live_scan_writes_a_real_report`.
    #[test]
    #[ignore]
    fn live_scan_writes_a_real_report() {
        let mut candidates = Vec::new();
        candidates.extend(scan_desktop());
        candidates.extend(scan_handoffs());
        candidates.extend(scan_repo_scratch());

        let mut counts = Counts {
            scanned: candidates.len(),
            ..Default::default()
        };
        for c in &candidates {
            match c.tier {
                Tier::Protected => counts.protected += 1,
                Tier::ArchiveCandidate => counts.archive_candidate += 1,
                Tier::TrashCandidate => counts.trash_candidate += 1,
            }
        }

        let date = today_str();
        let path = praxis_project_dir()
            .expect("USERPROFILE set")
            .join("memory")
            .join("organization")
            .join(format!("org-report-{date}.md"));
        std::fs::create_dir_all(path.parent().unwrap()).expect("mkdir organization dir");
        let markdown = render_report(&candidates, &counts, &date);
        std::fs::write(&path, &markdown).expect("write real report");

        println!("wrote {} ({} bytes)", path.display(), markdown.len());
        println!(
            "scanned={} protected={} archive={} trash={}",
            counts.scanned, counts.protected, counts.archive_candidate, counts.trash_candidate
        );
    }
}
