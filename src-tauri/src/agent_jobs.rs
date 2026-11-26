//! agent_jobs.rs - every roster agent does a real job each day and leaves evidence.
//!
//! The 06:03 digest that morning answered him: Lens "idle, no QA passes tracked", Quill
//! "Standing is available", Relay "no board seat", and three builders padding with
//! readiness talk. The board asked language models to describe agents that had no work
//! feeding them, so they described availability.
//!
//! This module gives each of them a job with a real output, run right before the board
//! meeting (and on demand). Every job is local and free - no API spend, no window, no
//! focus change - and every result names the file it wrote or the ledger it read:
//!
//!   Lens    QA the most recently delivered build: headless Edge with real device emulation
//!           at 390 / 768 / 1440 px measures sideways overflow (naming the offending elements),
//!           broken images and JavaScript errors, saves full-page screenshots, and static checks
//!           (title, one h1, alt text, anchors that point nowhere, missing local files,
//!           placeholder text, viewport, lang). Writes LENS-QA.md into the build.
//!   Scribe  Memory Galaxy hygiene: counts orphan notes and suggests concrete links for the
//!           newest orphans from shared vocabulary. Writes a report; never edits the vault.
//!   Relay   The handoffs Praxis actually routed in the last 24h (agent, model, time, result).
//!   Hermes  The model calls actually made in the last 24h, by rail, from usage.jsonl.
//!   Forge / Vega / Quill
//!           Their real build steps in the last 24h (or the date of the last one) - facts
//!           the board states instead of "available".

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AgentJobResult {
    /// Fleet key: "lens", "scribe", "relay", "hermes", "forge", "vega", "quill".
    pub agent: String,
    pub job: String,
    pub ts: u64,
    /// False when the job itself could not run (not when it found problems).
    pub ok: bool,
    /// Board-ready facts, first person where natural. Never empty.
    pub bullets: Vec<String>,
    /// The file this job wrote or read, so the board can cite evidence.
    pub artifact: Option<String>,
    /// Build steps in the last 24h (builders only; 0 otherwise).
    #[serde(default)]
    pub recent_steps: u32,
    pub secs: f64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Local calendar date for a unix-ms instant (civil-from-days on local offset is not
/// available without chrono; UTC date is used only for file names, never spoken).
fn ymd(ms: u64) -> String {
    let days = (ms / DAY_MS) as i64;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn mins(secs: f64) -> String {
    if secs < 90.0 {
        format!("{secs:.0} s")
    } else {
        format!("{:.1} min", secs / 60.0)
    }
}

fn clip(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= n {
        s
    } else {
        format!("{}…", s.chars().take(n.saturating_sub(1)).collect::<String>().trim_end())
    }
}

// ── Ledger readers ────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StepFact {
    pub ts: u64,
    pub goal: String,
    pub tool: String,
    pub model: String,
    pub ok: bool,
    pub secs: f64,
    pub summary: String,
}

/// Every step of every run, newest run first (steps keep their order within a run).
pub(crate) fn parse_steps(runs_jsonl: &str) -> Vec<StepFact> {
    let mut out = Vec::new();
    for line in runs_jsonl.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let ts = v.get("ts").and_then(|x| x.as_u64()).unwrap_or(0);
        let goal = v.get("goal").and_then(|x| x.as_str()).unwrap_or("").to_string();
        for s in v.get("steps").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
            out.push(StepFact {
                ts,
                goal: goal.clone(),
                tool: s.get("tool").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                model: s.get("model").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                ok: s.get("ok").and_then(|x| x.as_bool()).unwrap_or(false),
                secs: s.get("secs").and_then(|x| x.as_f64()).unwrap_or(0.0),
                summary: s.get("summary").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            });
        }
    }
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    out
}

/// Group why steps failed into plain reasons with counts ("4× timed out after 30 min").
pub(crate) fn failure_reasons<'a>(failed: impl Iterator<Item = &'a StepFact>) -> Vec<String> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for s in failed {
        let l = s.summary.to_lowercase();
        let reason = if l.contains("timed out") || l.contains("did not finish in time") || l.contains("exceeded the del") {
            format!("timed out after {}", mins(s.secs.max(1.0)))
        } else if l.contains("session limit") || l.contains("usage limit") || l.contains("hit your") {
            "hit a usage limit".to_string()
        } else if l.contains("stopped:") || l.contains("halt") || l.contains("cancel") {
            "stopped by HALT or cancel".to_string()
        } else if l.contains("exited") {
            "the CLI exited with an error".to_string()
        } else if l.starts_with("praxis file check") {
            // A step the supervisor judged unfinished carries the workspace listing as its
            // summary; printing that as the "reason" (live on the 2026-09-17 board) says
            // nothing. Name what actually happened.
            "Praxis judged the work unfinished after re-prompting".to_string()
        } else if l.trim().is_empty() {
            "no reason recorded".to_string()
        } else {
            clip(&s.summary, 60)
        };
        match counts.iter_mut().find(|(r, _)| *r == reason) {
            Some(e) => e.1 += 1,
            None => counts.push((reason, 1)),
        }
    }
    counts.sort_by(|a, b| b.1.cmp(&a.1));
    counts.into_iter().take(3).map(|(r, n)| format!("{n}× {r}")).collect()
}

fn agent_name(tool: &str) -> &'static str {
    match tool {
        "claude" => "Forge",
        "codex" => "Vega",
        "cursor" => "Quill",
        _ => "an agent",
    }
}

