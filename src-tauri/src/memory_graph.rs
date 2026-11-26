//! memory_graph.rs - keeps the Memory Galaxy's graph fresh at runtime.
//!
//! `scripts/build-memory-graph.cjs` used to be manual-only: nobody ran it, so
//! `public/memory-graph.json` (baked into `dist` at BUILD time) went stale - 9 days stale
//! when this was found. Worse, the packaged app can't just re-run the script and overwrite
//! `public/memory-graph.json`, because a packaged Tauri app serves the bundled `dist` as a
//! read-only asset bundle - a runtime write there is invisible until the next `tauri build`.
//!
//! So the flow is now:
//!   1. `refresh_memory_graph` (Tauri command) spawns `node scripts/build-memory-graph.cjs`
//!      async, debounced, and points its OUT arg at `%LOCALAPPDATA%\Praxis\memory-graph.json`
//!      (a real writable runtime location - same app-data home as skills.jsonl/runs.jsonl).
//!   2. `read_memory_graph` (Tauri command) reads that file back as JSON for the frontend.
//!   3. The knowledge window (`src/knowledge/App.tsx`) calls `refresh_memory_graph` on open,
//!      then polls it every ~5 min while open, and reads the result via `read_memory_graph`
//!      instead of `fetch("memory-graph.json")` - so freshness no longer depends on a rebuild.
//!
//! The script itself still takes an explicit OUT path override (see build-memory-graph.cjs's
//! 4th positional arg) - added alongside this module - so both the manual
//! `npm run graph:build` (writes `public/memory-graph.json`, handy for `shot-galaxy.cjs` /
//! screenshots) and this runtime path (writes to app-data) share one code path.
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::Manager;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::SystemTime;

#[derive(Debug, Clone, serde::Serialize)]
pub struct MemoryHit {
    pub path: String,
    pub label: String,
    pub project: String,
    pub kind: String,
    pub memory_type: Option<String>,
    pub description: Option<String>,
    pub excerpt: String,
    pub galaxy_id: Option<String>,
    pub score: f64,
}

const MAX_RECALL_FILES: usize = 4000;
const MAX_RECALL_BYTES: u64 = 200 * 1024;

/// IO and ranking stay off the webview thread. Arguments use Tauri's default
/// camelCase keys from JS (`includeProfile`), like every other Praxis command -
/// a snake_case-only command silently ignores the camelCase key and returns no
/// profile at all.
#[tauri::command]
pub async fn memory_recall(
    query: String,
    limit: Option<usize>,
    include_profile: Option<bool>,
) -> Result<Vec<MemoryHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = PathBuf::from(std::env::var_os("USERPROFILE").ok_or("USERPROFILE is not set")?);
        let graph = crate::praxis_dir().map(|p| p.join("memory-graph.json"));
        let notes = cached_notes(&home)?;
        Ok(rank_notes(
            &notes,
            &cached_galaxy_ids(graph.as_deref()),
            &query,
            limit.unwrap_or(8).clamp(1, 25),
            include_profile == Some(true),
            SystemTime::now(),
        ))
    })
    .await
    .map_err(|e| format!("memory recall worker: {e}"))?
}

const RECALL_STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of",
    "on", "or", "that", "the", "this", "to", "was", "were", "with", "you", "your", "me", "my",
    "about", "have", "has", "do", "does",
];

fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| s.len() >= 2)
        .map(str::to_ascii_lowercase)
        .filter(|s| !RECALL_STOPWORDS.contains(&s.as_str()))
        .collect()
}

fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn secret_line(line: &str) -> bool {
    const KEYS: &[&str] = &[
        "apikey",
        "api_key",
        "api-key",
        "secret",
        "password",
        "passwd",
        "token",
        "bearer",
        "authorization",
        "cookie",
        "privatekey",
        "private_key",
        "private-key",
    ];
    let lower = line.to_ascii_lowercase();
    KEYS.iter().any(|key| {
        lower.match_indices(key).any(|(start, _)| {
            let end = start + key.len();
            (start == 0 || !lower[..start].chars().next_back().is_some_and(word_char))
                && !lower[end..].chars().next().is_some_and(word_char)
                && lower[end..].trim_start().starts_with([':', '='])
        })
    })
}

fn secret_run_len(s: &str) -> usize {
    fn run(s: &str, accepts: fn(u8) -> bool) -> usize {
        s.bytes().take_while(|b| accepts(*b)).count()
    }
    fn url(b: u8) -> bool {
        b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
    }
    fn alnum(b: u8) -> bool {
        b.is_ascii_alphanumeric()
    }
    let mut found = 0;
    for (prefix, min, accepts) in [
        ("sk-", 16, url as fn(u8) -> bool),
        ("ghp_", 20, alnum),
        ("gho_", 20, alnum),
        (
            "xoxa-",
            10,
            (|b: u8| b.is_ascii_alphanumeric() || b == b'-') as fn(u8) -> bool,
        ),
        ("xoxb-", 10, |b: u8| b.is_ascii_alphanumeric() || b == b'-'),
        ("xoxp-", 10, |b: u8| b.is_ascii_alphanumeric() || b == b'-'),
        ("xoxr-", 10, |b: u8| b.is_ascii_alphanumeric() || b == b'-'),
        ("AKIA", 16, |b: u8| {
            b.is_ascii_uppercase() || b.is_ascii_digit()
        }),
    ] {
        if let Some(tail) = s.strip_prefix(prefix) {
            let n = run(tail, accepts);
            if n >= min {
                found = found.max(prefix.len() + n);
            }
        }
    }
    if let Some(tail) = s.strip_prefix("eyJ") {
        let first = run(tail, url);
        if first >= 20 && tail.as_bytes().get(first) == Some(&b'.') {
            let second = run(&tail[first + 1..], url);
            if second >= 10 {
                let mut end = 3 + first + 1 + second;
                if s.as_bytes().get(end) == Some(&b'.') {
                    end += 1 + run(&s[end + 1..], url);
                }
                found = found.max(end);
            }
        }
    }
    let generic = run(s, |b| url(b) || b == b'+' || b == b'/' || b == b'=');
    if generic >= 40 {
        found = found.max(generic);
    }
    found
}

fn redact_secrets(text: &str) -> String {
    text.lines()
        .map(|line| {
            if secret_line(line) {
                return "[redacted]".to_string();
            }
            let mut out = String::new();
            let mut i = 0;
            while i < line.len() {
                let n = secret_run_len(&line[i..]);
                if n > 0 {
                    out.push_str("[redacted]");
                    i += n;
                } else {
                    let c = line[i..].chars().next().unwrap();
                    out.push(c);
                    i += c.len_utf8();
                }
            }
            out
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Default)]
struct RecallFrontmatter {
    name: Option<String>,
    description: Option<String>,
    memory_type: Option<String>,
}

fn scalar(value: &str) -> String {
    let value = value.trim();
    if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
        serde_json::from_str::<String>(value).unwrap_or_else(|_| value[1..value.len() - 1].into())
    } else if value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2 {
        value[1..value.len() - 1].replace("''", "'")
    } else {
        value.split(" #").next().unwrap_or("").trim().to_string()
    }
}

