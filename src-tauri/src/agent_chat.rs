//! Mirrors `skill_store.rs`'s shape exactly: one JSONL file per agent under
//! `%LOCALAPPDATA%\Praxis\agent-chats\<agent_id>.jsonl` (via `praxis_dir()` in lib.rs),
//! append-only, schema-loose (`serde_json::Value`) so the frontend owns the message
//! shape and can add fields without a Rust migration. Deliberately UI-agnostic - this
//! module knows nothing about the galaxy, the Command Center, or any specific caller,
//! so the same two commands serve the future Command Center chat surface too.
//!
//! Two commands:
//!   • `agent_chat_append(agent_id, role, text)` - append one message line.
//!   • `agent_chat_read(agent_id)` - read the full thread back, oldest-first.
//!
//! `agent_id` is sanitized to a safe filename component (agents are the fixed roster
//! ids like "a.forge" - already filename-safe - but any future free-form id is
//! defused rather than trusted verbatim as a path segment).

use std::io::{BufRead, Write};

/// One persisted chat line. `meta` is free-form (e.g. `{"operatorDirected":true}`)
/// so the frontend can tag operator-directed exchanges without a schema change here.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct AgentChatMessage {
    pub role: String, // "zach" | "agent"
    pub text: String,
    /// Unix epoch milliseconds (JS `Date.now()`) - set server-side so ordering is
    /// authoritative even if the caller's clock is odd.
    pub ts: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

/// `%LOCALAPPDATA%\Praxis\agent-chats\` - sibling of skills.jsonl/runs.jsonl.
fn chats_dir() -> Option<std::path::PathBuf> {
    crate::praxis_dir().map(|d| d.join("agent-chats"))
}

/// Defuse an agent id into a safe filename stem - strip anything that isn't
/// alnum/`.`/`_`/`-` so a stray path separator can never escape the chats dir.
fn safe_stem(agent_id: &str) -> String {
    let cleaned: String = agent_id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned
    }
}

fn chat_file_path(agent_id: &str) -> Option<std::path::PathBuf> {
    chats_dir().map(|d| d.join(format!("{}.jsonl", safe_stem(agent_id))))
}

/// Append one message to an agent's thread. `role` is stored verbatim (frontend
/// validates "zach"/"agent"); `meta` lets the caller tag operator-directed
/// exchanges (`{"operatorDirected":true}`) without a schema change.
#[tauri::command]
pub fn agent_chat_append(
    agent_id: String,
    role: String,
    text: String,
    meta: Option<serde_json::Value>,
) -> Result<(), String> {
    if agent_id.trim().is_empty() {
        return Err("agent_chat_append: empty agent_id".to_string());
    }
    let path = chat_file_path(&agent_id).ok_or_else(|| "LOCALAPPDATA not set".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("agent chat mkdir: {e}"))?;
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let msg = AgentChatMessage {
        role,
        text,
        ts,
        meta,
    };
    let line = serde_json::to_string(&msg).map_err(|e| format!("agent chat serialize: {e}"))?;

    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("agent chat open {}: {e}", path.display()))?;
    writeln!(f, "{line}").map_err(|e| format!("agent chat write {}: {e}", path.display()))?;
    Ok(())
}

/// Read an agent's full thread back, oldest-first (file append order). A missing
/// file (never chatted with this agent) is not an error - returns []. Corrupt/blank
/// lines are skipped so one bad append can't poison the whole thread.
///
/// Async + spawn_blocking: a synchronous command runs on the UI thread, and the Mission
/// thread (agent-chats/mission.jsonl) is read by every window at boot and only grows.
#[tauri::command]
pub async fn agent_chat_read(agent_id: String) -> Result<Vec<AgentChatMessage>, String> {
    tauri::async_runtime::spawn_blocking(move || read_thread(&agent_id))
        .await
        .map_err(|e| format!("agent chat read task: {e}"))?
}

fn read_thread(agent_id: &str) -> Result<Vec<AgentChatMessage>, String> {
    let path = chat_file_path(agent_id).ok_or_else(|| "LOCALAPPDATA not set".to_string())?;
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("agent chat open {}: {e}", path.display())),
    };

    let mut out = Vec::new();
    for line in std::io::BufReader::new(file).lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<AgentChatMessage>(trimmed) {
            Ok(m) => out.push(m),
            Err(_) => continue, // corrupt line - skip, don't fail the whole read
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real end-to-end proof against the REAL `%LOCALAPPDATA%\Praxis\agent-chats\`
    /// path (via `crate::praxis_dir()`, not a mock) - appends two lines for a
    /// throwaway test agent id, reads them back, asserts round-trip fidelity,
    /// then cleans up the file so repeat runs stay idempotent.
    #[test]
    fn agent_chat_append_and_read_round_trip() {
        let agent_id = "a.test-harness-agentchat";

        // Start clean in case a previous failed run left the file behind.
        if let Some(path) = chat_file_path(agent_id) {
            let _ = std::fs::remove_file(&path);
        }

        agent_chat_append(
            agent_id.to_string(),
            "zach".to_string(),
            "Forge, hold off on the vault migration until I say go.".to_string(),
            Some(serde_json::json!({"operatorDirected": true})),
        )
        .expect("append (zach) should succeed");

        agent_chat_append(
            agent_id.to_string(),
            "agent".to_string(),
            "Understood — pausing the vault migration until you confirm.".to_string(),
            Some(serde_json::json!({"kind": "default"})),
        )
        .expect("append (agent) should succeed");

        let thread = read_thread(agent_id).expect("read should succeed");
        assert_eq!(thread.len(), 2, "expected exactly 2 persisted messages");
        assert_eq!(thread[0].role, "zach");
        assert!(thread[0].text.contains("vault migration"));
        assert_eq!(thread[1].role, "agent");
        assert!(
            thread[0].ts <= thread[1].ts,
            "messages should be oldest-first"
        );

        // Print the raw file contents so the caller can quote a real JSONL line.
        if let Some(path) = chat_file_path(agent_id) {
            let raw = std::fs::read_to_string(&path).expect("file should be readable");
            println!("--- {} ---\n{}", path.display(), raw);
            let _ = std::fs::remove_file(&path); // cleanup
        }
    }
}