/// Forge / Vega / Quill: their real steps. Pure, so it is tested.
pub(crate) fn builder_facts(agent: &str, tool: &str, steps: &[StepFact], now: u64) -> AgentJobResult {
    let mine: Vec<&StepFact> = steps.iter().filter(|s| s.tool == tool).collect();
    let recent: Vec<&StepFact> = mine.iter().copied().filter(|s| s.ts + DAY_MS >= now).collect();
    let mut bullets = Vec::new();
    if recent.is_empty() {
        match mine.first() {
            Some(last) => bullets.push(format!(
                "No build steps in the last 24h. Last one {}: {} for \"{}\" ({}, {}).",
                ymd(last.ts),
                if last.ok { "finished" } else { "did not finish" },
                clip(&last.goal, 70),
                if last.model.is_empty() { "default model" } else { &last.model },
                mins(last.secs)
            )),
            None => bullets.push("No build steps on record yet.".into()),
        }
    } else {
        let ok = recent.iter().filter(|s| s.ok).count();
        let total: f64 = recent.iter().map(|s| s.secs).sum();
        bullets.push(format!(
            "{} build step{} in the last 24h ({} of work): {ok} finished, {} did not.",
            recent.len(),
            if recent.len() == 1 { "" } else { "s" },
            mins(total),
            recent.len() - ok,
        ));
        let mut models: Vec<(String, usize, usize)> = Vec::new();
        for s in &recent {
            let m = if s.model.is_empty() { "default model".to_string() } else { s.model.clone() };
            match models.iter_mut().find(|(name, _, _)| *name == m) {
                Some(e) => {
                    e.1 += 1;
                    e.2 += usize::from(s.ok);
                }
                None => models.push((m, 1, usize::from(s.ok))),
            }
        }
        models.sort_by(|a, b| b.1.cmp(&a.1));
        bullets.push(format!(
            "By model: {}.",
            models.iter().map(|(m, n, k)| format!("{m} {k} of {n} finished")).collect::<Vec<_>>().join(" · ")
        ));
        let reasons = failure_reasons(recent.iter().copied().filter(|s| !s.ok));
        if !reasons.is_empty() {
            bullets.push(format!("Why steps did not finish: {}.", reasons.join("; ")));
        }
        let mut goals: Vec<&str> = recent.iter().map(|s| s.goal.as_str()).collect();
        goals.dedup();
        bullets.push(if goals.len() == 1 {
            format!("All for \"{}\".", clip(goals[0], 80))
        } else {
            format!("Across {} jobs; latest \"{}\".", goals.len(), clip(goals[0], 70))
        });
    }
    AgentJobResult {
        agent: agent.into(),
        job: "build steps".into(),
        ts: now,
        ok: true,
        bullets,
        artifact: crate::praxis_dir().map(|d| d.join("runs.jsonl").to_string_lossy().into_owned()),
        recent_steps: recent.len() as u32,
        secs: 0.0,
    }
}

/// Relay: the handoffs actually routed. Pure, so it is tested.
pub(crate) fn relay_handoffs(steps: &[StepFact], now: u64) -> AgentJobResult {
    let recent: Vec<&StepFact> = steps.iter().filter(|s| s.ts + DAY_MS >= now).collect();
    let mut bullets = Vec::new();
    if recent.is_empty() {
        match steps.first() {
            Some(last) => bullets.push(format!(
                "No handoffs in the last 24h. The last one ({}) went to {} on {}.",
                ymd(last.ts),
                agent_name(&last.tool),
                if last.model.is_empty() { "its default model" } else { &last.model }
            )),
            None => bullets.push("No handoffs on record yet.".into()),
        }
    } else {
        let count = |t: &str| recent.iter().filter(|s| s.tool == t).count();
        bullets.push(format!(
            "Routed {} handoff{} in the last 24h — Forge {}, Vega {}, Quill {}.",
            recent.len(),
            if recent.len() == 1 { "" } else { "s" },
            count("claude"),
            count("codex"),
            count("cursor")
        ));
        let failed: Vec<&StepFact> = recent.iter().copied().filter(|s| !s.ok).collect();
        if failed.is_empty() {
            bullets.push("Every handoff came back finished.".into());
        } else {
            for tool in ["claude", "codex", "cursor"] {
                let mine: Vec<&StepFact> = failed.iter().copied().filter(|s| s.tool == tool).collect();
                if mine.is_empty() {
                    continue;
                }
                bullets.push(format!(
                    "{} came back unfinished {}×: {}.",
                    agent_name(tool),
                    mine.len(),
                    failure_reasons(mine.iter().copied()).join("; ")
                ));
            }
        }
        let slowest = recent.iter().max_by(|a, b| a.secs.partial_cmp(&b.secs).unwrap_or(std::cmp::Ordering::Equal));
        if let Some(s) = slowest {
            bullets.push(format!("Longest handoff: {} on {}, {}.", agent_name(&s.tool), if s.model.is_empty() { "default" } else { &s.model }, mins(s.secs)));
        }
    }
    AgentJobResult {
        agent: "relay".into(),
        job: "handoff log".into(),
        ts: now,
        ok: true,
        bullets,
        artifact: crate::praxis_dir().map(|d| d.join("runs.jsonl").to_string_lossy().into_owned()),
        recent_steps: recent.len() as u32,
        secs: 0.0,
    }
}

/// Hermes: model calls actually made in the last 24h, from usage.jsonl. Pure, so it is tested.
pub(crate) fn hermes_calls(usage_jsonl: &str, now: u64) -> AgentJobResult {
    use std::collections::BTreeMap;
    let mut by_tool: BTreeMap<String, (u64, u64, f64)> = BTreeMap::new();
    for line in usage_jsonl.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let ts = v.get("ts").and_then(|x| x.as_u64()).unwrap_or(0);
        if ts + DAY_MS < now {
            continue;
        }
        let tool = v.get("tool").and_then(|x| x.as_str()).unwrap_or("unknown").to_string();
        let calls = v.get("calls").and_then(|x| x.as_u64()).unwrap_or(1);
        let tokens = v.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0) + v.get("output_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
        let cost = v.get("cost_usd").and_then(|x| x.as_f64()).unwrap_or(0.0);
        let e = by_tool.entry(tool).or_insert((0, 0, 0.0));
        e.0 += calls;
        e.1 += tokens;
        e.2 += cost;
    }
    let mut bullets = Vec::new();
    if by_tool.is_empty() {
        bullets.push("No model calls recorded in the last 24h.".into());
    } else {
        let total: u64 = by_tool.values().map(|v| v.0).sum();
        let parts: Vec<String> = by_tool
            .iter()
            .map(|(t, (c, tok, _))| format!("{t} {c} ({}K tokens)", tok / 1000))
            .collect();
        bullets.push(format!("{total} model calls in the last 24h: {}.", parts.join(", ")));
        let paid: f64 = by_tool.iter().filter(|(t, _)| matches!(t.as_str(), "openai" | "openrouter")).map(|(_, v)| v.2).sum();
        if paid > 0.0 {
            bullets.push(format!("Pay-per-token spend (OpenAI / OpenRouter API): ${paid:.2}."));
        }
    }
    AgentJobResult {
        agent: "hermes".into(),
        job: "model-call log".into(),
        ts: now,
        ok: true,
        bullets,
        artifact: crate::praxis_dir().map(|d| d.join("usage.jsonl").to_string_lossy().into_owned()),
        recent_steps: 0,
        secs: 0.0,
    }
}

// ── Lens: QA the most recently delivered build ───────────────────────────────