/// Small frontmatter reader for the vault's scalar and indented metadata fields;
/// also supports folded/literal descriptions without adding a YAML dependency.
fn recall_frontmatter(text: &str) -> (RecallFrontmatter, &str) {
    let text = text.trim_start_matches('\u{feff}');
    let mut lines = text.split_inclusive('\n');
    let Some(first) = lines.next() else {
        return (RecallFrontmatter::default(), text);
    };
    if first.trim() != "---" {
        return (RecallFrontmatter::default(), text);
    }
    let mut offset = first.len();
    let mut end = None;
    for line in lines {
        if line.trim() == "---" {
            end = Some((offset, offset + line.len()));
            break;
        }
        offset += line.len();
    }
    let Some((fm_end, body_start)) = end else {
        return (RecallFrontmatter::default(), text);
    };
    let lines: Vec<&str> = text[first.len()..fm_end].lines().collect();
    let mut fm = RecallFrontmatter::default();
    let mut metadata = false;
    let mut metadata_indent = None;
    let mut nested_type = None;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let indent = line.len() - line.trim_start().len();
        let Some((key, raw)) = line.trim().split_once(':') else {
            i += 1;
            continue;
        };
        if indent == 0 {
            metadata = key == "metadata";
            metadata_indent = None;
            if metadata {
                if let Some(mapping) = raw
                    .trim()
                    .strip_prefix('{')
                    .and_then(|s| s.strip_suffix('}'))
                {
                    for field in mapping.split(',') {
                        if let Some(("type", value)) =
                            field.trim().split_once(':').map(|(k, v)| (k.trim(), v))
                        {
                            let value = scalar(value).to_ascii_lowercase();
                            if !value.is_empty() {
                                nested_type = Some(value);
                            }
                        }
                    }
                }
            }
        } else if metadata && metadata_indent.is_none() {
            metadata_indent = Some(indent);
        }
        let mut value = scalar(raw);
        if raw.trim().starts_with(['|', '>']) {
            let mut block = Vec::new();
            while i + 1 < lines.len()
                && (lines[i + 1].trim().is_empty()
                    || lines[i + 1].len() - lines[i + 1].trim_start().len() > indent)
            {
                i += 1;
                block.push(lines[i].trim());
            }
            // Preserve boundaries until redaction, including for folded YAML.
            value = block.join("\n");
        }
        if !value.is_empty() {
            match (indent, key) {
                (0, "name") => fm.name = Some(value),
                (0, "description") => fm.description = Some(value),
                (0, "type") => fm.memory_type = Some(value.to_ascii_lowercase()),
                (_, "type") if metadata && metadata_indent == Some(indent) => {
                    nested_type = Some(value.to_ascii_lowercase())
                }
                _ => {}
            }
        }
        i += 1;
    }
    fm.memory_type = nested_type.or(fm.memory_type);
    (fm, &text[body_start..])
}

fn recall_kind(path: &Path, intent: bool, memory_type: Option<&str>) -> &'static str {
    if path
        .file_name()
        .is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case("MEMORY.md"))
    {
        return "index";
    }
    let parts: Vec<String> = path
        .iter()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .collect();
    if intent
        || parts
            .windows(2)
            .any(|p| p[0] == "intent" && p[1] == "topics")
    {
        return "idea";
    }
    if parts.iter().any(|s| matches!(s.as_str(), "tasks" | "todo")) {
        return "task";
    }
    if parts
        .iter()
        .any(|s| matches!(s.as_str(), "conversations" | "agent-chats"))
    {
        return "conversation";
    }
    if memory_type == Some("reference") {
        "reference"
    } else {
        "note"
    }
}

fn excluded_memory_path(path: &Path) -> bool {
    path.iter().any(|p| {
        matches!(
            p.to_string_lossy().to_ascii_lowercase().as_str(),
            "archive" | "sessions" | "secrets" | ".git" | "node_modules"
        )
    })
}

/// Skip junctions too: following them can escape the source tree or create cycles.
fn recall_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

fn path_key(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches("//?/")
        .to_lowercase()
}

fn galaxy_ids(graph: Option<&Path>) -> HashMap<String, String> {
    let parsed = graph
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
    parsed
        .as_ref()
        .and_then(|v| v.get("nodes"))
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|node| {
            Some((
                path_key(node.get("path")?.as_str()?),
                node.get("id")?.as_str()?.to_owned(),
            ))
        })
        .collect()
}

struct RecallDoc {
    hit: MemoryHit,
    label: Vec<String>,
    description: Vec<String>,
    /// Body tokens that matter to ranking (query + identity + overview terms) - not
    /// every word; `body_len` keeps the true length for BM25 normalization.
    body: Vec<String>,
    body_len: usize,
    modified: SystemTime,
    age_days: f64,
    avg_body_len: f64,
    idf: HashMap<String, f64>,
}

/// Terms that say WHO the user is (about-me recall ranks profile notes by these).
const IDENTITY_TERMS: &[&str] = &[
    "zach", "education", "university", "queen", "queens", "applied", "math", "mathematics",
    "degree", "student", "studies", "studying", "award", "awards", "scholarship", "builder",
    "builds", "engineering", "engineer", "ownership", "projects", "values", "interests",
    "career", "goals", "income", "freelance", "business",
];

/// Terms that say WHAT a project is (about-me recall picks one overview per project).
const OVERVIEW_TERMS: &[&str] = &[
    "vision", "north", "star", "product", "platform", "mission", "overview", "roadmap",
    "orchestrator", "app", "system", "tool", "site", "website", "research", "signal",
    "signals", "trading", "desktop", "brain", "agents", "fleet", "print", "store",
];

/// Tokens of `text` that are in `wanted`, plus the total token count, without
/// allocating a String per word. Ranking 13 MB of notes by materializing every token
/// and scanning it once per query term took 72-83 s per recall in a debug build.
fn tokenize_counted(text: &str, wanted: &HashSet<String>) -> (Vec<String>, usize) {
    let mut kept = Vec::new();
    let mut total = 0usize;
    let mut buf = String::new();
    for raw in text.split(|c: char| !c.is_ascii_alphanumeric()) {
        if raw.len() < 2 {
            continue;
        }
        buf.clear();
        buf.extend(raw.chars().map(|c| c.to_ascii_lowercase()));
        if RECALL_STOPWORDS.contains(&buf.as_str()) {
            continue;
        }
        total += 1;
        if wanted.contains(buf.as_str()) {
            kept.push(buf.clone());
        }
    }
    (kept, total)
}

/// BM25F-style weighted term frequency, body length normalization and corpus IDF.
/// Time/corpus statistics are inputs on doc, so scoring is deterministic and pure.
fn score_doc(query_tokens: &[String], doc: &RecallDoc) -> f64 {
    let mut seen = HashSet::new();
    let norm = 1.2 * (0.25 + 0.75 * doc.body_len as f64 / doc.avg_body_len.max(1.0));
    let mut score = 0.0;
    for term in query_tokens {
        if !seen.insert(term) {
            continue;
        }
        let tf = 3.0 * doc.label.iter().filter(|s| *s == term).count() as f64
            + 2.0 * doc.description.iter().filter(|s| *s == term).count() as f64
            + doc.body.iter().filter(|s| *s == term).count() as f64;
        if tf > 0.0 {
            score += doc.idf.get(term).copied().unwrap_or(1.0) * tf * 2.2 / (tf + norm);
        }
    }
    score * (1.0 + 0.1 * (1.0 - doc.age_days / 14.0).clamp(0.0, 1.0))
}

fn collect_recall_paths(root: &Path, project: &str, intent: bool, out: &mut Vec<RecallPath>) {
    let Ok(root_meta) = fs::symlink_metadata(root) else {
        return;
    };
    let mut stack = vec![(root.to_path_buf(), root_meta)];
    while let Some((path, meta)) = stack.pop() {
        if out.len() >= MAX_RECALL_FILES {
            break;
        }
        if excluded_memory_path(&path) || recall_link(&meta) {
            continue;
        }
        if meta.is_dir() {
            if let Ok(entries) = fs::read_dir(&path) {
                // A directory entry's metadata comes from the listing itself on Windows (no
                // per-file open, no symlink traversal): listing 1,770 notes one
                // `symlink_metadata` call at a time took 3.6 s.
                let mut children: Vec<(PathBuf, fs::Metadata)> = entries
                    .filter_map(Result::ok)
                    .filter_map(|e| Some((e.path(), e.metadata().ok()?)))
                    .collect();
                children.sort_by(|a, b| a.0.cmp(&b.0));
                stack.extend(children.into_iter().rev());
            }
        } else if meta.is_file()
            && meta.len() <= MAX_RECALL_BYTES
            && path
                .extension()
                .is_some_and(|s| s.eq_ignore_ascii_case("md"))
        {
            out.push(RecallPath {
                modified: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                len: meta.len(),
                path,
                project: project.into(),
                intent,
            });
        }
    }
}

