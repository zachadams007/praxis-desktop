//! atlas_context.rs - the card that makes Atlas an agent OF Praxis, not a stranger at the mic.
//!
//! Each voice session now starts with this card as a system item (kept out of the stable
//! instructions so the provider's prompt cache still hits): who the owner is and his own contact
//! details, what the Memory Galaxy knows about him, and what Praxis is doing right now. Deeper
//! questions go through the `recall_memory` tool, which searches the same notes.
//!
//! Everything here is read from files already on this machine; nothing is guessed.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static CARD_CACHE: Mutex<Option<(u64, String)>> = Mutex::new(None);
const CARD_TTL_MS: u64 = 10 * 60 * 1000;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn home() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE").map(std::path::PathBuf::from)
}

fn read_json(path: std::path::PathBuf) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// The owner's own identity facts, from the accounts he is signed into on this machine.
pub(crate) fn identity_lines(claude_json: Option<&serde_json::Value>, cursor_cfg: Option<&serde_json::Value>) -> Vec<String> {
    let mut out = Vec::new();
    let acct = claude_json.and_then(|j| j.get("oauthAccount"));
    let name = acct
        .and_then(|a| a.get("fullName").or_else(|| a.get("displayName")))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty());
    if let Some(n) = name {
        out.push(format!("Name: {n}"));
    }
    if let Some(full) = cursor_cfg
        .and_then(|c| c.pointer("/authInfo/displayName"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| s.split_whitespace().count() >= 2 && Some(*s) != name)
    {
        out.push(format!("Full name: {full}"));
    }
    if let Some(e) = acct.and_then(|a| a.get("emailAddress")).and_then(|v| v.as_str()).filter(|s| s.contains('@')) {
        out.push(format!("Personal email: {e}"));
    }
    if let Some(e) = cursor_cfg
        .and_then(|c| c.pointer("/authInfo/email"))
        .and_then(|v| v.as_str())
        .filter(|s| s.contains('@'))
    {
        out.push(format!("Second email: {e}"));
    }
    out
}

/// The latest Praxis job, in one line.
pub(crate) fn latest_job_line(runs_jsonl: &str) -> Option<String> {
    let line = runs_jsonl.lines().rev().find(|l| !l.trim().is_empty())?;
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let goal: String = v.get("goal")?.as_str()?.chars().take(140).collect();
    let done = v.get("done").and_then(|d| d.as_bool()).unwrap_or(false);
    let ws = v.pointer("/build/workspace").and_then(|w| w.as_str()).unwrap_or("");
    Some(format!(
        "Latest Praxis job: \"{goal}\" — {}{}",
        if done { "finished and verified" } else { "not finished" },
        if ws.is_empty() { String::new() } else { format!(" (files in {ws})") }
    ))
}

/// The card, and whether it is complete. It is incomplete only in the first minute after
/// launch, while the notes are still being read: the card then goes out without the memory
/// section rather than making a voice session wait, and is not cached, so the next session
/// gets the whole thing.
async fn build_card() -> (String, bool) {
    let h = home();
    let claude_json = h.as_ref().and_then(|p| read_json(p.join(".claude.json")));
    let cursor_cfg = h.as_ref().and_then(|p| read_json(p.join(".cursor").join("cli-config.json")));
    let mut lines = vec![
        "CONTEXT FROM PRAXIS (private to this session; you are Praxis's agent and share its memory).".to_string(),
        "Zach's own details — use them whenever he asks (\"type my email\", \"fill in my name\") without asking him to spell them:".to_string(),
    ];
    let ident = identity_lines(claude_json.as_ref(), cursor_cfg.as_ref());
    if ident.is_empty() {
        lines.push("- (no account details found on this machine)".to_string());
    } else {
        lines.extend(ident.into_iter().map(|l| format!("- {l}")));
    }
    // What the Memory Galaxy knows about him, most relevant first.
    let warm = crate::memory_graph::recall_warm();
    if !warm {
        lines.push(
            "Memory Galaxy: still being read after Praxis started — call recall_memory for anything about him or his projects."
                .to_string(),
        );
    } else if let Ok(hits) = crate::memory_graph::memory_recall(
        "Zach profile identity education school projects preferences".to_string(),
        Some(6),
        Some(true),
    )
    .await
    {
        if !hits.is_empty() {
            lines.push("What the Memory Galaxy knows about him (use recall_memory for anything more):".to_string());
            for hit in hits.iter().take(6) {
                let desc = hit.description.clone().unwrap_or_default();
                let text = if desc.trim().is_empty() { hit.excerpt.chars().take(160).collect::<String>() } else { desc };
                lines.push(format!("- {}: {}", hit.label, text.split_whitespace().collect::<Vec<_>>().join(" ")));
            }
        }
    }
    if let Some(runs) = crate::praxis_dir().and_then(|d| std::fs::read_to_string(d.join("runs.jsonl")).ok()) {
        if let Some(job) = latest_job_line(&runs) {
            lines.push(job);
        }
    }
    (lines.join("\n"), warm)
}

/// The card for a new voice session (cached ten minutes so connecting never waits on it twice).
#[tauri::command]
pub async fn atlas_context_card() -> Result<String, String> {
    if let Ok(guard) = CARD_CACHE.lock() {
        if let Some((at, card)) = guard.as_ref() {
            if now_ms().saturating_sub(*at) < CARD_TTL_MS {
                return Ok(card.clone());
            }
        }
    }
    let (card, complete) = build_card().await;
    if complete {
        if let Ok(mut guard) = CARD_CACHE.lock() {
            *guard = Some((now_ms(), card.clone()));
        }
    }
    Ok(card)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn identity_comes_from_the_accounts_he_is_signed_into() {
        let claude = json!({ "oauthAccount": { "fullName": "Zach Adams", "emailAddress": "zach@example.com" } });
        let cursor = json!({ "authInfo": { "email": "second@example.com" } });
        let lines = identity_lines(Some(&claude), Some(&cursor));
        assert_eq!(lines, vec!["Name: Zach Adams", "Personal email: zach@example.com", "Second email: second@example.com"]);
        assert!(identity_lines(None, None).is_empty(), "nothing is invented when nothing is on disk");
        // Claude has only the short name; Cursor has the full one.
        let claude = json!({ "oauthAccount": { "fullName": "Zach", "emailAddress": "zach@example.com" } });
        let cursor = json!({ "authInfo": { "email": "second@example.com", "displayName": "Zachary Adams" } });
        let lines = identity_lines(Some(&claude), Some(&cursor));
        assert_eq!(&lines[..2], &["Name: Zach".to_string(), "Full name: Zachary Adams".to_string()]);
    }

    #[test]
    fn the_latest_job_is_one_plain_line() {
        let runs = "{\"goal\":\"old\",\"done\":false}\n{\"goal\":\"Create a personal website\",\"done\":true,\"build\":{\"workspace\":\"C:\\\\b\\\\site\"}}\n";
        let line = latest_job_line(runs).unwrap();
        assert!(line.starts_with("Latest Praxis job: \"Create a personal website\" — finished and verified"), "{line}");
        assert!(line.contains("C:\\b\\site"), "{line}");
    }
}