/// Static findings on an HTML page. Pure, so it is tested.
pub(crate) fn static_page_findings(html: &str, exists: &dyn Fn(&str) -> bool) -> Vec<String> {
    let lower = html.to_lowercase();
    let mut f = Vec::new();
    if !lower.contains("<title>") || lower.contains("<title></title>") {
        f.push("no <title>".to_string());
    }
    let h1 = lower.matches("<h1").count();
    if h1 != 1 {
        f.push(format!("{h1} <h1> elements (should be exactly one)"));
    }
    if !lower.contains("name=\"viewport\"") {
        f.push("no viewport meta tag (phones will render it zoomed out)".to_string());
    }
    if !lower.contains("<html lang=") {
        f.push("no lang attribute on <html>".to_string());
    }
    let imgs_without_alt = lower.split("<img").skip(1).filter(|tag| !tag.split('>').next().unwrap_or("").contains("alt=")).count();
    if imgs_without_alt > 0 {
        f.push(format!("{imgs_without_alt} image(s) without alt text"));
    }
    // ids on the page vs in-page anchors that point at them.
    let attr_values = |src: &str, attr: &str| -> Vec<String> {
        let needle = format!("{attr}=\"");
        src.match_indices(&needle)
            .filter_map(|(i, _)| {
                let rest = &src[i + needle.len()..];
                rest.find('"').map(|end| rest[..end].to_string())
            })
            .collect()
    };
    let ids: std::collections::HashSet<String> = attr_values(html, " id").into_iter().collect();
    let mut dead: Vec<String> = attr_values(html, "href")
        .into_iter()
        .filter(|h| h.len() > 1 && h.starts_with('#') && !ids.contains(&h[1..]))
        .collect();
    dead.sort();
    dead.dedup();
    if !dead.is_empty() {
        f.push(format!("in-page links to missing sections: {}", dead.iter().take(5).cloned().collect::<Vec<_>>().join(", ")));
    }
    let mut missing: Vec<String> = attr_values(html, "src")
        .into_iter()
        .chain(attr_values(html, "href"))
        .filter(|u| {
            let l = u.to_lowercase();
            !(l.is_empty() || l.starts_with('#') || l.starts_with("http:") || l.starts_with("https:") || l.starts_with("mailto:") || l.starts_with("tel:") || l.starts_with("data:") || l.starts_with("javascript:") || l.starts_with("//"))
        })
        .map(|u| u.split(['?', '#']).next().unwrap_or("").to_string())
        .filter(|u| !u.is_empty() && !exists(u))
        .collect();
    missing.sort();
    missing.dedup();
    if !missing.is_empty() {
        f.push(format!("files the page references but the folder lacks: {}", missing.iter().take(5).cloned().collect::<Vec<_>>().join(", ")));
    }
    for word in ["lorem ipsum", "todo", "placeholder", "your name here"] {
        // Visible text only would need a parser; attributes like placeholder="…" are legit.
        if word == "placeholder" {
            if lower.contains(">placeholder") || lower.contains("placeholder<") {
                f.push("visible placeholder text".to_string());
            }
        } else if lower.contains(word) {
            f.push(format!("contains \"{word}\""));
        }
    }
    f
}

fn edge_exe() -> Option<PathBuf> {
    ["ProgramFiles(x86)", "ProgramFiles"].iter().find_map(|var| {
        let p = PathBuf::from(std::env::var_os(var)?).join("Microsoft").join("Edge").join("Application").join("msedge.exe");
        p.exists().then_some(p)
    })
}

fn newest_delivered_build() -> Option<(PathBuf, u64)> {
    let root = std::env::var_os("PRAXIS_BUILDS_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("praxis-builds")))?;
    std::fs::read_dir(root)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.join("index.html").exists())
        .filter_map(|p| {
            let done = std::fs::metadata(p.join(".praxis-done")).ok()?.modified().ok()?;
            let ms = done.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
            Some((p, ms))
        })
        .max_by_key(|(_, ms)| *ms)
}

/// A headless Edge driven over the DevTools protocol - so Lens can EMULATE a phone.
///
/// WHY NOT `msedge --headless --window-size=390,… --screenshot` (the first version,
/// 2026-09-17): Chromium will not lay a headless window out narrower than its minimum
/// width, so the "390 px" screenshot was a wider layout cropped at 390 - headlines and
/// paragraphs looked cut off. Measured in a real 375 px viewport the same page had
/// scrollWidth 375 and nothing overflowing. A QA agent that shows defects that are not
/// there (or hides ones that are) is worse than none, so Lens now sets real device
/// metrics and MEASURES overflow instead of eyeballing a crop.
struct Cdp {
    ws: tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
    next: u64,
    console: Vec<String>,
}

impl Cdp {
    fn connect(ws_url: &str) -> Result<Cdp, String> {
        let (ws, _) = tungstenite::connect(ws_url).map_err(|e| format!("DevTools connect: {e}"))?;
        if let tungstenite::stream::MaybeTlsStream::Plain(tcp) = ws.get_ref() {
            let _ = tcp.set_read_timeout(Some(Duration::from_millis(500)));
        }
        Ok(Cdp { ws, next: 0, console: Vec::new() })
    }

    /// Read one frame; console errors and uncaught exceptions are collected on the way past.
    fn pump(&mut self) -> Option<serde_json::Value> {
        match self.ws.read() {
            Ok(tungstenite::Message::Text(t)) => {
                let v: serde_json::Value = serde_json::from_str(&t).ok()?;
                match v.get("method").and_then(|m| m.as_str()) {
                    Some("Runtime.exceptionThrown") => {
                        let d = &v["params"]["exceptionDetails"];
                        let text = d["exception"]["description"].as_str().or_else(|| d["text"].as_str()).unwrap_or("uncaught exception");
                        self.console.push(clip(text.lines().next().unwrap_or(text), 160));
                    }
                    Some("Runtime.consoleAPICalled") if v["params"]["type"] == "error" => {
                        let arg = v["params"]["args"][0]["value"].as_str().or_else(|| v["params"]["args"][0]["description"].as_str()).unwrap_or("console.error");
                        self.console.push(clip(arg, 160));
                    }
                    Some("Log.entryAdded") if v["params"]["entry"]["level"] == "error" => {
                        let text = v["params"]["entry"]["text"].as_str().unwrap_or("error");
                        self.console.push(clip(text, 160));
                    }
                    _ => {}
                }
                Some(v)
            }
            _ => None,
        }
    }