/// A canonicalized Windows path without the `\\?\` verbatim prefix, so the path a
/// hit carries is the one the owner would type or click (and the one the galaxy lists).
fn display_path(path: &Path) -> String {
    crate::workspace::plain_path(path)
}

/// Notes that must never feed an "about me" recall: accounts, billing, credentials,
/// contact/admin details, money, health.
fn agent_run_note(hit: &MemoryHit) -> bool {
    // Praxis's own run logs (`memory/runs/run-*.md`, written by write_run_note) record what
    // agents did, not who the owner is. The second live recall of 2026-09-16 put two "Agent run -
    // incomplete" notes from stopped test runs into a personal-site brief.
    let p = hit.path.replace('\\', "/").to_ascii_lowercase();
    p.contains("/memory/runs/")
}

fn sensitive_note(hit: &MemoryHit) -> bool {
    const WORDS: &[&str] = &[
        "account", "accounts", "billing", "subscription", "subscriptions", "credential",
        "credentials", "secret", "secrets", "password", "passwords", "token", "tokens",
        "login", "logins", "email", "emails", "admin", "payment", "payments", "invoice",
        "bank", "tax", "taxes", "medical", "health", "address", "phone", "passport",
    ];
    let hay = format!(
        "{} {} {}",
        Path::new(&hit.path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        hit.label,
        hit.description.as_deref().unwrap_or("")
    );
    tokenize(&hay).iter().any(|t| WORDS.contains(&t.as_str()))
}

/// How much a note says about WHO the user is - education, work, values, projects -
/// so "about me" recall leads with identity instead of whatever was edited last.
fn identity_score(doc: &RecallDoc) -> f64 {
    term_weight(doc, IDENTITY_TERMS)
}

fn term_weight(doc: &RecallDoc, terms: &[&str]) -> f64 {
    let count = |tokens: &[String]| tokens.iter().filter(|t| terms.contains(&t.as_str())).count() as f64;
    3.0 * count(&doc.label) + 2.0 * count(&doc.description) + count(&doc.body).min(12.0)
}

/// One overview per REAL project - the note that best says what that project IS -
/// so an about-me recall knows what the owner builds, not just what he edited last.
/// Lane/worktree memory dirs (`*-lanes-*`) duplicate their parent project and are
/// skipped; bigger projects (more notes) come first.
fn project_overviews(docs: &[RecallDoc], max: usize) -> Vec<&RecallDoc> {
    let mut by_project: HashMap<&str, Vec<&RecallDoc>> = HashMap::new();
    for d in docs {
        let project = d.hit.project.as_str();
        if project.is_empty() || project.contains("-lanes") || sensitive_note(&d.hit) || agent_run_note(&d.hit) {
            continue;
        }
        by_project.entry(project).or_default().push(d);
    }
    let mut best: Vec<(usize, f64, &RecallDoc)> = by_project
        .into_values()
        .filter_map(|notes| {
            let size = notes.len();
            notes
                .into_iter()
                .filter(|d| d.hit.kind != "index")
                .map(|d| (term_weight(d, OVERVIEW_TERMS), d))
                .filter(|(w, _)| *w > 0.0)
                .max_by(|a, b| a.0.total_cmp(&b.0).then_with(|| b.1.hit.path.cmp(&a.1.hit.path)))
                .map(|(w, d)| (size, w, d))
        })
        .collect();
    best.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.total_cmp(&a.1)).then_with(|| a.2.hit.path.cmp(&b.2.hit.path)));
    best.into_iter().take(max).map(|(_, _, d)| d).collect()
}

fn select_recall_hits(
    mut docs: Vec<RecallDoc>,
    limit: usize,
    include_profile: bool,
) -> Vec<MemoryHit> {
    docs.sort_by(|a, b| {
        b.hit
            .score
            .total_cmp(&a.hit.score)
            .then_with(|| b.modified.cmp(&a.modified))
            .then_with(|| a.hit.path.cmp(&b.hit.path))
    });
    let profiles: Vec<&RecallDoc> = if include_profile {
        let mut p: Vec<&RecallDoc> = docs
            .iter()
            .filter(|d| d.hit.memory_type.as_deref() == Some("user") && !sensitive_note(&d.hit))
            .collect();
        // Stable sort keeps the score → recency → path order for ties.
        p.sort_by(|a, b| identity_score(b).total_cmp(&identity_score(a)));
        p.into_iter().take(4).collect()
    } else {
        Vec::new()
    };
    let overviews: Vec<&RecallDoc> = if include_profile { project_overviews(&docs, 5) } else { Vec::new() };
    let mut seen = HashSet::new();
    let mut hits = Vec::new();
    for d in profiles.into_iter().chain(overviews) {
        if seen.insert(path_key(&d.hit.path)) {
            hits.push(d.hit.clone());
        }
    }
    // About-me recall already leads with identity and project overviews, so its
    // keyword tail keeps only strong matches: the first live run padded it with a
    // chatbot task and a desktop-reorg gotcha because "website" and "projects" appear
    // everywhere.
    let top = docs.first().map(|d| d.hit.score).unwrap_or(0.0);
    let floor = if include_profile { top * 0.6 } else { 0.0 };
    for d in docs
        .iter()
        .filter(|d| d.hit.score > 0.0 && d.hit.score >= floor)
        // An about-me recall is public-facing: no account/billing/contact notes.
        .filter(|d| !include_profile || (!sensitive_note(&d.hit) && !agent_run_note(&d.hit)))
        .take(limit.clamp(1, 25))
    {
        if seen.insert(path_key(&d.hit.path)) {
            hits.push(d.hit.clone());
        }
    }
    hits
}

/// A note prepared for recall: everything about it that does not depend on the query.
///
/// WHY NOTES ARE CACHED (measured 2026-09-17): opening the ~1,770 notes cost about 22 ms a
/// file on this machine, so one `memory_recall` took 52 s in the installed app. Atlas could
/// not "share Praxis's memory" at conversational speed and its context card timed out empty.
/// Ranking is fast; opening files is not. `memory_recall` keeps prepared notes in memory,
/// re-reads only files whose size or modified time changed, and refreshes in the background.
pub(crate) struct PreparedNote {
    source: PathBuf,
    stamp: (SystemTime, u64),
    hit: MemoryHit,
    label: Vec<String>,
    description: Vec<String>,
    body: String,
    modified: SystemTime,
}

/// A note file as the directory listing reports it.
struct RecallPath {
    path: PathBuf,
    project: String,
    intent: bool,
    modified: SystemTime,
    len: u64,
}

fn list_recall_paths(home: &Path) -> Result<Vec<RecallPath>, String> {
    let home = home
        .canonicalize()
        .map_err(|e| format!("memory home: {e}"))?;
    let mut paths = Vec::new();
    if let Ok(entries) = fs::read_dir(home.join(".claude/projects")) {
        let mut projects: Vec<_> = entries.filter_map(Result::ok).map(|e| e.path()).collect();
        projects.sort();
        for p in projects {
            if fs::symlink_metadata(&p)
                .map(|m| m.is_dir() && !recall_link(&m))
                .unwrap_or(false)
            {
                collect_recall_paths(
                    &p.join("memory"),
                    &p.file_name().unwrap().to_string_lossy(),
                    false,
                    &mut paths,
                );
            }
        }
    }
    // Shared intent has no project directory; expose that explicitly as an empty project.
    collect_recall_paths(
        &home.join(".claude/memory/intent/topics"),
        "",
        true,
        &mut paths,
    );
    Ok(paths)
}

