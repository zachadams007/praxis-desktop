//! memory_todo.rs - read the intent ledger's "Open now" section for the Command
//! Center to-do list's "from memory" group.
//!
//! The owner's ask: the to-do panel should be BOTH a jot-pad (manual/voice tasks,
//! already wired in todoStore.ts) AND surface UPCOMING work pulled straight from
//! project memory, so he isn't maintaining two separate lists by hand.
//!
//! Source of truth: `C:\Users\dev\.claude\projects\C--Users-dev-Desktop-praxis\
//! memory\intent\INDEX.md`, section `## 🔴 Open now` - a recency window of the
//! most-recent 20 not-confirmed-done items, one bullet per line:
//!
//! ```md
//! ```
//!
//! Read-only - this module never writes the ledger.

use serde::Serialize;

/// Absolute path to the intent ledger index. Lives outside the repo (per-user
/// Claude Code project memory), same drive as the vault secrets file usage.rs
/// already reads from an absolute path - same pattern, different file.
const INTENT_INDEX_PATH: &str =
    r"C:\Users\dev\.claude\projects\C--Users-dev-Desktop-praxis\memory\intent\INDEX.md";

const OPEN_NOW_HEADING: &str = "## 🔴 Open now";

/// One "Open now" item surfaced to the Command Center to-do panel.
#[derive(Serialize, Clone)]
pub struct MemoryTodoItem {
    /// Status emoji as written in the ledger (🔜 / ❓ / 🚧 / ✅ / ⛔).
    pub status: String,
    /// ISO-ish date string as written (e.g. "2026-07-02").
    pub date: String,
    /// The bold title text only - no trailing detail, no markdown link.
    pub title: String,
}

/// Parse one "Open now" bullet line into a `MemoryTodoItem`.
///
/// Expected shape: `- <emoji> \`<date>\` **<title>**` optionally followed by
/// ` - <detail...>` or ` - [<title>](<path>)` (the topic-only rows). Returns
/// `None` for lines that don't match closely enough to trust (keeps this a
/// best-effort surface, never a crash or garbage row).
fn parse_open_now_line(line: &str) -> Option<MemoryTodoItem> {
    let line = line.trim();
    let rest = line.strip_prefix("- ")?;

    // Status emoji is the first whitespace-delimited token.
    let mut parts = rest.splitn(2, ' ');
    let status = parts.next()?.trim().to_string();
    let rest = parts.next()?.trim();

    // Date: `` `2026-07-02` `` - first backtick-delimited token.
    let after_backtick = rest.strip_prefix('`')?;
    let (date, rest) = after_backtick.split_once('`')?;
    let rest = rest.trim();

    // Title: bold `**...**` - first, since some rows are `**title** - [title](path)`
    // (the topic-only ❓ rows) and we only want the bold text, never the link.
    let after_bold_open = rest.strip_prefix("**")?;
    let (title, _tail) = after_bold_open.split_once("**")?;
    let title = title.trim();
    if title.is_empty() {
        return None;
    }

    Some(MemoryTodoItem {
        status,
        date: date.trim().to_string(),
        title: title.to_string(),
    })
}

/// Extract the `## 🔴 Open now` section body: every line between that heading
/// and the next `## ` heading (or end of file).
fn extract_open_now_section(content: &str) -> Vec<&str> {
    let mut in_section = false;
    let mut out = Vec::new();
    for line in content.lines() {
        if line.trim_start().starts_with(OPEN_NOW_HEADING) {
            in_section = true;
            continue;
        }
        if in_section && line.trim_start().starts_with("## ") {
            break;
        }
        if in_section {
            out.push(line);
        }
    }
    out
}

/// `memory_todo_open_now` - read + parse the intent ledger's "Open now" section.
///
/// Best-effort: missing file, unreadable path, or no matching section all return
/// `Ok(vec![])` rather than an error - the Command Center to-do panel treats an
/// empty "from memory" group as "nothing surfaced," not a broken feature. Real
/// I/O errors are swallowed here deliberately (mirrors usage.rs's read_vault_key
/// style) since this is a read-only convenience surface, not a critical path.
#[tauri::command]
pub fn memory_todo_open_now() -> Result<Vec<MemoryTodoItem>, String> {
    let content = match std::fs::read_to_string(INTENT_INDEX_PATH) {
        Ok(c) => c,
        Err(_) => return Ok(vec![]),
    };
    let section_lines = extract_open_now_section(&content);
    let items = section_lines
        .into_iter()
        .filter_map(parse_open_now_line)
        .collect();
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_standard_bullet() {
        let line = "- 🔜 `2026-07-02` **Praxis brain default → Kimi K2.6** — after Zach approves fleet table rev 2";
        let item = parse_open_now_line(line).expect("should parse");
        assert_eq!(item.status, "🔜");
        assert_eq!(item.date, "2026-07-02");
        assert_eq!(item.title, "Praxis brain default → Kimi K2.6");
    }

    #[test]
    fn parses_a_topic_link_bullet() {
        let line = "- ❓ `2026-07-02` **Use Fable 5 for high-level Praxis work** — [praxis-desktop-app.md](topics/praxis-desktop-app.md)";
        let item = parse_open_now_line(line).expect("should parse");
        assert_eq!(item.title, "Use Fable 5 for high-level Praxis work");
    }

    #[test]
    fn extracts_only_the_open_now_section() {
        let doc = "# Header\n\n## 🔴 Open now\n\n- 🔜 `2026-07-02` **A**\n- ❓ `2026-07-02` **B**\n\n## Topics\n- something else\n";
        let lines = extract_open_now_section(doc);
        let items: Vec<_> = lines.into_iter().filter_map(parse_open_now_line).collect();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "A");
        assert_eq!(items[1].title, "B");
    }

    #[test]
    fn ignores_non_bullet_lines() {
        assert!(parse_open_now_line("This is a description line, not a bullet.").is_none());
        assert!(parse_open_now_line("**Default work source when idle**").is_none());
    }
}