    fn call(&mut self, method: &str, params: serde_json::Value, wait: Duration) -> Result<serde_json::Value, String> {
        self.next += 1;
        let id = self.next;
        let msg = serde_json::json!({ "id": id, "method": method, "params": params }).to_string();
        self.ws.send(tungstenite::Message::Text(msg)).map_err(|e| format!("{method}: {e}"))?;
        let start = Instant::now();
        while start.elapsed() < wait {
            if let Some(v) = self.pump() {
                if v.get("id").and_then(|x| x.as_u64()) == Some(id) {
                    if let Some(err) = v.get("error") {
                        return Err(format!("{method}: {err}"));
                    }
                    return Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null));
                }
            }
        }
        Err(format!("{method}: no answer within {} s", wait.as_secs()))
    }

    fn wait_event(&mut self, method: &str, wait: Duration) -> bool {
        let start = Instant::now();
        while start.elapsed() < wait {
            if let Some(v) = self.pump() {
                if v.get("method").and_then(|m| m.as_str()) == Some(method) {
                    return true;
                }
            }
        }
        false
    }

    fn eval(&mut self, expression: &str) -> Result<serde_json::Value, String> {
        let r = self.call(
            "Runtime.evaluate",
            serde_json::json!({ "expression": expression, "awaitPromise": true, "returnByValue": true }),
            Duration::from_secs(30),
        )?;
        Ok(r["result"]["value"].clone())
    }
}

/// Minimal HTTP GET against the local DevTools endpoint.
///
/// Live 2026-09-17 the first version waited for the server to CLOSE the socket
/// (`read_to_string`), but Chromium's DevTools server keeps it open after answering, so every
/// Lens run hit the read timeout (os error 10060) with the answer already in hand. Read until
/// the Content-Length is satisfied instead.
fn http_get_local(port: u16, path: &str) -> Result<String, String> {
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").map_err(|e| e.to_string())?;
    let mut raw: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => raw.extend_from_slice(&chunk[..n]),
            Err(e) if raw.is_empty() => return Err(e.to_string()),
            Err(_) => break, // timed out with data in hand: check it below
        }
        let text = String::from_utf8_lossy(&raw);
        if let Some((head, body)) = text.split_once("\r\n\r\n") {
            let len = head
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().ok()))
                .flatten();
            if len.is_some_and(|n| body.len() >= n) {
                break;
            }
        }
    }
    let text = String::from_utf8_lossy(&raw).into_owned();
    text.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).ok_or_else(|| "DevTools answered without a body".to_string())
}

/// What Lens measured at one width.
struct WidthCheck {
    width: u32,
    overflow_px: i64,
    offenders: Vec<String>,
    broken_images: i64,
    screenshot: Option<PathBuf>,
}

/// Scroll the page once so scroll-triggered reveals run, then measure horizontal overflow
/// (and name the widest offenders) plus images that failed to load.
const MEASURE_JS: &str = r#"(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const h = document.documentElement.scrollHeight;
  for (let y = 0; y < h; y += Math.max(200, innerHeight / 2)) { scrollTo(0, y); await sleep(40); }
  scrollTo(0, 0); await sleep(400);
  const vw = document.documentElement.clientWidth;
  const offenders = [...document.querySelectorAll('body *')]
    .map((e) => [e, e.getBoundingClientRect()])
    .filter(([e, r]) => r.width > 0 && r.right > vw + 1 && getComputedStyle(e).position !== 'fixed')
    .sort((a, b) => b[1].right - a[1].right)
    .slice(0, 4)
    .map(([e, r]) => (e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/)[0] : '')) + ' +' + Math.round(r.right - vw) + 'px');
  return {
    overflow: document.documentElement.scrollWidth - vw,
    offenders,
    brokenImages: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length,
  };
})()"#;

