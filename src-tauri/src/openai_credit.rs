//! openai_credit.rs - durable, self-retiring evidence about OpenAI credit refusals.
//!
//! WHY THIS EXISTS (2026-09-15).
//!
//! That fiction is dangerous in BOTH directions:
//!   - It can say "you have money" while every call is refused (what happened at 19:19).
//!   - It can say "you're nearly out" while the account is fine (what was true at 19:22).
//!
//! So Praxis stops guessing and reports only what it has actually observed. The one
//! thing an API key CAN prove is what happened on the last call: a 429 carrying
//! `insufficient_quota` / `credit_balance_exhausted` is OpenAI itself saying the wallet
//! is empty, and any 2xx is OpenAI itself saying it is not. This module persists that
//! observation so the rail can say "NO CREDIT · calls refused since 7:19 PM" - a claim
//! about a measurement, with a timestamp, rather than a claim about a balance.
//!
//! NOT A LATCH - the #1 defect class in this codebase (see the memory note
//! "guards that latch and never revalidate"). Three independent ways out, so a stamp
//! can never outlive the condition it described:
//!   1. **Success clears it.** Any successful OpenAI call anywhere - brain, realtime
//!      mint, TTS - calls `clear_openai_credit_block()`. Success is proof.
//!   2. **The gate revalidates on its own.** `blocks_paid_calls()` stops returning true
//!      `REVALIDATE_AFTER_MS` after the refusal, so the very next Ctrl+T genuinely
//!      re-tries the paid rail instead of assuming. That retry is what produces the
//!      success in (1). A gate that never retries can never discover it is wrong.
//!   3. **Stale evidence expires.** Evidence older than `MAX_EVIDENCE_AGE_MS` is spent
//!      and reports nothing at all, so a stamp left by a long-dead session cannot
//!      caption today's rail.
//!
//! `consecutive` is a COUNT, not a bool that is only ever set true - it says how many
//! refusals in a row have been observed, and it resets to zero on success.

use serde::{Deserialize, Serialize};

/// How long one refusal suppresses the paid rail before Praxis retries it for real.
/// Matches the 5-minute TTL `src/voice/realtimeTransport.ts` already applied in-memory;
/// this is the durable version of the same window, so it survives a webview reload.
const REVALIDATE_AFTER_MS: u64 = 5 * 60 * 1000;

/// Evidence older than this is spent and reports nothing - the same "an elapsed
/// window is spent evidence" rule `codex_usage::codex_quota_state_from` applies.
/// A refusal nobody has revisited in a day says nothing useful about right now.
const MAX_EVIDENCE_AGE_MS: u64 = 24 * 60 * 60 * 1000;