fn prepare_note(p: &RecallPath) -> Option<PreparedNote> {
    let file = fs::File::open(&p.path).ok()?;
    let meta = file.metadata().ok()?;
    if meta.len() > MAX_RECALL_BYTES {
        return None;
    }
    let mut text = String::new();
    if file
        .take(MAX_RECALL_BYTES + 1)
        .read_to_string(&mut text)
        .is_err()
        || text.len() as u64 > MAX_RECALL_BYTES
    {
        return None;
    }
    let path = &p.path;
    let (fm, body) = recall_frontmatter(&text);
    let label = fm.name.unwrap_or_else(|| {
        body.lines()
            .find_map(|l| l.trim().strip_prefix("# ").map(|s| s.trim().to_string()))
            .unwrap_or_else(|| {
                path.file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            })
    });
    let description = fm.description.map(|s| redact_secrets(&s));
    // Only what LEAVES recall needs redacting: the excerpt is cut from the first few KB,
    // so redact that head instead of every byte of every note. Scanning whole bodies made
    // one recall take 72 s in a debug build.
    let mut head = String::new();
    for line in body.lines() {
        if head.len() > 4000 {
            break;
        }
        head.push_str(line);
        head.push('\n');
    }
    let excerpt: String = redact_secrets(&head)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(1200)
        .collect();
    let hit = MemoryHit {
        galaxy_id: None,
        path: display_path(path),
        label: label.clone(),
        project: p.project.clone(),
        kind: recall_kind(path, p.intent, fm.memory_type.as_deref()).into(),
        memory_type: fm.memory_type,
        description: description.clone(),
        excerpt,
        score: 0.0,
    };
    Some(PreparedNote {
        source: p.path.clone(),
        stamp: (p.modified, p.len),
        label: tokenize(&label),
        description: tokenize(description.as_deref().unwrap_or("")),
        body: body.to_string(),
        modified: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        hit,
    })
}

/// Read and prepare every note, reusing each unchanged one from `previous` (same path, size
/// and modified time). Reads run on a few threads: the cost is per-file latency, not
/// bandwidth, so they overlap well.
fn load_notes(home: &Path, previous: &[Arc<PreparedNote>]) -> Result<Vec<Arc<PreparedNote>>, String> {
    let paths = list_recall_paths(home)?;
    let known: HashMap<&Path, &Arc<PreparedNote>> =
        previous.iter().map(|n| (n.source.as_path(), n)).collect();
    let mut slots: Vec<Option<Arc<PreparedNote>>> = paths
        .iter()
        .map(|p| {
            known
                .get(p.path.as_path())
                .filter(|n| n.stamp == (p.modified, p.len))
                .map(|n| Arc::clone(n))
        })
        .collect();
    let missing: Vec<usize> = (0..paths.len()).filter(|&i| slots[i].is_none()).collect();
    if !missing.is_empty() {
        let workers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(1, 8);
        let chunk = missing.len().div_ceil(workers);
        let paths = &paths;
        let loaded: Vec<(usize, Option<PreparedNote>)> = std::thread::scope(|s| {
            let workers: Vec<_> = missing
                .chunks(chunk)
                .map(|idxs| {
                    s.spawn(move || {
                        idxs.iter()
                            .map(|&i| (i, prepare_note(&paths[i])))
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            workers
                .into_iter()
                .flat_map(|w| w.join().unwrap_or_default())
                .collect()
        });
        for (i, note) in loaded {
            slots[i] = note.map(Arc::new);
        }
    }
    Ok(slots.into_iter().flatten().collect())
}

/// Rank prepared notes against a query. Pure CPU: no file is opened here.
fn rank_notes(
    notes: &[Arc<PreparedNote>],
    ids: &HashMap<String, String>,
    query: &str,
    limit: usize,
    include_profile: bool,
    now: SystemTime,
) -> Vec<MemoryHit> {
    let query = tokenize(query);
    let wanted: HashSet<String> = query
        .iter()
        .cloned()
        .chain(IDENTITY_TERMS.iter().map(|t| t.to_string()))
        .chain(OVERVIEW_TERMS.iter().map(|t| t.to_string()))
        .collect();
    let mut docs = Vec::with_capacity(notes.len());
    for note in notes {
        let age_days = now
            .duration_since(note.modified)
            .unwrap_or_default()
            .as_secs_f64()
            / 86400.0;
        let mut hit = note.hit.clone();
        hit.galaxy_id = ids.get(&path_key(&hit.path)).cloned();
        let (body_tokens, body_len) = tokenize_counted(&note.body, &wanted);
        docs.push(RecallDoc {
            hit,
            label: note.label.clone(),
            description: note.description.clone(),
            body: body_tokens,
            body_len,
            modified: note.modified,
            age_days,
            avg_body_len: 1.0,
            idf: HashMap::new(),
        });
    }
    let avg = docs.iter().map(|d| d.body_len).sum::<usize>() as f64 / docs.len().max(1) as f64;
    let mut idf = HashMap::new();
    for term in &query {
        let df = docs
            .iter()
            .filter(|d| {
                d.label.contains(term) || d.description.contains(term) || d.body.contains(term)
            })
            .count() as f64;
        idf.insert(
            term.clone(),
            (1.0 + (docs.len() as f64 - df + 0.5) / (df + 0.5)).ln(),
        );
    }
    for doc in &mut docs {
        doc.avg_body_len = avg;
        doc.idf = idf.clone();
        doc.hit.score = score_doc(&query, doc);
    }
    select_recall_hits(docs, limit, include_profile)
}

/// Testable filesystem entry point; no environment reads, no cache, no graph freshness dependence.
#[cfg(test)]
fn recall_from_home(
    home: &Path,
    graph: Option<&Path>,
    query: &str,
    limit: usize,
    include_profile: bool,
    now: SystemTime,
) -> Result<Vec<MemoryHit>, String> {
    let notes = load_notes(home, &[])?;
    Ok(rank_notes(&notes, &galaxy_ids(graph), query, limit, include_profile, now))
}

struct NoteCache {
    home: PathBuf,
    loaded: Instant,
    notes: Arc<Vec<Arc<PreparedNote>>>,
}

static NOTE_CACHE: Mutex<Option<NoteCache>> = Mutex::new(None);
/// Held for the whole of a (re)load, so a cold recall waits for the launch warm-up instead
/// of starting a second full read beside it.
static NOTE_LOAD: Mutex<()> = Mutex::new(());
static NOTE_REFRESHING: AtomicBool = AtomicBool::new(false);
/// Cached notes older than this are re-checked in the background. A re-check lists the
/// folders and re-reads only changed files, so it is cheap; the recall that triggers it is
/// answered from the cache and never waits.
const NOTE_CACHE_FRESH: Duration = Duration::from_secs(90);

fn cached(home: &Path) -> Option<(Instant, Arc<Vec<Arc<PreparedNote>>>)> {
    let guard = NOTE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .as_ref()
        .filter(|c| c.home == home)
        .map(|c| (c.loaded, Arc::clone(&c.notes)))
}

fn reload_notes(home: &Path) -> Result<Arc<Vec<Arc<PreparedNote>>>, String> {
    let _load = NOTE_LOAD.lock().unwrap_or_else(|e| e.into_inner());
    let previous = cached(home).map(|(_, notes)| notes);
    let notes = Arc::new(load_notes(
        home,
        previous.as_deref().map(Vec::as_slice).unwrap_or(&[]),
    )?);
    *NOTE_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some(NoteCache {
        home: home.to_path_buf(),
        loaded: Instant::now(),
        notes: Arc::clone(&notes),
    });
    Ok(notes)
}

fn refresh_in_background(home: PathBuf) {
    if NOTE_REFRESHING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let started = Instant::now();
        let result = reload_notes(&home);
        NOTE_REFRESHING.store(false, Ordering::SeqCst);
        match result {
            Ok(notes) => crate::boot_log(&format!(
                "memory recall: {} notes ready in {} ms",
                notes.len(),
                started.elapsed().as_millis()
            )),
            Err(e) => crate::boot_log(&format!("memory recall: loading notes failed: {e}")),
        }
    });
}

/// Prepared notes for a recall: the cache when there is one, otherwise the load already in
/// flight (the launch warm-up), otherwise a fresh load.
fn cached_notes(home: &Path) -> Result<Arc<Vec<Arc<PreparedNote>>>, String> {
    if let Some((loaded, notes)) = cached(home) {
        if loaded.elapsed() > NOTE_CACHE_FRESH {
            refresh_in_background(home.to_path_buf());
        }
        return Ok(notes);
    }
    {
        let _wait = NOTE_LOAD.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, notes)) = cached(home) {
            return Ok(notes);
        }
    }
    reload_notes(home)
}