fn cdp_page_checks(edge: &Path, page: &Path, qa_dir: &Path, profile: &Path) -> Result<(Vec<WidthCheck>, Vec<String>), String> {
    let _ = std::fs::remove_dir_all(profile);
    std::fs::create_dir_all(profile).map_err(|e| format!("profile dir: {e}"))?;
    let mut cmd = std::process::Command::new(edge);
    cmd.args([
        "--headless=new",
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-extensions",
        "--disable-gpu",
    ])
    .arg(format!("--user-data-dir={}", profile.to_string_lossy()))
    .arg("about:blank")
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not start Edge: {e}"))?;
    let result = (|| -> Result<(Vec<WidthCheck>, Vec<String>), String> {
        // Edge writes its DevTools port here once it is listening.
        let port_file = profile.join("DevToolsActivePort");
        let start = Instant::now();
        let port: u16 = loop {
            if let Some(p) = std::fs::read_to_string(&port_file).ok().and_then(|s| s.lines().next()?.trim().parse().ok()) {
                break p;
            }
            if start.elapsed() > Duration::from_secs(20) {
                return Err("headless Edge never opened its DevTools port".into());
            }
            std::thread::sleep(Duration::from_millis(200));
        };
        let targets: serde_json::Value = serde_json::from_str(&http_get_local(port, "/json/list")?).map_err(|e| format!("target list: {e}"))?;
        let ws_url = targets
            .as_array()
            .and_then(|a| a.iter().find(|t| t["type"] == "page"))
            .and_then(|t| t["webSocketDebuggerUrl"].as_str())
            .ok_or("no page target in headless Edge")?
            .to_string();
        let mut cdp = Cdp::connect(&ws_url)?;
        for m in ["Page.enable", "Runtime.enable", "Log.enable"] {
            cdp.call(m, serde_json::json!({}), Duration::from_secs(10))?;
        }
        let url = format!("file:///{}", page.to_string_lossy().replace('\\', "/"));
        let mut checks = Vec::new();
        for width in [390u32, 768, 1440] {
            let mobile = width < 700;
            cdp.call(
                "Emulation.setDeviceMetricsOverride",
                serde_json::json!({ "width": width, "height": if mobile { 844 } else { 900 }, "deviceScaleFactor": 1, "mobile": mobile }),
                Duration::from_secs(10),
            )?;
            cdp.call("Page.navigate", serde_json::json!({ "url": url }), Duration::from_secs(15))?;
            cdp.wait_event("Page.loadEventFired", Duration::from_secs(15));
            std::thread::sleep(Duration::from_millis(700));
            let m = cdp.eval(MEASURE_JS)?;
            let mut shot = None;
            if width != 768 {
                if let Ok(r) = cdp.call(
                    "Page.captureScreenshot",
                    serde_json::json!({ "format": "png", "captureBeyondViewport": true }),
                    Duration::from_secs(30),
                ) {
                    if let Some(b64) = r["data"].as_str() {
                        use base64::Engine;
                        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
                            let out = qa_dir.join(format!("lens-{width}.png"));
                            if std::fs::write(&out, bytes).is_ok() {
                                shot = Some(out);
                            }
                        }
                    }
                }
            }
            checks.push(WidthCheck {
                width,
                overflow_px: m["overflow"].as_i64().unwrap_or(0),
                offenders: m["offenders"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
                broken_images: m["brokenImages"].as_i64().unwrap_or(0),
                screenshot: shot,
            });
        }
        let _ = cdp.call("Browser.close", serde_json::json!({}), Duration::from_secs(3));
        let mut console = cdp.console.clone();
        console.sort();
        console.dedup();
        Ok((checks, console))
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn lens_site_qa(now: u64) -> AgentJobResult {
    let started = Instant::now();
    let mut result = AgentJobResult {
        agent: "lens".into(),
        job: "QA of the latest delivered build".into(),
        ts: now,
        ok: false,
        bullets: vec![],
        artifact: None,
        recent_steps: 0,
        secs: 0.0,
    };
    let Some((build, done_ms)) = newest_delivered_build() else {
        result.ok = true;
        result.bullets.push("No delivered build to QA yet (no praxis-builds folder with a finished site).".into());
        return result;
    };
    lens_qa_at(build, Some(done_ms), now, result, started)
}

/// Lens on ONE workspace - the daily job's target, or a build still in progress (the
/// orchestrator runs this before every verify so the verdict rests on a measured page, not
/// on an agent's description of one; live 2026-09-17 Forge, which cannot open a browser,
/// wrote a 46 KB VERIFICATION.md of guesses about rendering instead).
fn lens_qa_at(build: PathBuf, done_ms: Option<u64>, now: u64, mut result: AgentJobResult, started: Instant) -> AgentJobResult {
    let name = build.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let when = match done_ms {
        Some(ms) => format!("delivered {}", ymd(ms)),
        None => "in progress".to_string(),
    };
    let done_ms = done_ms.unwrap_or(now);
    let page = build.join("index.html");
    let html = std::fs::read_to_string(&page).unwrap_or_default();
    let base = build.clone();
    let findings = static_page_findings(&html, &|rel: &str| base.join(rel.trim_start_matches("./")).exists());
    let qa_dir = build.join(".praxis-qa");
    let _ = std::fs::create_dir_all(&qa_dir);
    let profile = crate::praxis_dir().unwrap_or_else(std::env::temp_dir).join("agent-jobs").join("lens-edge-profile");

    let rendered = match edge_exe() {
        Some(edge) => cdp_page_checks(&edge, &page, &qa_dir, &profile),
        None => Err("Microsoft Edge was not found".into()),
    };
    let mut issues = findings.len();
    let mut lines: Vec<String> = Vec::new();
    match &rendered {
        Ok((checks, console)) => {
            result.ok = true;
            let overflowing: Vec<&WidthCheck> = checks.iter().filter(|c| c.overflow_px > 1).collect();
            let broken: i64 = checks.iter().map(|c| c.broken_images).max().unwrap_or(0);
            issues += overflowing.len() + console.len() + usize::from(broken > 0);
            result.bullets.push(format!(
                "QA'd {name} ({when}) in a real browser at phone, tablet and desktop width (390 / 768 / 1440 px): {} issue{}.",
                issues,
                if issues == 1 { "" } else { "s" }
            ));
            if overflowing.is_empty() {
                result.bullets.push("No sideways scrolling at any width — nothing spills past the screen edge.".into());
            }
            for c in &overflowing {
                result.bullets.push(format!("At {} px the page is {} px wider than the screen: {}.", c.width, c.overflow_px, c.offenders.join(", ")));
            }
            if broken > 0 {
                result.bullets.push(format!("{broken} image(s) failed to load."));
            }
            if console.is_empty() {
                result.bullets.push("No JavaScript errors while it loaded and scrolled.".into());
            } else {
                result.bullets.push(format!("JavaScript error: {}", console[0]));
            }
            for c in checks {
                lines.push(format!(
                    "- {} px: overflow {} px{}{}{}",
                    c.width,
                    c.overflow_px.max(0),
                    if c.offenders.is_empty() { String::new() } else { format!(" ({})", c.offenders.join(", ")) },
                    if c.broken_images > 0 { format!(", {} broken image(s)", c.broken_images) } else { String::new() },
                    c.screenshot.as_ref().map(|p| format!(" — full-page screenshot `{}`", p.to_string_lossy())).unwrap_or_default()
                ));
            }
            if !console.is_empty() {
                lines.push(String::new());
                lines.push("### JavaScript errors".into());
                lines.extend(console.iter().map(|c| format!("- {c}")));
            }
        }
        Err(e) => {
            // The static checks still ran; say plainly that the browser part did not.
            result.ok = !html.is_empty();
            result.bullets.push(format!("QA'd {name} ({when}): the browser render could not run ({e})."));
            lines.push(format!("- browser render failed: {e}"));
        }
    }
    if findings.is_empty() {
        result.bullets.push("Static checks clean: title, one h1, viewport, lang, alt text, in-page links, local files, no placeholder text.".into());
    } else {
        result.bullets.push(format!("Static checks: {}.", findings.join("; ")));
    }
    let body = format!(
        "# Lens QA — {}\n\nBuild: `{}`\nDelivered: {}\n\n## Browser checks (headless Microsoft Edge, device emulation)\n{}\n\n## Static checks\n{}\n",
        ymd(now),
        build.to_string_lossy(),
        ymd(done_ms),
        lines.join("\n"),
        if findings.is_empty() { "- all clean".to_string() } else { findings.iter().map(|x| format!("- {x}")).collect::<Vec<_>>().join("\n") },
    );
    let report = build.join("LENS-QA.md");
    if std::fs::write(&report, body).is_ok() {
        result.artifact = Some(report.to_string_lossy().into_owned());
    }
    result.secs = started.elapsed().as_secs_f64();
    result
}


// ── Scribe: Memory Galaxy hygiene ────────────────────────────────────────────

const STOP: &[&str] = &[
    "about", "after", "again", "also", "because", "before", "being", "between", "could", "every", "from", "have", "into",
    "just", "like", "more", "most", "must", "never", "only", "other", "over", "should", "some", "than", "that", "their",
    "them", "then", "there", "these", "they", "this", "those", "through", "under", "until", "very", "what", "when",
    "where", "which", "while", "with", "without", "would", "your", "zach", "zachs", "praxis", "note", "notes", "memory",
];

pub(crate) fn tokens(s: &str) -> std::collections::BTreeSet<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .map(|w| w.to_lowercase())
        .filter(|w| w.len() >= 4 && !STOP.contains(&w.as_str()) && !w.chars().all(|c| c.is_ascii_digit()))
        .collect()
}

/// Suggested links for orphans: (orphan index, target index, shared words). Pure, tested.
pub(crate) fn suggest_links(orphans: &[(String, String)], linked: &[(String, String)], per_orphan: usize) -> Vec<(usize, usize, Vec<String>)> {
    let linked_tokens: Vec<_> = linked.iter().map(|(l, d)| tokens(&format!("{l} {d}"))).collect();
    let orphan_tokens: Vec<_> = orphans.iter().map(|(l, d)| tokens(&format!("{l} {d}"))).collect();
    // Rare words carry the meaning. Live 2026-09-17 plain overlap paired "Hermes: Environment
    // Notes" with an unrelated chat note on "codex, complete, doing" - words half the vault
    // uses. Weight every shared word by how rare it is (IDF) and require real weight.
    let docs = (linked_tokens.len() + orphan_tokens.len()).max(1) as f64;
    let mut df: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for t in linked_tokens.iter().chain(orphan_tokens.iter()) {
        for w in t {
            *df.entry(w.as_str()).or_insert(0) += 1;
        }
    }
    let idf = |w: &str| (docs / (*df.get(w).unwrap_or(&1) as f64)).ln();
    let common = |w: &str| {
        let d = *df.get(w).unwrap_or(&0);
        d >= 5 && d as f64 / docs > 0.04
    };
    let mut out = Vec::new();
    for (oi, ot) in orphan_tokens.iter().enumerate() {
        if ot.len() < 2 {
            continue;
        }
        let own: f64 = ot.iter().map(|w| idf(w)).sum::<f64>().max(1e-9);
        let mut scored: Vec<(f64, usize, Vec<String>)> = linked_tokens
            .iter()
            .enumerate()
            .filter_map(|(li, lt)| {
                let shared: Vec<String> = ot.intersection(lt).filter(|w| !common(w)).cloned().collect();
                if shared.len() < 2 {
                    return None;
                }
                let weight: f64 = shared.iter().map(|w| idf(w)).sum();
                Some((weight / own, li, shared))
            })
            .filter(|(score, _, _)| *score >= 0.25)
            .collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        for (_, li, shared) in scored.into_iter().take(per_orphan) {
            out.push((oi, li, shared));
        }
    }
    out
}

fn is_galaxy_note(node: &serde_json::Value) -> bool {
    node.get("kind").and_then(|k| k.as_str()) != Some("hub")
}

fn galaxy_census_line(nodes: &[serde_json::Value], links: usize) -> String {
    let notes = nodes.iter().filter(|n| is_galaxy_note(n)).count();
    format!("{} nodes ({} notes + {} area hubs), {} links in the Memory Galaxy. Orphan counts exclude hubs.", nodes.len(), notes, nodes.len() - notes, links)
}

fn orphan_kind_line<'a>(kinds: impl Iterator<Item = &'a str>) -> String {
    let mut counts = std::collections::BTreeMap::<&str, usize>::new();
    for kind in kinds {
        *counts.entry(if kind.is_empty() { "unknown" } else { kind }).or_default() += 1;
    }
    let mut by_kind: Vec<_> = counts.into_iter().collect();
    by_kind.sort_by(|a, b| b.1.cmp(&a.1));
    let mut parts: Vec<_> = by_kind.iter().take(4).map(|(k, n)| format!("{n} {k}{}", if *n == 1 { "" } else { "s" })).collect();
    let other: usize = by_kind.iter().skip(4).map(|(_, n)| n).sum();
    if other > 0 {
        parts.push(format!("{other} other"));
    }
    format!("Orphans by kind: {}.", if parts.is_empty() { "0".to_string() } else { parts.join(" · ") })
}

fn scribe_galaxy_hygiene(now: u64) -> AgentJobResult {
    let started = Instant::now();
    let mut result = AgentJobResult {
        agent: "scribe".into(),
        job: "Memory Galaxy hygiene".into(),
        ts: now,
        ok: false,
        bullets: vec![],
        artifact: None,
        recent_steps: 0,
        secs: 0.0,
    };
    let Some(dir) = crate::praxis_dir() else {
        result.bullets.push("Could not find Praxis's data folder.".into());
        return result;
    };
    let graph: serde_json::Value = match std::fs::read_to_string(dir.join("memory-graph.json")).ok().and_then(|s| serde_json::from_str(&s).ok()) {
        Some(g) => g,
        None => {
            result.bullets.push("The Memory Galaxy graph hasn't been built yet — nothing to organize.".into());
            return result;
        }
    };
    let nodes = graph.get("nodes").and_then(|n| n.as_array()).cloned().unwrap_or_default();
    struct N {
        label: String,
        desc: String,
        path: String,
        kind: String,
        orphan: bool,
        mtime: u64,
    }
    /// Notes Scribe may suggest links between. A `conversation` node is a session
    /// transcript (live 2026-09-17 the top suggestion paired a "Reply with exactly READY."
    /// smoke-test transcript with a real note) - it is history, not something to link.
    fn linkable(kind: &str) -> bool {
        matches!(kind, "note" | "idea" | "reference" | "task")
    }
    let all: Vec<N> = nodes
        .iter()
        // Same definition as the board's vault census (board_meeting.rs read_vault_stats):
        // hubs are structure, not notes; an orphan is a note with degree 0. Two different
        // orphan counts on one board would be a contradiction the owner has to resolve.
        .filter(|n| is_galaxy_note(n))
        .map(|n| {
            let path = n.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string();
            let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            N {
                label: n.get("label").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                desc: n.get("description").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                path,
                kind: n.get("kind").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                orphan: n.get("degree").and_then(|x| x.as_u64()).unwrap_or(1) == 0,
                mtime,
            }
        })
        .collect();
    let mut orphans: Vec<&N> = all.iter().filter(|n| n.orphan).collect();
    orphans.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    let newest: Vec<&N> = orphans.iter().copied().filter(|n| linkable(&n.kind)).take(15).collect();
    let linked: Vec<&N> = all.iter().filter(|n| !n.orphan && linkable(&n.kind)).collect();
    let suggestions = suggest_links(
        &newest.iter().map(|n| (n.label.clone(), n.desc.clone())).collect::<Vec<_>>(),
        &linked.iter().map(|n| (n.label.clone(), n.desc.clone())).collect::<Vec<_>>(),
        2,
    );
    let jobs_dir = dir.join("agent-jobs").join("scribe");
    let _ = std::fs::create_dir_all(&jobs_dir);
    // The previous report's count, for the trend line.
    let previous = std::fs::read_dir(&jobs_dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("galaxy-hygiene-") && !n.to_string_lossy().contains(&ymd(now))))
        .max()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| s.lines().find_map(|l| l.strip_prefix("Orphans: ").and_then(|r| r.split_whitespace().next()?.parse::<usize>().ok())));
    let covered: std::collections::BTreeSet<usize> = suggestions.iter().map(|(o, _, _)| *o).collect();
    let census = galaxy_census_line(&nodes, graph.get("edges").and_then(|e| e.as_array()).map_or(0, |e| e.len()));
    let breakdown = orphan_kind_line(orphans.iter().map(|n| n.kind.as_str()));
    let mut lines = vec![
        format!("# Memory Galaxy hygiene — {}", ymd(now)),
        String::new(),
        format!("Orphans: {} of {} notes", orphans.len(), all.len()),
        census.clone(),
        breakdown.clone(),
        String::new(),
        "## Suggested links for the newest orphan notes".to_string(),
        "Each line is a suggestion only — nothing in the vault was changed.".to_string(),
        String::new(),
    ];
    for (oi, n) in newest.iter().enumerate() {
        let mine: Vec<_> = suggestions.iter().filter(|(o, _, _)| *o == oi).collect();
        if mine.is_empty() {
            lines.push(format!("- **{}** (`{}`) — no confident match; it may need a new hub.", n.label, n.path));
        }
        for (_, li, shared) in mine {
            let t = linked[*li];
            lines.push(format!("- **{}** → link to **{}** (`{}`) · shared: {}", n.label, t.label, t.path, shared.join(", ")));
        }
    }
    let report = jobs_dir.join(format!("galaxy-hygiene-{}.md", ymd(now)));
    if std::fs::write(&report, lines.join("\n")).is_ok() {
        result.artifact = Some(report.to_string_lossy().into_owned());
    }
    result.ok = true;
    let pct = if all.is_empty() { 0.0 } else { orphans.len() as f64 * 100.0 / all.len() as f64 };
    // What KIND of thing is unlinked matters: an unlinked note is work to do, an unlinked
    // session transcript is just history.
    result.bullets.push(census);
    result.bullets.push(breakdown);
    result.bullets.push(format!(
        "{} of {} Memory Galaxy notes are orphans ({pct:.0}%){}.",
        orphans.len(),
        all.len(),
        match previous {
            Some(p) if p > orphans.len() => format!(", down from {p}"),
            Some(p) if p < orphans.len() => format!(", up from {p}"),
            Some(_) => ", unchanged".to_string(),
            None => String::new(),
        }
    ));
    result.bullets.push(format!(
        "Suggested concrete links for {} of the {} newest orphans (report written, vault untouched).",
        covered.len(),
        newest.len()
    ));
    if let Some((oi, li, shared)) = suggestions.first() {
        result.bullets.push(format!(
            "Example: \"{}\" belongs next to \"{}\" (shared: {}).",
            clip(&newest[*oi].label, 50),
            clip(&linked[*li].label, 50),
            shared.iter().take(3).cloned().collect::<Vec<_>>().join(", ")
        ));
    }
    result.secs = started.elapsed().as_secs_f64();
    result
}