/// `%LOCALAPPDATA%\Praxis\openai-credit.json` - sibling of codex-quota.json.
fn credit_state_path() -> Option<std::path::PathBuf> {
    crate::praxis_dir().map(|d| d.join("openai-credit.json"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// What OpenAI last told us about this key's ability to pay for a call.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct OpenAiCreditState {
    #[serde(default)]
    pub schema_version: u32,
    /// True when the last observed outcome was a credit refusal.
    #[serde(default)]
    pub refused: bool,
    /// When Praxis observed it, Unix ms.
    #[serde(default)]
    pub detected_ms: u64,
    /// How many refusals in a row. A count, never a write-once bool - it is the
    /// difference between "one blip" and "the wallet really is empty", and it
    /// returns to 0 the moment a call succeeds.
    #[serde(default)]
    pub consecutive: u32,
    /// Which call path saw it ("realtime mint", "brain", "tts") - so the rail can
    /// say what was refused without re-running a refused request.
    #[serde(default)]
    pub source: String,
}

/// Read persisted evidence. `None` when there is no file, no refusal on record, or
/// the evidence has aged out - all three mean "nothing measured says we're blocked".
pub fn openai_credit_state() -> Option<OpenAiCreditState> {
    credit_state_from(&credit_state_path()?)
}

/// Path-parameterized core so tests never touch the real state directory.
pub(crate) fn credit_state_from(path: &std::path::Path) -> Option<OpenAiCreditState> {
    let raw = std::fs::read_to_string(path).ok()?;
    let state: OpenAiCreditState = serde_json::from_str(&raw).ok()?;
    if !state.refused {
        return None;
    }
    // Spent evidence. Without this, a stamp from a dead session captions the rail
    // forever - exactly the latch this module exists to avoid.
    if now_ms().saturating_sub(state.detected_ms) >= MAX_EVIDENCE_AGE_MS {
        return None;
    }
    Some(state)
}

/// Should a paid OpenAI call be routed around right now?
///
/// TRUE only inside the revalidation window. Past it we deliberately return false
/// even though the refusal is still the last thing we saw, so the next real call
/// actually happens: that call is the only thing that can prove the wallet was
/// refilled. The rail keeps SAYING "refused since <time>" (that remains the last
/// measurement) while the gate quietly reopens to go find out.
pub fn blocks_paid_calls() -> bool {
    openai_credit_state()
        .is_some_and(|s| now_ms().saturating_sub(s.detected_ms) < REVALIDATE_AFTER_MS)
}

/// True when `body` is OpenAI refusing a call for an empty wallet (as opposed to a
/// rate limit, which is also a 429 but recovers by itself and must NOT be recorded
/// as "no credit"). Caller checks the status; this checks the meaning.
pub fn is_credit_refusal(status: u16, body: &str) -> bool {
    if status != 429 {
        return false;
    }
    let b = body.to_ascii_lowercase();
    b.contains("insufficient_quota")
        || b.contains("credit_balance_exhausted")
        || b.contains("no credits remaining")
        || b.contains("exceeded your current quota")
}

/// True when an ERROR STRING (not a live response) is a credit refusal.
///
/// Needed because the reroute decision happens one level up, where only the error
/// message survives. Checking "is a refusal on record?" there would be wrong: a
/// refusal from twenty minutes ago is still on record, so a plain TIMEOUT would get
/// rerouted and Atlas would announce "Paid OpenAI has no credit" about a request that
/// never reached a billing decision. These marker phrases appear only in a genuine
/// quota refusal, so matching the text is both sufficient and specific.
pub fn error_is_credit_refusal(error: &str) -> bool {
    let e = error.to_ascii_lowercase();
    e.contains("insufficient_quota")
        || e.contains("credit_balance_exhausted")
        || e.contains("no credits remaining")
        || e.contains("exceeded your current quota")
        || e.contains("credit is used up")
}

pub(crate) fn write_state_to(path: &std::path::Path, state: &OpenAiCreditState) {
    let _ = (|| -> Option<()> {
        std::fs::create_dir_all(path.parent()?).ok()?;
        std::fs::write(path, serde_json::to_string_pretty(state).ok()?).ok()?;
        Some(())
    })();
}

/// The state a refusal should persist, given whatever was on record before. Pure,
/// so the count-increment rule can be asserted on directly.
pub(crate) fn refused_state(prior: Option<&OpenAiCreditState>, source: &str) -> OpenAiCreditState {
    OpenAiCreditState {
        schema_version: 1,
        refused: true,
        detected_ms: now_ms(),
        consecutive: prior.map_or(0, |p| p.consecutive).saturating_add(1),
        source: source.to_string(),
    }
}

/// Record "OpenAI refused this call because the wallet is empty". `source` names the
/// call path for the rail's caption. Safe to call on every refusal - it refreshes the
/// timestamp, which is what makes "refused since <time>" stay accurate.
pub fn record_openai_credit_refusal(source: &str) {
    let Some(path) = credit_state_path() else {
        return;
    };
    let prior = credit_state_from(&path);
    write_state_to(&path, &refused_state(prior.as_ref(), source));
}

/// A call succeeded, so the account is demonstrably able to pay. Retire the evidence
/// immediately - this is the "success is proof" half of the contract, and it is what
/// makes adding credit take effect on the next call with no restart.
///
/// Cheap by design: it is called on EVERY successful OpenAI call, so the common case
/// (no file, nothing to clear) must not cost a write. It only touches disk when there
/// is actually a stamp to retire.
pub fn clear_openai_credit_block() {
    let Some(path) = credit_state_path() else {
        return;
    };
    if !path.exists() {
        return;
    }
    if credit_state_from(&path).is_none() {
        return; // already clear or already spent - nothing to retire
    }
    write_state_to(
        &path,
        &OpenAiCreditState {
            schema_version: 1,
            refused: false,
            detected_ms: now_ms(),
            consecutive: 0,
            source: String::new(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("praxis-credit-test-{name}"));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).expect("tmp dir");
        p.join("openai-credit.json")
    }

    #[test]
    fn a_timeout_is_never_rerouted_as_a_credit_problem() {
        assert!(!error_is_credit_refusal(
            "openai responses timed out after 60s waiting on gpt-5.6-sol"
        ));
        assert!(!error_is_credit_refusal("openai responses could not connect: dns"));
        assert!(!error_is_credit_refusal(
            r#"openai responses gpt-5.6-sol HTTP 429 Too Many Requests: {"code":"rate_limit_exceeded"}"#
        ));
        assert!(error_is_credit_refusal(
            r#"openai responses gpt-5.6-sol HTTP 429: {"code":"credit_balance_exhausted"}"#
        ));
    }

    #[test]
    fn rate_limit_is_not_a_credit_refusal() {
        // A 429 for requests-per-minute recovers on its own. Recording it as "no
        // credit" would caption the rail NO CREDIT over a busy minute.
        assert!(!is_credit_refusal(429, r#"{"type":"requests","code":"rate_limit_exceeded"}"#));
        assert!(!is_credit_refusal(200, "insufficient_quota"));
        assert!(!is_credit_refusal(500, "insufficient_quota"));
    }

    #[test]
    fn recognizes_the_shapes_openai_actually_sends() {
        assert!(is_credit_refusal(
            429,
            r#"{"error":{"type":"insufficient_quota","code":"credit_balance_exhausted","message":"You have no credits remaining."}}"#
        ));
        assert!(is_credit_refusal(429, "You exceeded your current quota"));
        assert!(is_credit_refusal(429, "CREDIT_BALANCE_EXHAUSTED")); // case-insensitive
    }

    #[test]
    fn success_clears_a_refusal_with_no_restart() {
        let path = tmp("cleared");
        write_state_to(&path, &refused_state(None, "brain"));
        assert!(credit_state_from(&path).is_some(), "refusal is on record");

        // The clear path the success branches call.
        write_state_to(
            &path,
            &OpenAiCreditState { schema_version: 1, refused: false, detected_ms: now_ms(), consecutive: 0, source: String::new() },
        );
        assert!(
            credit_state_from(&path).is_none(),
            "a successful call must retire the block immediately"
        );
    }

    #[test]
    fn consecutive_counts_up_and_is_never_a_write_once_bool() {
        let first = refused_state(None, "realtime mint");
        assert_eq!(first.consecutive, 1);
        let second = refused_state(Some(&first), "brain");
        assert_eq!(second.consecutive, 2, "repeat refusals accumulate");
        assert_eq!(second.source, "brain", "source reflects the latest observation");
    }

    #[test]
    fn stale_evidence_is_spent_and_stops_captioning_the_rail() {
        let path = tmp("stale");
        write_state_to(
            &path,
            &OpenAiCreditState {
                schema_version: 1,
                refused: true,
                detected_ms: now_ms().saturating_sub(MAX_EVIDENCE_AGE_MS + 1),
                consecutive: 9,
                source: "brain".into(),
            },
        );
        assert!(
            credit_state_from(&path).is_none(),
            "day-old evidence says nothing about right now — it must not latch"
        );
    }

    #[test]
    fn revalidation_window_is_shorter_than_evidence_lifetime() {
        // The gate must reopen long before the caption expires, or Praxis would keep
        // routing around a wallet that was refilled and never find out.
        assert!(REVALIDATE_AFTER_MS < MAX_EVIDENCE_AGE_MS);
    }
}

// ── Tauri surface ─────────────────────────────────────────────────────────────
//
// The Realtime SDP exchange happens in the WEBVIEW (WebRTC), so a credit refusal on
// that leg is observed in TypeScript, not Rust. `realtimeTransport.ts` kept it in a
// module-level variable with a 5-minute TTL - correct behaviour, but it died with the
// webview and never reached the Command Center. These two commands let the browser
// write to the same durable evidence every Rust call site uses, so one refusal is one
// fact no matter which layer saw it.

/// Persist a credit refusal observed in the webview (the SDP 429 leg).
#[tauri::command]
pub fn note_openai_credit_refusal(source: Option<String>) {
    record_openai_credit_refusal(source.as_deref().unwrap_or("realtime sdp"));
}

/// Retire the block after a connect that demonstrably worked.
#[tauri::command]
pub fn clear_openai_credit_refusal() {
    clear_openai_credit_block();
}

/// Let the frontend read the same evidence the rail reads (for brain routing).
#[tauri::command]
pub fn openai_credit_status() -> Option<OpenAiCreditState> {
    openai_credit_state()
}
