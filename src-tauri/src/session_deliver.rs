//! session_deliver - Flight Deck messages that actually reach the session they're sent to.
//!
//! The deck's lane / repo "cast" and per-session messages used to append "[LANE CAST] …" to
//! the agent's chat log while the toast said "CAST TO N SESSIONS": the sessions themselves
//! never received anything. Both agent CLIs can continue a specific conversation headlessly
//! (verified live 2026-10-01 on throwaway sessions - same id, context intact):
//!   • claude -p "<message>" --resume <session-id>          (Claude Code)
//!   • codex exec resume <session-uuid> "<message>"          (Codex)
//! so a message from the owner is now delivered INTO that conversation as a new turn, and the
//! session's own reply comes back to the deck. A session that is mid-turn is not resumed
//! here (the deck queues it until the session is idle). Cursor's CLI has no resume, so a
//! Cursor session says so plainly instead of pretending.

use std::path::PathBuf;
use std::time::Duration;

use crate::hermes_bridge::{make_async_cmd, HEADLESS_CLAUDE_SETTINGS};

const DELIVER_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const REPLY_CHARS: usize = 1200;

/// What came back from the session. `forked` = the CLI continued a COPY (Claude does that
/// when the session is open elsewhere), so the deck can say where the turn really landed.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivered {
    reply: String,
    session_id: String,
    forked: bool,
}

fn framed(message: &str) -> String {
    format!("[Message from Zach, sent from Praxis's Flight Deck]\n{}", message.trim())
}

fn clip(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n {
        return t.to_string();
    }
    let mut out: String = t.chars().take(n.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// The final reply text (and the session it landed in) from `claude -p --output-format json`.
fn claude_reply(stdout: &str) -> Option<(String, Option<String>)> {
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
    if v.get("is_error").and_then(|x| x.as_bool()) == Some(true) {
        return None;
    }
    let text = v.get("result").and_then(|x| x.as_str())?.to_string();
    let sid = v.get("session_id").and_then(|x| x.as_str()).map(|s| s.to_string());
    Some((text, sid))
}

fn is_full_uuid(s: &str) -> bool {
    s.len() == 36 && s.chars().filter(|c| *c == '-').count() == 4 && s.chars().all(|c| c == '-' || c.is_ascii_hexdigit())
}

/// The deck's Codex card id is `codex:<last 12 hex of the uuid>` (flightdeck.rs keeps it
/// short for locks and pins); `codex exec resume` needs the whole uuid, which is the tail
/// of the rollout file name `rollout-<ISO>-<uuid>.jsonl`.
fn resolve_codex_uuid(id: &str, sessions_root: &std::path::Path) -> Option<String> {
    let id = id.trim().trim_start_matches("codex:");
    if is_full_uuid(id) {
        return Some(id.to_string());
    }
    if id.len() < 8 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let tail = format!("{id}.jsonl");
    let mut stack = vec![(sessions_root.to_path_buf(), 0u8)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if depth < 4 {
                    stack.push((e.path(), depth + 1));
                }
            } else if name.starts_with("rollout-") && name.ends_with(&tail) {
                let stem = name.trim_end_matches(".jsonl");
                if stem.len() >= 36 && is_full_uuid(&stem[stem.len() - 36..]) {
                    return Some(stem[stem.len() - 36..].to_string());
                }
            }
        }
    }
    None
}

fn codex_sessions_root() -> PathBuf {
    let home = std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).unwrap_or_default()).join(".codex")
    });
    home.join("sessions")
}

/// Plain-English reason for a failed delivery (never a raw stack).
fn failure_reason(driver: &str, code: Option<i32>, stdout: &str, stderr: &str) -> String {
    let both = format!("{stdout}\n{stderr}");
    let lower = both.to_lowercase();
    if lower.contains("limit") || lower.contains("429") || lower.contains("usage") {
        let line = both
            .lines()
            .find(|l| l.to_lowercase().contains("limit") || l.to_lowercase().contains("usage"))
            .unwrap_or("");
        return format!(
            "{driver} is out of usage right now{}",
            if line.trim().is_empty() { String::new() } else { format!(": {}", clip(line, 160)) }
        );
    }
    if lower.contains("no conversation found") || lower.contains("not found") || lower.contains("no session") {
        return format!("{driver} couldn't find that session to continue it");
    }
    if lower.contains("login") || lower.contains("not logged in") || lower.contains("unauthorized") || lower.contains("401") {
        return format!("the {driver} CLI isn't signed in");
    }
    let first = both.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("no output");
    format!("{driver} exited {}: {}", code.map(|c| c.to_string()).unwrap_or_else(|| "early".into()), clip(first, 200))
}

