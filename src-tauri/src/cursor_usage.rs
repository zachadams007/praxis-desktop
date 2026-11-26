//! Cursor usage types, the usage-summary parser, and the pool rule that decides whether a
//! Cursor lane may run.
//!
//! `fetch_live()` answers `None`, so the rail shows no reading.

use crate::iso8601::parse_iso8601_ms;
use serde_json::Value;

/// Frontend polls every 30s; Cursor's own aggregates move slowly. 2 minutes keeps
/// the SUPPLY panel live without hammering cursor.com.
const CACHE_TTL_MS: u64 = 2 * 60 * 1000;

static CACHE: std::sync::Mutex<Option<(u64, CursorUsage)>> = std::sync::Mutex::new(None);

/// Forget the cached reading so the next call re-reads from source. Used by
/// Restore (restore.rs); a no-op when nothing is cached.
pub(crate) fn clear_cache() {
    if let Ok(mut guard) = CACHE.lock() {
        *guard = None;
    }
}

/// One Cursor meter bar handed to `usage.rs::cursor_plan_limit`.
#[derive(Clone, Debug)]
pub struct CursorBar {
    /// "TOTAL" | "API" | "ON-DEMAND" (or with a fallback suffix in the label).
    pub label: String,
    pub used: f64,
    pub limit: f64,
    /// "percent" for live % bars; "requests" only on the used/limit fallback.
    pub unit: String,
    pub estimated: bool,
    pub basis: &'static str,
}

