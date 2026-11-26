// Transcript tailer - the DEEP half of the Praxis real-event bus (Phase 2b).
//
// The frontend bridge (Phase 2a, src/data/realEvents.ts) already turns the
// `fd_sessions` snapshot into brain events by polling every 2.5s and diffing
// running/preview deltas. That is coarse: it only sees a one-line preview and
// only as often as it polls. THIS is the rich, push-based signal.
//
// A background thread tails every running session's transcript
//   ~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl
// from a saved byte offset (~500ms cadence). Each newly-appended JSONL record is
// parsed and pushed to the frontend as a `praxis://transcript-event`:
//
//   • assistant text block → the agent's actual prose  → core SPEAKS + a thought
//   • assistant tool_use   → the agent ran a tool (Edit/Read/Bash/…) → activity
//
// The frontend (`useRealEvents`) maps those to the SAME flat PraxisEvent shapes
// the mock timeline emits, so the brain is UNCHANGED - only the event source gets
// richer and (half-second) snappier. User turns and tool_results are deliberately
// skipped: they are high-frequency and low-signal for the visualization.
//
// We start each session at EOF the first time we see it (skip the backlog) so the
// brain reflects what's happening NOW, not a replay of the whole conversation; the
// `session_poller` handles the "a session came alive → its agent flies in" beat.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tauri::Emitter;

use crate::flightdeck;

const POLL_MS: u64 = 500; // how often to tail each running transcript
const MAX_READ: u64 = 512 * 1024; // bytes consumed per session per poll (catch-up cap)
const CONTENT_MAX: usize = 280; // truncate prose before it crosses the IPC bridge

/// The push payload. snake_case field names (serde default) match the contract the
/// frontend reads: `e.payload.session_id`, `event_type`, `tool_name`, `git_branch`…
#[derive(Clone, serde::Serialize)]
struct TranscriptEvent {
    session_id: String,
    cwd: String,
    event_type: String, // "assistant" | "tool_use"
    model: Option<String>,
    content: Option<String>,
    tool_name: Option<String>,
    /// The FILE a repo-mutating tool touched (Write / Edit / NotebookEdit), absolute
    /// as the tool reported it. Carried so the brain's "files born" surface can show
    /// what agents actually produce: it used to watch a single hardcoded folder,
    /// ~/Desktop/agent-output, that nothing in Praxis has ever written to - real
    /// agents write into their repo worktrees. None for every other tool.
    tool_path: Option<String>,
    git_branch: Option<String>,
    timestamp: u64,
}

/// Spawn the tailer on its own OS thread. The `running` flag is cleared on app
/// exit (see lib.rs) so the loop stops cleanly instead of being killed mid-read.
pub fn spawn(app: tauri::AppHandle, running: Arc<AtomicBool>) {
    std::thread::spawn(move || tail_loop(app, running));
}

fn tail_loop(app: tauri::AppHandle, running: Arc<AtomicBool>) {
    // session id → byte offset already consumed. Persists across idle periods so a
    // resumed session continues exactly where it left off (the file only grows).
    let mut offsets: HashMap<String, u64> = HashMap::new();
    // Sessions we've already logged a first-event for (diagnostics; see emit_line).
    let mut logged: HashSet<String> = HashSet::new();
    // The running-session LIST is refreshed every REFRESH_EVERY ticks (~2s); the
    // bytes of those files are tailed every tick (~500ms). Resolving the list runs
    // `tasklist` + walks the session store, which is too heavy to do 2×/second - but
    // reading appended bytes is cheap, so the fast loop stays fast.
    const REFRESH_EVERY: u32 = 4;
    let mut sessions: Vec<flightdeck::RunningSession> = Vec::new();
    let mut tick: u32 = 0;

    while running.load(Ordering::Relaxed) {
        if tick % REFRESH_EVERY == 0 {
            sessions = flightdeck::running_sessions();
        }
        tick = tick.wrapping_add(1);

        for s in &sessions {
            let off = match offsets.get(&s.session_id).copied() {
                Some(o) => o,
                None => {
                    // First sight → start at EOF: skip the existing history, stream
                    // only what's written from here on. (The poller emits the
                    // "started" beat, so the agent still flies in immediately.)
                    let size = std::fs::metadata(&s.transcript)
                        .map(|m| m.len())
                        .unwrap_or(0);
                    offsets.insert(s.session_id.clone(), size);
                    continue;
                }
            };

            let Some((lines, new_off)) = read_appended(&s.transcript, off, MAX_READ) else {
                continue; // transcript not readable this tick - retry next poll
            };
            if new_off != off {
                offsets.insert(s.session_id.clone(), new_off);
            }
            for line in &lines {
                emit_line(&app, s, line, &mut logged);
            }
        }

        sleep_interruptible(&running, POLL_MS);
    }
}

