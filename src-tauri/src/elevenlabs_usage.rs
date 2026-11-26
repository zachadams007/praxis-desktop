//! elevenlabs_usage - the ONE real quota number for the voice rail.
//!
//! The voice panel has always said "COST UNKNOWN · billing not queried", which was
//! honest but not useful: ElevenLabs meters by CHARACTER, not by dollar, and it
//! publishes the character count and the plan limit on a plain authenticated GET.
//! Praxis already counts characters it sends locally (`voice_usage.rs`), so the
//! rail could show a bar it had no cap for. This supplies the cap, and the
//! provider's own count of what has been spent against it.
//!
//! Deliberately NOT a dollar figure. Characters against the plan limit is the real meter, and it
//! is the one ElevenLabs itself shows.

use serde::Serialize;

const SUBSCRIPTION_URL: &str = "https://api.elevenlabs.io/v1/user/subscription";
const TIMEOUT_SECS: u64 = 12;
/// Re-ask at most this often. Capped at 60s like the other usage caches so a
/// 30s frontend poll does not keep serving a multi-minute-stale reading.
const CACHE_TTL_MS: u64 = 60_000;

#[derive(Debug, Clone, Serialize)]
pub struct ElevenLabsQuota {
    /// Characters consumed this billing period, as ElevenLabs counts them - which
    /// is authoritative, and can differ from our local tally when a request was
    /// billed but its result never reached our ledger.
    pub character_count: u64,
    pub character_limit: u64,
    pub tier: String,
    /// Unix seconds. `None` when the plan does not publish a reset.
    pub resets_at_unix: Option<u64>,
    pub fetched_at_ms: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Read `ELEVENLABS_API_KEY` from the one source of truth, matching the way every
/// other provider in this app reaches it. Never logged, never returned.
fn api_key() -> Option<String> {
    if let Ok(k) = std::env::var("ELEVENLABS_API_KEY") {
        let k = k.trim().to_string();
        if !k.is_empty() {
            return Some(k);
        }
    }
    let home = std::env::var("USERPROFILE").ok()?;
    let path = std::path::Path::new(&home)
        .join(".claude")
        .join("secrets")
        .join("praxis-secrets.env");
    let body = std::fs::read_to_string(path).ok()?;
    for line in body.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("ELEVENLABS_API_KEY=") {
            let v = rest.trim().trim_matches('"').trim_matches('\'').to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

static CACHE: std::sync::Mutex<Option<ElevenLabsQuota>> = std::sync::Mutex::new(None);

/// Forget the cached reading so the next call re-reads from source. Used by
/// Restore (restore.rs); a no-op when nothing is cached.
pub(crate) fn clear_cache() {
    if let Ok(mut guard) = CACHE.lock() {
        *guard = None;
    }
}

/// The live quota, or `None` when there is no key or the provider cannot be
/// reached. `None` means "not measured" and the rail must say so - it must never
/// be rendered as zero usage, which is what a silent failure would look like.
pub async fn elevenlabs_quota() -> Option<ElevenLabsQuota> {
    if let Ok(guard) = CACHE.lock() {
        if let Some(cached) = guard.as_ref() {
            if now_ms().saturating_sub(cached.fetched_at_ms) < CACHE_TTL_MS {
                return Some(cached.clone());
            }
        }
    }

    let key = api_key()?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
        .ok()?;
    let resp = client
        .get(SUBSCRIPTION_URL)
        .header("xi-api-key", key)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: serde_json::Value = resp.json().await.ok()?;

    let quota = ElevenLabsQuota {
        character_count: v.get("character_count").and_then(serde_json::Value::as_u64)?,
        character_limit: v.get("character_limit").and_then(serde_json::Value::as_u64)?,
        tier: v
            .get("tier")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        resets_at_unix: v
            .get("next_character_count_reset_unix")
            .and_then(serde_json::Value::as_u64),
        fetched_at_ms: now_ms(),
    };

    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(quota.clone());
    }
    Some(quota)
}

#[tauri::command]
pub async fn elevenlabs_usage() -> Option<ElevenLabsQuota> {
    elevenlabs_quota().await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ONE test, not two: these mutate the same process-wide environment
    /// variable, and as separate #[test]s cargo ran them in parallel. The race
    /// made `api_key()` fall through to the real secrets file and an assertion
    /// failure would print the real key into the test output.
    ///
    /// So this also never asserts on a key's VALUE. It compares against an
    /// expectation and reports only whether they matched, because a failing
    /// assert_eq! on a secret is a secret disclosure with extra steps.
    #[test]
    fn key_loading_prefers_the_environment_and_rejects_blanks() {
        let restore = std::env::var("ELEVENLABS_API_KEY").ok();

        std::env::set_var("ELEVENLABS_API_KEY", "sk_test_value");
        assert!(
            api_key().as_deref() == Some("sk_test_value"),
            "an explicit env key must win over the secrets file"
        );

        std::env::set_var("ELEVENLABS_API_KEY", "   ");
        assert!(
            api_key().map(|k| !k.trim().is_empty()).unwrap_or(true),
            "a blank key must never be returned as usable"
        );

        match restore {
            Some(v) => std::env::set_var("ELEVENLABS_API_KEY", v),
            None => std::env::remove_var("ELEVENLABS_API_KEY"),
        }
    }
}