// ── Orchestration + record ───────────────────────────────────────────────────

fn record(results: &[AgentJobResult]) {
    use std::io::Write;
    let Some(dir) = crate::praxis_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("agent-jobs.jsonl")) {
        for r in results {
            if let Ok(line) = serde_json::to_string(r) {
                let _ = writeln!(f, "{line}");
            }
        }
    }
}

pub(crate) fn run_all() -> Vec<AgentJobResult> {
    let now = now_ms();
    let dir = crate::praxis_dir();
    let runs = dir.as_ref().and_then(|d| std::fs::read_to_string(d.join("runs.jsonl")).ok()).unwrap_or_default();
    let usage = dir.as_ref().and_then(|d| std::fs::read_to_string(d.join("usage.jsonl")).ok()).unwrap_or_default();
    let steps = parse_steps(&runs);
    let results = vec![
        builder_facts("forge", "claude", &steps, now),
        builder_facts("vega", "codex", &steps, now),
        builder_facts("quill", "cursor", &steps, now),
        lens_site_qa(now),
        scribe_galaxy_hygiene(now),
        relay_handoffs(&steps, now),
        hermes_calls(&usage, now),
    ];
    record(&results);
    results
}

/// Lens on a build that is still in progress: the orchestrator calls this before every
/// verify, so the verdict (and any corrective step) rests on a page measured in a real
/// browser - overflow, broken images, JavaScript errors, static checks.
#[tauri::command]
pub async fn lens_qa_workspace(path: String) -> Result<AgentJobResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let build = PathBuf::from(path.trim());
        if !build.join("index.html").exists() {
            return Err(format!("no index.html in {}", build.display()));
        }
        let now = now_ms();
        let result = AgentJobResult {
            agent: "lens".into(),
            job: "QA of the build in progress".into(),
            ts: now,
            ok: false,
            bullets: vec![],
            artifact: None,
            recent_steps: 0,
            secs: 0.0,
        };
        Ok(lens_qa_at(build, None, now, result, Instant::now()))
    })
    .await
    .map_err(|e| format!("lens join failed: {e}"))?
}