/// Read whole lines appended since `offset`, byte-accurately, capped at `max`.
/// Returns the complete lines and the new offset (advanced only past a trailing
/// newline, so a half-written final line is left for the next poll). `None` only
/// when the file can't be opened/stat'd.
fn read_appended(path: &Path, offset: u64, max: u64) -> Option<(Vec<String>, u64)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    // File shrank/was replaced → resume at its NEW end, never from the top. Claude only
    // appends, so a shorter file is the desktop app rewriting history (it rewrote an idle
    // Studio transcript at 12:28 on 2026-10-04), and replaying that from byte 0
    // re-emitted weeks-old turns as live work: an agent orbiting a session nobody was in.
    if size < offset {
        return Some((vec![], size));
    }
    let start = offset;
    if size <= start {
        return Some((vec![], size));
    }
    let want = (size - start).min(max);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity(want as usize);
    f.take(want).read_to_end(&mut buf).ok()?;

    // Consume only up to the last newline; keep a partial trailing line unread.
    let consume = match buf.iter().rposition(|&b| b == b'\n') {
        Some(i) => i + 1,
        None => 0,
    };
    let mut lines = Vec::new();
    for raw in buf[..consume].split(|&b| b == b'\n') {
        if raw.is_empty() {
            continue;
        }
        let s = String::from_utf8_lossy(raw);
        if !s.trim().is_empty() {
            lines.push(s.into_owned());
        }
    }
    Some((lines, start + consume as u64))
}

/// Parse one JSONL record and push a transcript-event per high-signal content
/// block (logging the first event seen per session, for live diagnostics).
fn emit_line(
    app: &tauri::AppHandle,
    sess: &flightdeck::RunningSession,
    line: &str,
    logged: &mut HashSet<String>,
) {
    for ev in parse_line(
        line,
        &sess.session_id,
        &sess.cwd,
        sess.model.as_deref(),
        flightdeck::now_ms(),
    ) {
        if logged.insert(ev.session_id.clone()) {
            crate::dlog!(
                "[bridge] tailing {} — first event: {}{}",
                short(&ev.session_id),
                ev.event_type,
                ev.tool_name
                    .as_deref()
                    .map(|n| format!(" {n}"))
                    .unwrap_or_default(),
            );
        }
        let _ = app.emit("praxis://transcript-event", ev);
    }
}

/// Pure parse of one JSONL line into the transcript-events it should produce.
/// Assistant text → prose (the core speaks), assistant tool_use → activity. User
/// turns + tool_results yield nothing (high-frequency, low-signal noise). Pure so
/// it is unit-testable without a running app (see tests below).
fn parse_line(
    line: &str,
    session_id: &str,
    cwd: &str,
    fallback_model: Option<&str>,
    ts: u64,
) -> Vec<TranscriptEvent> {
    let mut out = Vec::new();
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return out;
    };
    if v.get("type").and_then(|x| x.as_str()) != Some("assistant") {
        return out;
    }
    let branch = v
        .get("gitBranch")
        .and_then(|x| x.as_str())
        .map(String::from);
    let msg = v.get("message");
    let model = msg
        .and_then(|m| m.get("model"))
        .and_then(|x| x.as_str())
        .map(String::from)
        .or_else(|| fallback_model.map(String::from));
    let Some(content) = msg
        .and_then(|m| m.get("content"))
        .and_then(|x| x.as_array())
    else {
        return out;
    };

    let mk =
        |event_type: &str, content: Option<String>, tool_name: Option<String>, tool_path: Option<String>| TranscriptEvent {
            session_id: session_id.to_string(),
            cwd: cwd.to_string(),
            event_type: event_type.to_string(),
            model: model.clone(),
            content,
            tool_name,
            tool_path,
            git_branch: branch.clone(),
            timestamp: ts,
        };

    for b in content {
        match b.get("type").and_then(|x| x.as_str()) {
            Some("text") => {
                if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                    let c = trunc(t, CONTENT_MAX);
                    if !c.is_empty() {
                        out.push(mk("assistant", Some(c), None, None));
                    }
                }
            }
            Some("tool_use") => {
                let name = b.get("name").and_then(|x| x.as_str()).map(String::from);
                // Only a tool that WRITES a file contributes a path. Read/Grep touch
                // files too, but nothing is born by reading one.
                let path = match name.as_deref() {
                    Some("Write") | Some("Edit") | Some("NotebookEdit") => b
                        .get("input")
                        .and_then(|i| i.get("file_path").or_else(|| i.get("notebook_path")))
                        .and_then(|x| x.as_str())
                        .map(String::from),
                    _ => None,
                };
                out.push(mk("tool_use", None, name, path));
            }
            _ => {}
        }
    }
    out
}