/// Deliver `message` into an existing Claude Code or Codex session as a new turn and return
/// the session's reply. `cwd` is the session's own folder (resume runs where it ran).
#[tauri::command]
pub async fn session_deliver(driver: String, session_id: String, cwd: String, message: String) -> Result<Delivered, String> {
    let raw = session_id.trim().to_string();
    if raw.is_empty() || message.trim().is_empty() {
        return Err("nothing to deliver: a session id and a message are required".into());
    }
    if raw.contains("::cloud-") {
        return Err("that session runs in the cloud, not on this machine - Praxis can't reach it".into());
    }
    let sid = if driver == "codex" {
        let root = codex_sessions_root();
        let short = raw.clone();
        tokio::task::spawn_blocking(move || resolve_codex_uuid(&short, &root))
            .await
            .ok()
            .flatten()
            .ok_or_else(|| "Codex has no saved session with that id any more".to_string())?
    } else {
        raw.clone()
    };
    let codex_out = std::env::temp_dir().join(format!(
        "praxis-deliver-{}.txt",
        sid.replace(|c: char| !c.is_ascii_alphanumeric(), "")
    ));
    let mut cmd = match driver.as_str() {
        "claude" => {
            let mut c = make_async_cmd("claude");
            c.arg("-p")
                .arg(framed(&message))
                .arg("--resume")
                .arg(&sid)
                .arg("--output-format")
                .arg("json")
                .arg("--strict-mcp-config")
                .arg("--settings")
                .arg(HEADLESS_CLAUDE_SETTINGS)
                .arg("--dangerously-skip-permissions");
            c
        }
        "codex" => {
            let _ = std::fs::remove_file(&codex_out);
            let mut c = make_async_cmd("codex");
            // Options belong to the `resume` subcommand (codex exec resume --help, 2026-10-01).
            // The owner's config.toml starts MCP servers and hooks; a one-message turn skips them
            // and keeps the reasoning effort he set there (same as isolate_worker).
            c.arg("exec")
                .arg("resume")
                .arg("--skip-git-repo-check")
                .arg("--dangerously-bypass-approvals-and-sandbox")
                .arg("--ignore-user-config")
                .arg("-c")
                .arg("model_reasoning_effort=high")
                .arg("-o")
                .arg(&codex_out)
                .arg(&sid)
                .arg(framed(&message));
            c
        }
        "cursor" => {
            return Err("Cursor sessions can't take messages from Praxis yet - Cursor's CLI has no way to continue a chat".into())
        }
        other => return Err(format!("unknown session driver '{other}'")),
    };
    if !cwd.trim().is_empty() && std::path::Path::new(cwd.trim()).is_dir() {
        cmd.current_dir(cwd.trim());
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let child = cmd.spawn().map_err(|e| format!("couldn't start the {driver} CLI: {e}"))?;
    let out = match tokio::time::timeout(DELIVER_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("{driver} delivery failed: {e}")),
        Err(_) => {
            return Err(format!(
                "{driver} took over {} minutes to answer; stopped waiting",
                DELIVER_TIMEOUT.as_secs() / 60
            ))
        }
    };
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let reply: Option<(String, Option<String>)> = match driver.as_str() {
        "claude" if out.status.success() => claude_reply(&stdout),
        "codex" if out.status.success() => std::fs::read_to_string(&codex_out).ok().map(|t| (t, Some(sid.clone()))),
        _ => None,
    };
    let _ = std::fs::remove_file(&codex_out);
    match reply {
        Some((text, landed)) => {
            let landed = landed.unwrap_or_else(|| sid.clone());
            Ok(Delivered {
                forked: landed != sid,
                session_id: landed,
                reply: if text.trim().is_empty() { "(it replied with no text)".into() } else { clip(&text, REPLY_CHARS) },
            })
        }
        None => Err(failure_reason(&driver, out.status.code(), &stdout, &stderr)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_reply_reads_the_result_and_rejects_errors() {
        let ok = claude_reply(
            r#"{"type":"result","is_error":false,"result":"On it - renamed the file.","session_id":"00000000-0000-4000-8000-00000000000a"}"#,
        )
        .unwrap();
        assert_eq!(ok.0, "On it - renamed the file.");
        assert_eq!(ok.1.as_deref(), Some("00000000-0000-4000-8000-00000000000a"));
        assert!(claude_reply(r#"{"type":"result","is_error":true,"result":"You've hit your session limit"}"#).is_none());
        assert!(claude_reply("not json").is_none());
    }

    #[test]
    fn codex_card_ids_resolve_to_the_full_rollout_uuid() {
        let root = std::env::temp_dir().join(format!("praxis-deliver-test-{}", std::process::id()));
        let day = root.join("2026").join("10").join("01");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(day.join("rollout-2026-10-01T10-12-00-00000000-0000-7000-8000-00000000000b.jsonl"), "{}").unwrap();
        assert_eq!(
            resolve_codex_uuid("codex:00000000000b", &root).as_deref(),
            Some("00000000-0000-7000-8000-00000000000b")
        );
        assert_eq!(
            resolve_codex_uuid("00000000-0000-7000-8000-00000000000b", &root).as_deref(),
            Some("00000000-0000-7000-8000-00000000000b")
        );
        assert_eq!(resolve_codex_uuid("codex:ffffffffffff", &root), None);
        assert_eq!(resolve_codex_uuid("codex:../../etc", &root), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn failures_are_plain_english() {
        assert!(failure_reason("claude", Some(1), "", "You've hit your session limit · resets 9pm")
            .starts_with("claude is out of usage right now"));
        assert_eq!(
            failure_reason("codex", Some(1), "", "Error: no conversation found with id x"),
            "codex couldn't find that session to continue it"
        );
        assert_eq!(failure_reason("claude", Some(1), "", "Not logged in. Please run /login"), "the claude CLI isn't signed in");
        assert!(failure_reason("codex", Some(2), "", "boom").starts_with("codex exited 2: boom"));
    }

    #[test]
    fn messages_are_marked_as_zachs() {
        assert!(framed("  rename it  ").starts_with("[Message from Zach, sent from Praxis's Flight Deck]\nrename it"));
        assert_eq!(clip("abcdef", 4), "abc…");
    }
}