/// What we hand back to `usage.rs::plan_limits_for("cursor")`. `None` means
/// "couldn't get live data" - the caller renders the "open dashboard" fallback.
#[derive(Clone, Debug)]
pub struct CursorUsage {
    /// Short membership label, e.g. "pro".
    pub membership_label: String,
    pub account_email: Option<String>,
    pub resets_at_ms: Option<u64>,
    pub bars: Vec<CursorBar>,
    /// True when TOTAL/API fell back to used/limit because percents were missing.
    pub used_limit_fallback: bool,
    /// Cursor's OWN-model pool (Composer, Cursor Grok) - `autoPercentUsed`.
    pub models_pool_pct: Option<f64>,
    /// `apiPercentUsed`.
    pub api_pool_pct: Option<f64>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Format a reset instant as "Oct 2" for the rail note.
pub fn fmt_reset_short(ms: u64) -> String {
    // Hand-rolled month abbrev - enough for the rail caption, no chrono.
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let days = (ms / 86_400_000) as i64;
    // Civil from days (inverse of Hinnant).
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let _y = if m <= 2 { y + 1 } else { y };
    let month = MONTHS
        .get((m as usize).saturating_sub(1))
        .copied()
        .unwrap_or("?");
    format!("{month} {d}")
}

/// Pure parse of a usage-summary JSON body into CursorUsage (no network).
/// Exported for unit tests with the live fixture.
pub fn parse_usage_summary(body: &Value, account_email: Option<String>) -> Option<CursorUsage> {
    let plan = body.pointer("/individualUsage/plan")?;
    let membership = body
        .get("membershipType")
        .and_then(|v| v.as_str())
        .unwrap_or("pro");
    let membership_label = membership.replace('_', " ");
    let resets_at_ms = body
        .get("billingCycleEnd")
        .and_then(|v| v.as_str())
        .and_then(parse_iso8601_ms);

    let total_pct = plan.get("totalPercentUsed").and_then(|v| v.as_f64());
    let api_pct = plan.get("apiPercentUsed").and_then(|v| v.as_f64());
    let plan_used = plan.get("used").and_then(|v| v.as_f64());
    let plan_limit = plan.get("limit").and_then(|v| v.as_f64());

    let mut bars: Vec<CursorBar> = Vec::new();
    let mut used_limit_fallback = false;

    match (total_pct, api_pct) {
        (Some(total), Some(api)) => {
            bars.push(CursorBar {
                label: "TOTAL".into(),
                used: total,
                limit: 100.0,
                unit: "percent".into(),
                estimated: false,
                basis: "real",
            });
            // TOTAL is the average of the two pools, so it hid the fact that decides where
            // Quill's work bills: the Cursor-models pool can be full while TOTAL reads 73%.
            if let Some(models) = plan.get("autoPercentUsed").and_then(|v| v.as_f64()) {
                bars.push(CursorBar {
                    label: "CURSOR MODELS".into(),
                    used: models,
                    limit: 100.0,
                    unit: "percent".into(),
                    estimated: false,
                    basis: "real",
                });
            }
            bars.push(CursorBar {
                label: "API".into(),
                used: api,
                limit: 100.0,
                unit: "percent".into(),
                estimated: false,
                basis: "real",
            });
        }
        _ => {
            // Missing percents → fall back to used/limit and say so in the label.
            used_limit_fallback = true;
            if let (Some(used), Some(limit)) = (plan_used, plan_limit) {
                if limit > 0.0 {
                    bars.push(CursorBar {
                        label: "QUOTA (used/limit fallback)".into(),
                        used,
                        limit,
                        unit: "requests".into(),
                        estimated: false,
                        basis: "real",
                    });
                }
            }
            // Still surface whichever percent we do have.
            if let Some(total) = total_pct {
                bars.insert(
                    0,
                    CursorBar {
                        label: "TOTAL".into(),
                        used: total,
                        limit: 100.0,
                        unit: "percent".into(),
                        estimated: false,
                        basis: "real",
                    },
                );
            }
            if let Some(api) = api_pct {
                bars.push(CursorBar {
                    label: "API".into(),
                    used: api,
                    limit: 100.0,
                    unit: "percent".into(),
                    estimated: false,
                    basis: "real",
                });
            }
        }
    }

    // On-demand bar only when Cursor says it is enabled.
    if let Some(od) = body.pointer("/individualUsage/onDemand") {
        if od.get("enabled").and_then(|v| v.as_bool()) == Some(true) {
            let used = od.get("used").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if let Some(limit) = od.get("limit").and_then(|v| v.as_f64()) {
                if limit > 0.0 {
                    bars.push(CursorBar {
                        label: "ON-DEMAND".into(),
                        used,
                        limit,
                        unit: "requests".into(),
                        estimated: false,
                        basis: "real",
                    });
                }
            } else {
                // Enabled but uncapped - still show the spent figure as used/used
                // so the rail acknowledges on-demand without inventing a ceiling.
                bars.push(CursorBar {
                    label: "ON-DEMAND".into(),
                    used,
                    limit: used.max(1.0),
                    unit: "requests".into(),
                    estimated: true,
                    basis: "estimated",
                });
            }
        }
    }

    if bars.is_empty() {
        return None;
    }

    Some(CursorUsage {
        membership_label,
        account_email,
        resets_at_ms,
        bars,
        used_limit_fallback,
        models_pool_pct: plan.get("autoPercentUsed").and_then(|v| v.as_f64()),
        api_pool_pct: api_pct,
    })
}

async fn fetch_live() -> Option<CursorUsage> {
    None
}

/// Public entry point: cached (2 min), best-effort.
pub async fn cursor_usage() -> Option<CursorUsage> {
    if let Ok(guard) = CACHE.lock() {
        if let Some((ts, cached)) = guard.as_ref() {
            if now_ms().saturating_sub(*ts) < CACHE_TTL_MS {
                return Some(cached.clone());
            }
        }
    }

    let fresh = fetch_live().await;
    if let Some(u) = &fresh {
        if let Ok(mut guard) = CACHE.lock() {
            *guard = Some((now_ms(), u.clone()));
        }
    }
    fresh
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct CursorPoolState {
    pub models_pool_pct: Option<f64>,
    pub api_pool_pct: Option<f64>,
    pub resets_at_ms: Option<u64>,
    pub exhausted: bool,
    pub api_pool_allowed: bool,
    /// The pool that truthfully constrains Quill right now.
    pub effective_pct: Option<f64>,
    /// The sentence Praxis says when it leaves Quill out ("" when Quill may run).
    pub note: String,
}

pub(crate) fn api_pool_allowed() -> bool {
    crate::praxis_dir()
        .and_then(|d| std::fs::read_to_string(d.join("cursor-api-pool.txt")).ok())
        .is_some_and(|s| s.trim().eq_ignore_ascii_case("allow"))
}

fn effective_percent(models_pool_pct: Option<f64>, api_pool_pct: Option<f64>, allowed: bool) -> Option<f64> {
    if allowed {
        api_pool_pct
    } else {
        models_pool_pct
    }
}

pub(crate) fn pool_state_from(usage: Option<&CursorUsage>, allowed: bool) -> CursorPoolState {
    let models = usage.and_then(|u| u.models_pool_pct);
    let api = usage.and_then(|u| u.api_pool_pct);
    let exhausted = models.is_some_and(|m| m >= 99.5);
    let resets = usage.and_then(|u| u.resets_at_ms);
    let note = if exhausted && !allowed {
        format!(
            "Quill sat this one out: Cursor's own-model allowance is used up until {}, so every Cursor call would bill your API pool.",
            resets.map(fmt_reset_short).unwrap_or_else(|| "the next billing cycle".into())
        )
    } else {
        String::new()
    };
    CursorPoolState {
        models_pool_pct: models,
        api_pool_pct: usage.and_then(|u| u.api_pool_pct),
        resets_at_ms: resets,
        exhausted,
        api_pool_allowed: allowed,
        effective_pct: effective_percent(models, api, allowed),
        note,
    }
}

/// Where Quill's work would bill right now.
#[tauri::command]
pub async fn cursor_pool_state() -> Result<CursorPoolState, String> {
    let usage = cursor_usage().await;
    Ok(pool_state_from(usage.as_ref(), api_pool_allowed()))
}

#[cfg(test)]
mod pool_tests {
    use super::*;

    fn usage(models: f64) -> CursorUsage {
        CursorUsage {
            membership_label: "pro".into(),
            account_email: None,
            resets_at_ms: Some(1_790_953_215_000),
            bars: vec![],
            used_limit_fallback: false,
            models_pool_pct: Some(models),
            api_pool_pct: Some(52.0),
        }
    }

    #[test]
    fn quill_pauses_only_when_the_own_model_pool_is_used_up_and_zach_has_not_allowed_the_api_pool() {
        let s = pool_state_from(Some(&usage(100.0)), false);
        assert!(s.exhausted && s.note.starts_with("Quill sat this one out") && s.note.contains("Oct 2"), "{s:?}");
        assert!(pool_state_from(Some(&usage(100.0)), true).note.is_empty(), "Zach allowed it");
        assert!(!pool_state_from(Some(&usage(73.0)), false).exhausted);
        assert!(!pool_state_from(None, false).exhausted, "unknown is not exhausted");
    }

    #[test]
    fn effective_percent_follows_the_pool_quill_is_allowed_to_use() {
        assert_eq!(effective_percent(Some(100.0), Some(52.0), true), Some(52.0));
        assert_eq!(effective_percent(Some(100.0), Some(52.0), false), Some(100.0));
        assert_eq!(effective_percent(Some(100.0), None, true), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Real response shape measured 2026-09-14 (pro, saturated legacy counter).
    fn fixture_live() -> Value {
        json!({
            "billingCycleEnd": "2026-10-02T15:00:15.000Z",
            "membershipType": "pro",
            "autoModelSelectedDisplayMessage": "You've used 23% of your included total usage",
            "namedModelSelectedDisplayMessage": "You've used 46% of your included API usage",
            "individualUsage": {
                "plan": {
                    "enabled": true,
                    "used": 2000,
                    "limit": 2000,
                    "remaining": 0,
                    "breakdown": { "included": 2000, "bonus": 49, "total": 2049 },
                    "autoPercentUsed": 0,
                    "apiPercentUsed": 45.53333333333333,
                    "totalPercentUsed": 22.766666666666666
                },
                "onDemand": {
                    "enabled": false,
                    "used": 0,
                    "limit": null,
                    "remaining": null
                }
            }
        })
    }

    #[test]
    fn live_fixture_total_and_api_percents_no_legacy_bar() {
        let u = parse_usage_summary(&fixture_live(), Some("zach@example.com".into())).unwrap();
        assert_eq!(u.membership_label, "pro");
        assert_eq!(u.account_email.as_deref(), Some("zach@example.com"));
        assert!(u.resets_at_ms.is_some());
        assert!(!u.used_limit_fallback);
        assert_eq!(u.bars.len(), 3);
        assert_eq!(u.bars[0].label, "TOTAL");
        assert!((u.bars[0].used - 22.766666666666666).abs() < 1e-9);
        assert_eq!(u.bars[0].limit, 100.0);
        assert_eq!(u.bars[0].unit, "percent");
        assert_eq!(u.bars[1].label, "CURSOR MODELS");
        assert_eq!(u.models_pool_pct, Some(0.0));
        assert_eq!(u.bars[2].label, "API");
        assert!((u.bars[2].used - 45.53333333333333).abs() < 1e-9);
        assert_eq!(u.api_pool_pct, Some(45.53333333333333));
        // Never draw the saturated 2000/2000 legacy counter.
        assert!(u.bars.iter().all(|b| b.unit != "requests" || b.label.contains("ON-DEMAND")));
        assert!(u.bars.iter().all(|b| !(b.used == 2000.0 && b.limit == 2000.0)));
    }

    #[test]
    fn missing_percents_fall_back_to_used_limit() {
        let body = json!({
            "billingCycleEnd": "2026-10-02T15:00:15.000Z",
            "membershipType": "pro",
            "individualUsage": {
                "plan": { "enabled": true, "used": 100, "limit": 500 },
                "onDemand": { "enabled": false }
            }
        });
        let u = parse_usage_summary(&body, None).unwrap();
        assert!(u.used_limit_fallback);
        assert_eq!(u.bars.len(), 1);
        assert!(u.bars[0].label.contains("fallback"));
        assert_eq!(u.bars[0].used, 100.0);
        assert_eq!(u.bars[0].limit, 500.0);
        assert_eq!(u.bars[0].unit, "requests");
    }

    #[test]
    fn on_demand_enabled_adds_bar() {
        let mut body = fixture_live();
        body["individualUsage"]["onDemand"] = json!({
            "enabled": true,
            "used": 12,
            "limit": 100,
            "remaining": 88
        });
        let u = parse_usage_summary(&body, None).unwrap();
        // TOTAL + CURSOR MODELS + API + ON-DEMAND.
        assert_eq!(u.bars.len(), 4);
        let od = u.bars.iter().find(|b| b.label == "ON-DEMAND").unwrap();
        assert_eq!(od.used, 12.0);
        assert_eq!(od.limit, 100.0);
    }

    #[test]
    fn reset_short_formats_oct_2() {
        let ms = parse_iso8601_ms("2026-10-02T15:00:15.000Z").unwrap();
        assert_eq!(fmt_reset_short(ms), "Oct 2");
    }
}