/// True once the notes are in memory, so a caller that must answer fast (Atlas's context
/// card) can skip recall instead of waiting out the first read after launch.
pub(crate) fn recall_warm() -> bool {
    NOTE_CACHE.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Start reading the notes at launch, so the first recall - Atlas's context card, a
/// build's plan - does not pay for the whole read.
pub(crate) fn warm_recall_cache() {
    if let Some(home) = std::env::var_os("USERPROFILE") {
        refresh_in_background(PathBuf::from(home));
    }
}

static GALAXY_IDS: Mutex<Option<((PathBuf, SystemTime, u64), Arc<HashMap<String, String>>)>> =
    Mutex::new(None);

/// `galaxy_ids`, re-parsed only when the graph file changes - it is megabytes of JSON.
fn cached_galaxy_ids(graph: Option<&Path>) -> Arc<HashMap<String, String>> {
    let Some(path) = graph else {
        return Arc::default();
    };
    let Ok(meta) = fs::metadata(path) else {
        return Arc::default();
    };
    let stamp = (
        path.to_path_buf(),
        meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        meta.len(),
    );
    let mut guard = GALAXY_IDS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((seen, ids)) = guard.as_ref() {
        if *seen == stamp {
            return Arc::clone(ids);
        }
    }
    let ids = Arc::new(galaxy_ids(Some(path)));
    *guard = Some((stamp, Arc::clone(&ids)));
    ids
}

/// Debounce window - refuses to spawn a new build if one finished (or was requested) within
/// this long. Keeps the 5-minute frontend poll (see App.tsx) from stacking up node processes
/// if a build ever runs long, and no-ops a "refresh on open" that immediately follows one.
const DEBOUNCE: Duration = Duration::from_secs(20);

static LAST_RUN: Mutex<Option<Instant>> = Mutex::new(None);
/// True while a build-memory-graph.cjs child is actually running (belt-and-suspenders on
/// top of the time-based DEBOUNCE, in case a run takes longer than the debounce window).
static RUNNING: Mutex<bool> = Mutex::new(false);

/// Where the refreshed graph lives at runtime - NOT `public/` (that's baked into `dist` at
/// build time and is read-only once packaged). `praxis_dir()` mirrors skills.jsonl/usage.json.
fn out_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    // Prefer the shared Praxis app-data dir (mirrors skill_store.rs); fall back to Tauri's
    // own app_data_dir if LOCALAPPDATA is somehow unset (matches flightdeck.rs's fallback dir).
    crate::praxis_dir()
        .or_else(|| app.path().app_data_dir().ok())
        .map(|d| d.join("memory-graph.json"))
}

/// The repo-root-relative script. Resolved via `CARGO_MANIFEST_DIR` (baked in at compile time
/// as the absolute path to `src-tauri/`), which is correct both in `cargo tauri dev` and in a
/// release binary built from this same checkout - Praxis is always built+installed from
/// `C:\Users\dev\Desktop\praxis`, never relocated post-build (see quartz_sidecar.rs's
/// workspace() comment for why that assumption is otherwise dangerous on this machine).
fn script_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join("build-memory-graph.cjs")
}

/// Fire-and-forget async rebuild of the memory graph, debounced. Safe to call often (e.g. on
/// every knowledge-window open + its 5-min poll) - near-duplicate calls no-op instead of piling
/// up `node` processes.
#[tauri::command]
pub fn refresh_memory_graph(app: tauri::AppHandle) -> Result<(), String> {
    {
        let mut last = LAST_RUN.lock().unwrap();
        if let Some(t) = *last {
            if t.elapsed() < DEBOUNCE {
                return Ok(()); // too soon - the existing/in-flight output is fresh enough
            }
        }
        if *RUNNING.lock().unwrap() {
            return Ok(()); // a build is already in flight
        }
        *last = Some(Instant::now());
    }

    let script = script_path();
    if !script.exists() {
        return Err(format!(
            "build-memory-graph.cjs not found at {}",
            script.display()
        ));
    }
    let Some(out) = out_path(&app) else {
        return Err("could not resolve a writable app-data dir for memory-graph.json".into());
    };
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }

    // build-memory-graph.cjs is now multi-root (2026-07-02 Scribe pass): it discovers every
    // Claude Code project under `%USERPROFILE%\.claude\projects\*\memory` itself instead of
    // reading one hardcoded Praxis memory/intent/sessions triple, so Praxis no longer drowns
    // every other initiative in the galaxy. argv[2] (projects root) and argv[4] (Praxis
    // sessions dir override) still exist for manual/testing use - leave them at the script's
    // own defaults here; argv[3] is an unused legacy placeholder kept for positional
    // compatibility. Only the OUT path (argv[5]) needs to be this runtime app-data location.
    *RUNNING.lock().unwrap() = true;
    std::thread::spawn(move || {
        let mut cmd = std::process::Command::new("node");
        cmd.arg(&script)
            .arg("") // argv[2] projects root - "" falls through to the script's own default
            .arg("") // argv[3] unused legacy placeholder
            .arg("") // argv[4] Praxis sessions dir - "" falls through to the script's own default
            .arg(&out)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW - never flash a console
        }
        let result = cmd.output();
        *RUNNING.lock().unwrap() = false;
        // stderr from a packaged GUI app goes nowhere - also append to a log file next to
        // the graph itself, so a flapping builder is diagnosable after the fact (the 2026-07-02
        // sessions-only-graph incident took filesystem archaeology to reconstruct without this).
        let line = match result {
            Ok(o) if o.status.success() => {
                // The node-count summary ("memory-graph.json → N nodes, M edges") prints near the
                // END of stdout, after per-project progress lines - grab that, not lines().next(),
                // or the forensic log records "OK (…progress noise…)" with no counts.
                let stdout = String::from_utf8_lossy(&o.stdout).into_owned();
                let summary = stdout
                    .lines()
                    .find(|l| l.contains("nodes,"))
                    .or_else(|| stdout.lines().find(|l| !l.trim().is_empty()))
                    .unwrap_or("")
                    .trim()
                    .to_string();
                format!("OK {} ({summary})", out.display())
            }
            Ok(o) => format!(
                "FAIL exit {}: {}",
                o.status,
                String::from_utf8_lossy(&o.stderr).trim()
            ),
            Err(e) => format!("FAIL spawn node: {e}"),
        };
        if line.starts_with("FAIL") {
            crate::elog!("[memory-graph] {line}");
        } else {
            crate::dlog!("[memory-graph] {line}");
        }
        log_line(&out, &line);
    });
    Ok(())
}