/// First 8 chars of a session id, for compact log lines.
fn short(id: &str) -> &str {
    &id[..id.len().min(8)]
}

/// Collapse whitespace and clip to `max` chars (char-aware, never mid-codepoint).
fn trunc(text: &str, max: usize) -> String {
    let s: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > max {
        let cut: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{}…", cut.trim_end())
    } else {
        s
    }
}

/// Sleep `total_ms` but wake every 100ms to check the shutdown flag, so quitting
/// the app doesn't wait out a full poll interval before the thread exits.
fn sleep_interruptible(running: &Arc<AtomicBool>, total_ms: u64) {
    let mut left = total_ms;
    while left > 0 && running.load(Ordering::Relaxed) {
        let slice = left.min(100);
        std::thread::sleep(Duration::from_millis(slice));
        left -= slice;
    }
}

#[cfg(test)]
mod tests {
    /// A Write/Edit carries the file it touched, so the brain's "files born"
    /// surface can show what agents ACTUALLY produce. It used to watch one
    /// hardcoded folder (~/Desktop/agent-output) that nothing in Praxis has ever
    /// written to, so the panel could only ever be empty.
    #[test]
    fn write_and_edit_tools_carry_their_file_path() {
        let line = r#"{"type":"assistant","message":{"content":[
            {"type":"tool_use","name":"Write","input":{"file_path":"C:/repo/src/new.rs"}},
            {"type":"tool_use","name":"Edit","input":{"file_path":"C:/repo/src/old.rs"}},
            {"type":"tool_use","name":"Read","input":{"file_path":"C:/repo/src/read.rs"}},
            {"type":"tool_use","name":"Bash","input":{"command":"ls"}}
        ]}}"#;
        let evs = parse_line(line, "sid", "C:/repo", None, 0);
        let paths: Vec<Option<String>> = evs.iter().map(|e| e.tool_path.clone()).collect();
        assert_eq!(
            paths,
            vec![
                Some("C:/repo/src/new.rs".to_string()),
                Some("C:/repo/src/old.rs".to_string()),
                None, // reading a file does not create one
                None, // and a shell command has no file at all
            ]
        );
    }

    /// A NotebookEdit reports its path under a different key.
    #[test]
    fn notebook_edit_uses_its_own_path_key() {
        let line = r#"{"type":"assistant","message":{"content":[
            {"type":"tool_use","name":"NotebookEdit","input":{"notebook_path":"C:/repo/nb.ipynb"}}
        ]}}"#;
        let evs = parse_line(line, "sid", "C:/repo", None, 0);
        assert_eq!(evs[0].tool_path.as_deref(), Some("C:/repo/nb.ipynb"));
    }

    use super::*;

    fn assistant_line(text: Option<&str>, tools: &[&str], model: &str, branch: &str) -> String {
        let mut content = Vec::new();
        if let Some(t) = text {
            content.push(serde_json::json!({ "type": "text", "text": t }));
        }
        for name in tools {
            content.push(serde_json::json!({ "type": "tool_use", "name": name, "input": {} }));
        }
        serde_json::json!({
            "type": "assistant",
            "gitBranch": branch,
            "message": { "model": model, "content": content }
        })
        .to_string()
    }

    #[test]
    fn parses_assistant_text_and_tools_in_order() {
        let line = assistant_line(
            Some("Wiring the bus  now."),
            &["Edit", "Bash"],
            "claude-opus-4-8",
            "feat/flight-deck",
        );
        let evs = parse_line(&line, "sess-123", "C:/x/praxis", None, 42);
        assert_eq!(evs.len(), 3);

        assert_eq!(evs[0].event_type, "assistant");
        assert_eq!(evs[0].content.as_deref(), Some("Wiring the bus now.")); // whitespace collapsed
        assert_eq!(evs[0].model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(evs[0].git_branch.as_deref(), Some("feat/flight-deck"));
        assert_eq!(evs[0].session_id, "sess-123");
        assert_eq!(evs[0].timestamp, 42);

        assert_eq!(evs[1].event_type, "tool_use");
        assert_eq!(evs[1].tool_name.as_deref(), Some("Edit"));
        assert_eq!(evs[2].tool_name.as_deref(), Some("Bash"));
    }

    #[test]
    fn falls_back_to_session_model_and_skips_user_and_garbage() {
        // assistant line with NO model → falls back to the session's model
        let no_model = serde_json::json!({
            "type": "assistant",
            "gitBranch": "main",
            "message": { "content": [{ "type": "text", "text": "hi" }] }
        })
        .to_string();
        let evs = parse_line(&no_model, "s", "cwd", Some("sonnet-4-6"), 1);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].model.as_deref(), Some("sonnet-4-6"));

        // user turns and tool_results produce nothing
        let user = serde_json::json!({ "type": "user", "message": { "content": "ignore me" } })
            .to_string();
        assert!(parse_line(&user, "s", "cwd", None, 0).is_empty());
        let tr = serde_json::json!({
            "type": "user",
            "message": { "content": [{ "type": "tool_result", "content": "ok" }] }
        })
        .to_string();
        assert!(parse_line(&tr, "s", "cwd", None, 0).is_empty());
        assert!(parse_line("not json", "s", "cwd", None, 0).is_empty());
    }

    #[test]
    fn read_appended_is_byte_accurate_and_keeps_partial_lines() {
        let dir = std::env::temp_dir().join(format!("praxis-tailer-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");

        // two complete lines + a partial (no trailing newline)
        std::fs::write(&path, b"{\"a\":1}\n{\"a\":2}\n{\"a\":3").unwrap();
        let (lines, off) = read_appended(&path, 0, MAX_READ).unwrap();
        assert_eq!(
            lines,
            vec!["{\"a\":1}".to_string(), "{\"a\":2}".to_string()]
        );
        assert_eq!(
            off, 16,
            "offset stops at the last newline, leaving the partial line"
        );

        // re-reading from the same offset yields nothing until the line completes
        let (none, off2) = read_appended(&path, off, MAX_READ).unwrap();
        assert!(none.is_empty());
        assert_eq!(off2, off);

        // finish the partial line → it now comes through, exactly once
        std::fs::write(&path, b"{\"a\":1}\n{\"a\":2}\n{\"a\":3}\n").unwrap();
        let (lines2, off3) = read_appended(&path, off, MAX_READ).unwrap();
        assert_eq!(lines2, vec!["{\"a\":3}".to_string()]);
        assert_eq!(off3, 24);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_rewritten_shorter_transcript_never_replays_history() {
        // Live 2026-10-04: the desktop app rewrote an idle Studio transcript. Read
        // from byte 0, its weeks-old turns would arrive as live work.
        let dir = std::env::temp_dir().join(format!("praxis-tailer-shrink-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        std::fs::write(&path, b"{\"a\":1}\n{\"a\":2}\n{\"a\":3}\n").unwrap();
        let (_, off) = read_appended(&path, 0, MAX_READ).unwrap();
        // rewritten smaller (history compacted) - nothing replays; the offset moves to the new end
        std::fs::write(&path, b"{\"a\":1}\n").unwrap();
        let (lines, off2) = read_appended(&path, off, MAX_READ).unwrap();
        assert!(lines.is_empty(), "replayed {lines:?}");
        assert_eq!(off2, 8);
        // genuinely new lines after that still stream
        std::fs::write(&path, b"{\"a\":1}\n{\"b\":9}\n").unwrap();
        let (fresh, _) = read_appended(&path, off2, MAX_READ).unwrap();
        assert_eq!(fresh, vec!["{\"b\":9}".to_string()]);
        std::fs::remove_dir_all(&dir).ok();
    }
}