/// Run every agent's daily job now and return what each one did. Called right before
/// the board meeting, and on demand.
#[tauri::command]
pub async fn agent_jobs_run_daily() -> Result<Vec<AgentJobResult>, String> {
    tauri::async_runtime::spawn_blocking(run_all)
        .await
        .map_err(|e| format!("agent jobs join failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orphan_breakdown_includes_all_six_kinds() {
        let counts = [("note", 144), ("idea", 86), ("reference", 54), ("conversation", 14), ("task", 6), ("project", 4)];
        let line = orphan_kind_line(counts.iter().flat_map(|(kind, count)| std::iter::repeat(*kind).take(*count)));
        assert_eq!(line, "Orphans by kind: 144 notes · 86 ideas · 54 references · 14 conversations · 10 other.");
        let sum: usize = line.strip_prefix("Orphans by kind: ").unwrap().split(" · ").map(|part| part.split_whitespace().next().unwrap().trim_end_matches('.').parse::<usize>().unwrap()).sum();
        assert_eq!(sum, counts.iter().map(|(_, count)| count).sum::<usize>());
        assert_eq!(orphan_kind_line(std::iter::empty()), "Orphans by kind: 0.");
        assert_eq!(orphan_kind_line(["", "note"].into_iter()), "Orphans by kind: 1 note · 1 unknown.");
    }

    #[test]
    fn galaxy_census_explains_notes_and_area_hubs_from_one_snapshot() {
        let mut nodes = vec![serde_json::json!({"kind": "note"}); 1200];
        nodes.extend(vec![serde_json::json!({"kind": "hub"}); 7]);
        assert_eq!(galaxy_census_line(&nodes, 3022), "1207 nodes (1200 notes + 7 area hubs), 3022 links in the Memory Galaxy. Orphan counts exclude hubs.");
        nodes.push(serde_json::json!({"kind": "conversation"}));
        nodes.push(serde_json::json!({}));
        assert!(galaxy_census_line(&nodes, 3022).starts_with("1209 nodes (1202 notes + 7 area hubs)"));
        assert!(galaxy_census_line(&[], 0).starts_with("0 nodes (0 notes + 0 area hubs), 0 links"));
    }

    fn step(ts: u64, tool: &str, ok: bool, secs: f64) -> StepFact {
        StepFact { ts, goal: "Create a personal website".into(), tool: tool.into(), model: "composer-2.5".into(), ok, secs, summary: "timed out after 1800s".into() }
    }

    #[test]
    fn a_builder_with_recent_steps_reports_them_not_availability() {
        let now = 10 * DAY_MS;
        let steps = vec![step(now - 1000, "cursor", true, 195.0), step(now - 2000, "claude", false, 1801.0)];
        let q = builder_facts("quill", "cursor", &steps, now);
        assert_eq!(q.recent_steps, 1);
        assert!(q.bullets[0].starts_with("1 build step in the last 24h") && q.bullets[0].contains("1 finished, 0 did not"), "{:?}", q.bullets);
        assert!(q.bullets.iter().any(|b| b == "By model: composer-2.5 1 of 1 finished."), "{:?}", q.bullets);
        assert!(q.bullets.iter().all(|b| !b.to_lowercase().contains("available")));
        let f = builder_facts("forge", "claude", &steps, now);
        assert!(f.bullets.iter().any(|b| b.starts_with("Why steps did not finish: 1× timed out after 30.0 min")), "{:?}", f.bullets);
    }

    #[test]
    fn a_quiet_builder_names_its_last_real_step_with_a_date() {
        let now = 10 * DAY_MS;
        let steps = vec![step(now - 3 * DAY_MS, "codex", true, 354.0)];
        let v = builder_facts("vega", "codex", &steps, now);
        assert_eq!(v.recent_steps, 0);
        assert!(v.bullets[0].starts_with("No build steps in the last 24h. Last one 1970-01-08"), "{:?}", v.bullets);
    }

    #[test]
    fn relay_counts_real_handoffs_and_names_failures() {
        let now = 10 * DAY_MS;
        let steps = vec![step(now - 10, "codex", true, 354.0), step(now - 10, "cursor", false, 1801.0), step(now - 10, "claude", true, 185.0)];
        let r = relay_handoffs(&steps, now);
        assert!(r.bullets[0].contains("Routed 3 handoffs") && r.bullets[0].contains("Vega 1"), "{:?}", r.bullets);
        assert!(r.bullets.iter().any(|b| b.starts_with("Quill came back unfinished 1×: 1× timed out")), "{:?}", r.bullets);
    }

    #[test]
    fn hermes_counts_calls_and_only_calls_api_rows_spend() {
        let now = 10 * DAY_MS;
        let usage = format!(
            "{{\"ts\":{},\"tool\":\"codex\",\"calls\":1,\"input_tokens\":25000,\"output_tokens\":100,\"cost_usd\":0.026}}\n{{\"ts\":{},\"tool\":\"openai\",\"calls\":1,\"input_tokens\":4000,\"output_tokens\":600,\"cost_usd\":0.07}}\n{{\"ts\":1,\"tool\":\"claude\",\"calls\":9}}",
            now - 5,
            now - 5
        );
        let h = hermes_calls(&usage, now);
        assert!(h.bullets[0].starts_with("2 model calls in the last 24h"), "{:?}", h.bullets);
        assert!(h.bullets.iter().any(|b| b.contains("$0.07")), "{:?}", h.bullets);
    }

    #[test]
    fn static_checks_catch_dead_anchors_missing_files_and_missing_alt() {
        let html = r##"<html lang="en"><head><title>Zach</title><meta name="viewport" content="x"></head>
            <body><h1>Hi</h1><a href="#work">Work</a><a href="#about">About</a><section id="work"></section>
            <img src="me.jpg"><script src="script.js"></script></body></html>"##;
        let f = static_page_findings(html, &|rel| rel == "script.js");
        assert!(f.iter().any(|x| x.contains("#about")), "{f:?}");
        assert!(f.iter().any(|x| x.contains("me.jpg")), "{f:?}");
        assert!(f.iter().any(|x| x.contains("without alt")), "{f:?}");
        assert!(!f.iter().any(|x| x.contains("#work")), "{f:?}");
        let clean = r##"<html lang="en"><head><title>Z</title><meta name="viewport" content="x"></head><body><h1>Z</h1><img src="a.png" alt="a"></body></html>"##;
        assert!(static_page_findings(clean, &|_| true).is_empty());
    }

    #[test]
    fn scribe_suggests_links_only_on_real_shared_vocabulary() {
        let orphans = vec![
            ("Cursor agent grok high is slow".to_string(), "Quill cap-outs were slow model turns in cursor-agent".to_string()),
            ("Groceries".to_string(), "milk".to_string()),
        ];
        let linked = vec![
            ("Cursor model routing".to_string(), "route Quill mechanical work to composer, grok for quality cursor-agent".to_string()),
            ("Trading bot lanes".to_string(), "futures scalping".to_string()),
        ];
        let s = suggest_links(&orphans, &linked, 2);
        assert!(s.iter().any(|(o, l, _)| *o == 0 && *l == 0), "{s:?}");
        assert!(!s.iter().any(|(o, _, _)| *o == 1), "a note with nothing in common gets no invented link");
    }
}