/// Append one epoch-stamped line to `memory-graph.log` beside the graph file (same
/// `[epoch-secs]` convention as praxis-boot.log). Best-effort - never fails the caller.
fn log_line(graph_out: &std::path::Path, line: &str) {
    let Some(dir) = graph_out.parent() else {
        return;
    };
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("memory-graph.log"))
    {
        use std::io::Write;
        let _ = writeln!(f, "[{secs}] {line}");
    }
}

/// Open a Memory Galaxy node's REAL backing file with the OS default app (the Inspector's
/// "Open file" button - dead-button fix, 2026-07-10).
///
/// Why Rust-side: the old frontend dispatch deep-linked vault notes to
/// `obsidian://open?vault=memory&…`, a custom URL scheme the opener plugin's default JS URL
/// scope (http/https/mailto/tel) silently rejects - so every vault-internal node's button
/// died in an unseen console.error. `tauri_plugin_opener::open_path` (the Rust API) has no
/// JS scope in the way, and the real file on disk is the honest artifact either way.
///
/// Resolution order: the builder-emitted absolute `path` first; then `slug` against the
/// Praxis memory vault (`%USERPROFILE%\.claude\projects\C--Users-dev-Desktop-praxis\memory\
/// <slug>.md` - the same vault root scripts/build-memory-graph.cjs anchors on), so older
/// cached graphs whose nodes predate the `path` field still open. Only opens files that
/// actually exist - a missing file returns Err instead of pretending.
#[tauri::command]
pub fn open_memory_file(path: Option<String>, slug: Option<String>) -> Result<(), String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = path {
        let p = p.trim();
        if !p.is_empty() {
            candidates.push(PathBuf::from(p));
        }
    }
    if let Some(s) = slug {
        let s = s.trim();
        // slugs are bare note filenames (no separators) - refuse anything path-shaped
        if !s.is_empty() && !s.contains('/') && !s.contains('\\') && !s.contains("..") {
            if let Ok(home) = std::env::var("USERPROFILE") {
                candidates.push(
                    PathBuf::from(home)
                        .join(".claude")
                        .join("projects")
                        .join("C--Users-dev-Desktop-praxis")
                        .join("memory")
                        .join(format!("{s}.md")),
                );
            }
        }
    }
    for c in &candidates {
        if c.is_file() {
            return tauri_plugin_opener::open_path(c, None::<&str>)
                .map_err(|e| format!("open {}: {e}", c.display()));
        }
    }
    Err(match candidates.first() {
        Some(c) => format!("no backing file on disk (looked for {})", c.display()),
        None => "node carries no file path or slug".to_string(),
    })
}

/// Read the last-built graph back for the frontend. Returns the raw JSON text (parsed
/// frontend-side) so this module doesn't need to know `GraphData`'s shape - same "loose schema,
/// frontend owns it" approach as skill_store.rs.
#[tauri::command]
pub fn read_memory_graph(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(path) = out_path(&app) else {
        return Ok(None);
    };
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

#[cfg(test)]
mod recall_tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static ID: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let stamp = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target/test-fixtures")
                .join(format!(
                    "recall-{}-{stamp}-{}",
                    std::process::id(),
                    ID.fetch_add(1, Ordering::Relaxed)
                ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn write(&self, rel: &str, text: &str) -> PathBuf {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, text).unwrap();
            path
        }
        fn recall(&self, query: &str, limit: usize, profiles: bool) -> Vec<MemoryHit> {
            recall_from_home(
                &self.0,
                Some(&self.0.join("graph.json")),
                query,
                limit,
                profiles,
                SystemTime::now(),
            )
            .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn doc(label: &str, description: &str, body: &str, age_days: f64) -> RecallDoc {
        RecallDoc {
            hit: MemoryHit {
                path: String::new(),
                label: label.into(),
                description: Some(description.into()),
                project: String::new(),
                kind: "note".into(),
                memory_type: None,
                excerpt: body.into(),
                galaxy_id: None,
                score: 0.0,
            },
            label: tokenize(label),
            description: tokenize(description),
            body: tokenize(body),
            body_len: tokenize(body).len(),
            modified: SystemTime::UNIX_EPOCH,
            age_days,
            avg_body_len: 10.0,
            idf: HashMap::new(),
        }
    }

    #[test]
    fn redacts_every_key_assignment_whole_line() {
        for key in [
            "apikey",
            "api_key",
            "api-key",
            "secret",
            "password",
            "passwd",
            "token",
            "bearer",
            "authorization",
            "cookie",
            "privatekey",
            "private_key",
            "private-key",
        ] {
            for delimiter in [":", "="] {
                assert_eq!(
                    redact_secrets(&format!(
                        "safe\nprefix {} {delimiter} value with spaces\nmore",
                        key.to_uppercase()
                    )),
                    "safe\n[redacted]\nmore",
                    "{key}"
                );
            }
        }
    }

    #[test]
    fn redacts_every_token_pattern_and_preserves_prose() {
        let values = [
            format!("sk-{}", "a_-B2".repeat(4)),
            format!("ghp_{}", "aB2".repeat(7)),
            format!("gho_{}", "B3z".repeat(7)),
            format!("xoxa-{}", "aB2-".repeat(3)),
            format!("xoxb-{}", "aB2-".repeat(3)),
            format!("xoxp-{}", "aB2-".repeat(3)),
            format!("xoxr-{}", "aB2-".repeat(3)),
            format!("AKIA{}", "A1".repeat(8)),
            format!("eyJ{}.{}", "a_-B".repeat(5), "aB2_".repeat(3)),
            format!("eyJ{}.{}.signature", "a".repeat(20), "b".repeat(10)),
            "aB+/=_-3".repeat(5),
        ];
        for value in values {
            assert_eq!(
                redact_secrets(&format!("Before ({value}) after.")),
                "Before ([redacted]) after.",
                "{value}"
            );
        }
        let normal = "Zach builds personal websites. Café 🚀\nA token can mean a word; cookies taste good.\nmytoken: ordinary; secretive: ordinary\nsk-short ghp_short xoxb-short AKIA123 eyJshort.short";
        assert_eq!(redact_secrets(normal), normal);
        assert_eq!(redact_secrets(&"a".repeat(39)), "a".repeat(39));
        assert_eq!(redact_secrets(&"a".repeat(40)), "[redacted]");
    }

    #[test]
    fn tokenizer_and_bm25_field_weights() {
        assert_eq!(
            tokenize("THE x Website, 42 cats_and-dogs!"),
            vec!["website", "42", "cats", "dogs"]
        );
        let q = tokenize("website website");
        let label = doc("Website", "", "neutral body", 20.0);
        let desc = doc("Other", "website", "neutral body", 20.0);
        let body = doc("Other", "", "website body", 20.0);
        assert!(score_doc(&q, &label) > score_doc(&q, &desc));
        assert!(score_doc(&q, &desc) > score_doc(&q, &body));
        assert_eq!(score_doc(&q, &body), score_doc(&tokenize("website"), &body));
        assert_eq!(score_doc(&tokenize("absent"), &label), 0.0);
        assert_eq!(score_doc(&[], &label), 0.0);
    }

    #[test]
    fn scoring_recency_boost_is_bounded_and_length_normalized() {
        let q = tokenize("website");
        let old = score_doc(&q, &doc("website", "", "neutral", 14.0));
        let fresh = score_doc(&q, &doc("website", "", "neutral", 0.0));
        assert!((fresh / old - 1.1).abs() < 1e-10);
        assert_eq!(old, score_doc(&q, &doc("website", "", "neutral", 50.0)));
        assert!(old > score_doc(&q, &doc("website", "", &"neutral ".repeat(100), 14.0)));
    }

    #[test]
    fn frontmatter_fields_fallbacks_and_kinds() {
        let (fm, body) = recall_frontmatter("\u{feff}---\r\nname: 'My Site'\r\ntype: project\r\nmetadata:\r\n  type: user\r\ndescription: >-\r\n  Some text\r\n  more text\r\n---\r\n# Body\r\n");
        assert_eq!(fm.name.as_deref(), Some("My Site"));
        assert_eq!(fm.memory_type.as_deref(), Some("user"));
        assert_eq!(fm.description.as_deref(), Some("Some text\nmore text"));
        assert_eq!(body, "# Body\r\n");
        for (path, intent, ty, kind) in [
            ("MEMORY.md", true, None, "index"),
            ("topic.md", true, None, "idea"),
            ("tasks/item.md", false, Some("reference"), "task"),
            ("todo/item.md", false, None, "task"),
            ("conversations/item.md", false, None, "conversation"),
            ("agent-chats/item.md", false, None, "conversation"),
            ("reference.md", false, Some("reference"), "reference"),
            ("note.md", false, Some("project"), "note"),
        ] {
            assert_eq!(recall_kind(Path::new(path), intent, ty), kind);
        }
        assert_eq!(
            recall_frontmatter("---\nname: unfinished").1,
            "---\nname: unfinished"
        );
    }

    #[test]
    fn fixture_profile_order_dedupe_and_zero_match_inclusion() {
        let f = Fixture::new();
        f.write(
            ".claude/projects/project/memory/user.md",
            "---\nname: Website owner\ntype: user\n---\nWebsite builder.",
        );
        f.write(
            ".claude/projects/project/memory/other-user.md",
            "---\nname: Personal background\nmetadata:\n  type: user\n---\nEnjoys hiking.",
        );
        f.write(
            ".claude/projects/project/memory/site.md",
            "# Website projects\nWebsite.",
        );
        let hits = f.recall("website", 8, true);
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].label, "Website owner");
        assert_eq!(hits[1].label, "Personal background");
        assert_eq!(hits[2].label, "Website projects");
        assert_eq!(
            hits.iter().map(|h| &h.path).collect::<HashSet<_>>().len(),
            3
        );
        assert_eq!(f.recall("website", 8, false).len(), 2);
        // About-me recall = profile notes + one overview per project, even with no
        // query match ("Website projects" is this fixture project's overview).
        let unmatched = f.recall("unmatched", 8, true);
        assert_eq!(unmatched.len(), 3);
        assert_eq!(unmatched[2].label, "Website projects");
        assert!(f.recall("unmatched", 8, false).is_empty());
        assert_eq!(f.recall("", 8, true).len(), 3);
    }

    #[test]
    fn about_me_recall_adds_one_overview_per_real_project() {
        let f = Fixture::new();
        f.write(
            ".claude/projects/C--Desktop-praxis/memory/praxis-north-star.md",
            "---\nname: praxis-is-the-orchestrator-north-star\ndescription: Praxis is an AI operating system and orchestrator\ntype: project\n---\nThe product vision.",
        );
        f.write(
            ".claude/projects/C--Desktop-praxis/memory/gotcha.md",
            "---\nname: cdp port gotcha\ntype: project\n---\nPort 9334.",
        );
        f.write(
            ".claude/projects/C--Desktop-catalyzed-alpha/memory/what.md",
            "---\nname: catalyzed alpha research platform\ndescription: stock signal research tool\ntype: project\n---\nSignals.",
        );
        f.write(
            ".claude/projects/C--Desktop-catalyzed-lanes-laneA/memory/dup.md",
            "---\nname: catalyzed lane platform duplicate\ntype: project\n---\nPlatform.",
        );
        let labels: Vec<String> = f.recall("nothing matches", 8, true).into_iter().map(|h| h.label).collect();
        assert!(labels.contains(&"praxis-is-the-orchestrator-north-star".to_string()), "{labels:?}");
        assert!(labels.contains(&"catalyzed alpha research platform".to_string()), "{labels:?}");
        assert!(!labels.iter().any(|l| l.contains("gotcha")), "the project's overview, not its gotchas: {labels:?}");
        assert!(!labels.iter().any(|l| l.contains("lane")), "lane worktrees duplicate their project: {labels:?}");
        assert!(f.recall("nothing matches", 8, false).is_empty(), "overviews are about-me only");
    }

    #[test]
    fn fixture_fresh_source_graph_mapping_redaction_and_labels() {
        assert_eq!(path_key("C:\\Café\\Note.md"), path_key("c:/CAFÉ/note.MD"));
        let f = Fixture::new();
        let long_label = "a-perfectly-normal-long-memory-note-filename-about-a-website";
        let long_path = f.write(
            &format!(".claude/projects/Labels/memory/{long_label}.md"),
            "website",
        );
        assert_eq!(f.recall("website", 8, false)[0].label, long_label);
        fs::remove_file(long_path).unwrap();
        let path = f.write(".claude/projects/MyProject/memory/nested/site.md", &format!("---\nname: My website\ndescription: 'token: private value'\ntype: reference\n---\n# Website\npassword=hidden\n{}", "🌍 body ".repeat(300)));
        let canonical = path
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_ascii_uppercase()
            .replace('\\', "/");
        f.write(
            "graph.json",
            &serde_json::json!({"nodes":[{"id":"galaxy.site","path":canonical}]}).to_string(),
        );
        let hits = f.recall("website", 8, false);
        assert_eq!(hits[0].galaxy_id.as_deref(), Some("galaxy.site"));
        assert_eq!(hits[0].project, "MyProject");
        assert_eq!(hits[0].kind, "reference");
        assert_eq!(hits[0].description.as_deref(), Some("[redacted]"));
        assert_eq!(hits[0].excerpt.chars().count(), 1200);
        assert!(!hits[0].excerpt.contains("hidden"));
        assert!(!hits[0].excerpt.contains('\n'));
        fs::write(&path, "# Changed website\nFresh text").unwrap();
        assert_eq!(f.recall("website", 8, false)[0].label, "Changed website");
        f.write("graph.json", "invalid json");
        assert!(f.recall("website", 8, false)[0].galaxy_id.is_none());
        f.write(
            ".claude/projects/MyProject/memory/fallback.md",
            "website text",
        );
        assert!(f
            .recall("website", 8, false)
            .iter()
            .any(|h| h.label == "fallback"));
    }

    #[test]
    fn fixture_exclusions_size_recursive_intent_and_limits() {
        let f = Fixture::new();
        for dir in [
            "archive",
            "sessions",
            "secrets",
            ".git",
            "node_modules",
            "ARCHIVE",
        ] {
            f.write(
                &format!(".claude/projects/project/memory/{dir}/skip.md"),
                "website",
            );
        }
        f.write(
            ".claude/projects/project/memory/huge.md",
            &"x".repeat(MAX_RECALL_BYTES as usize + 1),
        );
        f.write(
            ".claude/memory/intent/topics/nested/site.md",
            "# Website idea",
        );
        assert_eq!(f.recall("website", 8, false).len(), 1);
        assert_eq!(f.recall("website", 8, false)[0].kind, "idea");
        for i in 0..30 {
            let note = f.write(
                &format!(".claude/projects/project/memory/nested/n{i:02}.md"),
                "website",
            );
            let at = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000 + i);
            fs::File::options().write(true).open(note).unwrap().set_modified(at).unwrap();
        }
        for i in 0..6 {
            f.write(
                &format!(".claude/projects/project/memory/u{i}.md"),
                "---\ntype: user\n---\nHiking",
            );
        }
        assert_eq!(f.recall("website", 0, false).len(), 1);
        assert_eq!(f.recall("website", 99, false).len(), 25);
        // 4 profile notes + 1 project overview + 25 query hits.
        assert_eq!(f.recall("website", 99, true).len(), 30);
        assert!(f.recall("website", 99, true)[..4]
            .iter()
            .all(|h| h.memory_type.as_deref() == Some("user")));
    }

    #[test]
    fn collection_stops_at_file_budget() {
        let f = Fixture::new();
        for i in 0..3 {
            f.write(&format!("p{i}.md"), "website");
        }
        let mut paths: Vec<RecallPath> = (1..MAX_RECALL_FILES)
            .map(|_| RecallPath {
                path: PathBuf::new(),
                project: String::new(),
                intent: false,
                modified: SystemTime::UNIX_EPOCH,
                len: 0,
            })
            .collect();
        collect_recall_paths(&f.0, "test", false, &mut paths);
        assert_eq!(paths.len(), MAX_RECALL_FILES);
        assert!(paths.last().unwrap().path.ends_with("p0.md"));
    }

    #[test]
    fn metadata_type_is_direct_child_or_inline_mapping() {
        let (fm, _) = recall_frontmatter("---\nmetadata: { type: user }\n---\nProfile");
        assert_eq!(fm.memory_type.as_deref(), Some("user"));
        let (fm, _) = recall_frontmatter(
            "---\ntype: reference\nmetadata:\n  unrelated:\n    type: user\n---\nReference",
        );
        assert_eq!(fm.memory_type.as_deref(), Some("reference"));
        let (fm, _) = recall_frontmatter("---\ntype: reference\nmetadata:\n  unrelated:\n    type: project\n  type: user\n---\nProfile");
        assert_eq!(fm.memory_type.as_deref(), Some("user"));
        assert_eq!(
            recall_kind(
                Path::new("memory/intent/topics/website.md"),
                false,
                Some("reference")
            ),
            "idea"
        );
    }

    #[test]
    fn about_me_recall_leads_with_identity_and_never_with_accounts() {
        let f = Fixture::new();
        f.write(
            ".claude/projects/p/memory/owner-accounts.md",
            "---\nname: owner-accounts\ntype: user\n---\nAccount notes.",
        );
        f.write(
            ".claude/projects/p/memory/owner-email.md",
            "---\nname: owner-email\ntype: user\n---\nEmail notes.",
        );
        f.write(
            ".claude/projects/p/memory/owner-education.md",
            "---\nname: owner-education\ndescription: Mathematics and Engineering at Queen's University\ntype: user\n---\nStudent in mathematics; awards and scholarship.",
        );
        f.write(
            ".claude/projects/p/memory/workflow.md",
            "---\nname: session workflow\ntype: user\n---\nPrefers short bullets.",
        );
        f.write(
            ".claude/projects/p/memory/current-account.md",
            "---\nname: current account\ntype: reference\n---\nwebsite personal account",
        );
        f.write(
            ".claude/projects/p/memory/runs/run-1789592268501.md",
            "# Agent run — incomplete\nGoal: create a personal website\nwebsite personal website personal",
        );
        let hits = f.recall("personal website", 8, true);
        assert!(hits.iter().all(|h| !h.label.contains("Agent run")), "run logs are not memory about Zach");
        assert!(f.recall("personal website", 8, false).iter().any(|h| h.label.contains("Agent run")), "a normal recall still finds run logs");
        assert_eq!(hits[0].label, "owner-education");
        assert!(hits.iter().all(|h| !h.label.contains("account") && !h.label.contains("email")));
        // A private (non-about-me) recall still finds account notes when asked.
        assert!(f.recall("account", 8, false).iter().any(|h| h.label.contains("account")));
    }

    #[test]
    fn recalled_paths_drop_the_verbatim_prefix() {
        assert_eq!(display_path(Path::new(r"\\?\C:\Users\dev\m.md")), r"C:\Users\dev\m.md");
        assert_eq!(display_path(Path::new(r"\\?\UNC\srv\share\m.md")), r"\\srv\share\m.md");
        assert_eq!(display_path(Path::new(r"C:\plain.md")), r"C:\plain.md");
    }

    #[test]
    fn profile_ties_use_recency_then_path() {
        let mut old = doc("Old", "", "", 30.0);
        old.hit.path = "old.md".into();
        old.hit.memory_type = Some("user".into());
        let mut new = doc("New", "", "", 0.0);
        new.hit.path = "new.md".into();
        new.hit.memory_type = Some("user".into());
        new.modified = SystemTime::UNIX_EPOCH + Duration::from_secs(5);
        let hits = select_recall_hits(vec![old, new], 8, true);
        assert_eq!(hits[0].label, "New");
    }

    #[test]
    fn a_refresh_rereads_only_the_notes_that_changed() {
        let fx = Fixture::new();
        fx.write(".claude/projects/p/memory/a.md", "---\nname: alpha\n---\nfirst body about gliders\n");
        let b = fx.write(".claude/projects/p/memory/b.md", "---\nname: beta\n---\nsecond body\n");
        let first = load_notes(&fx.0, &[]).unwrap();
        assert_eq!(first.len(), 2);
        fs::write(&b, "---\nname: beta\n---\nsecond body, now about kites as well\n").unwrap();
        let second = load_notes(&fx.0, &first).unwrap();
        let find = |notes: &[Arc<PreparedNote>], label: &str| {
            Arc::clone(notes.iter().find(|n| n.hit.label == label).unwrap())
        };
        assert!(
            Arc::ptr_eq(&find(&first, "alpha"), &find(&second, "alpha")),
            "an unchanged note is reused, not opened again"
        );
        assert!(
            !Arc::ptr_eq(&find(&first, "beta"), &find(&second, "beta")),
            "a changed note is read again"
        );
        let hits = rank_notes(&second, &HashMap::new(), "kites", 3, false, SystemTime::now());
        assert_eq!(hits.first().map(|h| h.label.as_str()), Some("beta"));
    }

    #[test]
    #[ignore = "explicit read-only timing against real home; prints counts and milliseconds only"]
    fn live_recall_cache_timing() {
        let home = PathBuf::from(std::env::var_os("USERPROFILE").expect("USERPROFILE"));
        let t = Instant::now();
        let listed = list_recall_paths(&home).unwrap().len();
        let list_ms = t.elapsed().as_millis();
        let t = Instant::now();
        let notes = load_notes(&home, &[]).unwrap();
        let load_ms = t.elapsed().as_millis();
        let t = Instant::now();
        let again = load_notes(&home, &notes).unwrap();
        let refresh_ms = t.elapsed().as_millis();
        let t = Instant::now();
        let hits = rank_notes(&again, &HashMap::new(), "Zach email school projects", 6, true, SystemTime::now());
        let rank_ms = t.elapsed().as_millis();
        println!("listed {listed} in {list_ms} ms; loaded {} in {load_ms} ms; refresh {refresh_ms} ms; rank {rank_ms} ms; {} hits", notes.len(), hits.len());
    }

    #[test]
    #[ignore = "explicit read-only smoke against real home; prints metadata only"]
    fn live_memory_recall_print() {
        let home = PathBuf::from(std::env::var_os("USERPROFILE").expect("USERPROFILE"));
        let graph = crate::praxis_dir().map(|p| p.join("memory-graph.json"));
        let hits = recall_from_home(
            &home,
            graph.as_deref(),
            "personal website about me projects",
            8,
            true,
            SystemTime::now(),
        )
        .unwrap();
        assert!(!hits.is_empty(), "live recall returned no notes");
        for hit in hits {
            println!("{} | {} | {:.6}", hit.label, hit.path, hit.score);
        }
    }
}
