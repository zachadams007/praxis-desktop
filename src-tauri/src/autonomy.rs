//! autonomy - the trust dial, Rust side, and the ONE place the shell reads it.
//!
//! Mirrors `src/shared/autonomyPolicy.ts` exactly. Two copies exist because the
//! decision is needed on both sides of the IPC boundary and neither side can call
//! the other cheaply; `scripts/test-autonomy-policy.cjs` diffs them so they cannot
//! drift silently.
//!
//! The owner's rule: the dial is the only authority over UNATTENDED sessions, and at
//! maximum it clears everything. It is not consulted for live actions at all -
//! those are the owner driving the machine himself (see `ActionOrigin`).
//!
//! Before this module, `effective_autonomy()` was copy-pasted into computer_use.rs
//! and flow_runner.rs with two different fallback comments, and the only question
//! either asked was "is it operator-or-full" - one bool standing in for four
//! detents.

use std::path::PathBuf;

/// Who asked for this action. The whole gate. Mirrors src/shared/actionOrigin.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ActionOrigin {
    /// The owner spoke or clicked it, now, watching. Equivalent to him doing it himself.
    /// Carries ZERO policy gates - only HALT and the master breaker still apply.
    Live,
    /// A flow, an overnight run, a scheduler. Nobody is watching. The dial decides.
    Unattended,
}

impl ActionOrigin {
    pub fn is_live(self) -> bool {
        matches!(self, ActionOrigin::Live)
    }
}

impl Default for ActionOrigin {
    /// An origin that never arrived is treated as unattended: the safe half of the
    /// split. A missing origin must never silently buy the ungated path.
    fn default() -> Self {
        ActionOrigin::Unattended
    }
}

/// The dial, low → high. Discriminants are the rung order; do not reorder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    /// I · OBSERVE - reads and reports, actuates nothing.
    Observe,
    /// Legacy key, off the dial. Drafts/plans, actuates nothing.
    Suggest,
    /// II · PROPOSE - acts, but asks before EVERY step.
    Approve,
    /// III · EXECUTE - acts on its own; asks only at a sensitive step.
    Operator,
    /// IV · SOVEREIGN - clears everything. No approval, ever. HALT is the only stop.
    Full,
}

impl Level {
    pub fn parse(raw: &str) -> Option<Level> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "observe" => Some(Level::Observe),
            "suggest" => Some(Level::Suggest),
            "approve" => Some(Level::Approve),
            "operator" => Some(Level::Operator),
            "full" => Some(Level::Full),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Level::Observe => "observe",
            Level::Suggest => "suggest",
            Level::Approve => "approve",
            Level::Operator => "operator",
            Level::Full => "full",
        }
    }

    /// The detent label the dials show, so a refusal names what the owner actually sees.
    pub fn label(self) -> &'static str {
        match self {
            Level::Observe => "I · OBSERVE",
            Level::Suggest => "Suggest",
            Level::Approve => "II · PROPOSE",
            Level::Operator => "III · EXECUTE",
            Level::Full => "IV · SOVEREIGN",
        }
    }

    /// Top of the dial: nothing is withheld and nothing is asked.
    pub fn is_sovereign(self) -> bool {
        matches!(self, Level::Full)
    }
}

/// What an unattended run is trying to do. Mirrors `ActionClass` in the TS half.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionClass {
    /// Reading, listing, screenshotting. Mutates nothing.
    Read,
    /// Real actuation: keystrokes, clicks, spawning a lane, editing a file.
    Actuate,
    /// Actuation that is credentialed, irreversible, or outward-facing.
    Sensitive,
}

/// How much human approval is required before this may proceed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Approval {
    /// Proceed. Nobody is asked.
    None,
    /// Ask before this step, every time, through the veto channel.
    Step,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allowed(Approval),
    Blocked(String),
}

impl Decision {
    pub fn is_allowed(&self) -> bool {
        matches!(self, Decision::Allowed(_))
    }
    pub fn approval(&self) -> Approval {
        match self {
            Decision::Allowed(a) => *a,
            Decision::Blocked(_) => Approval::Step,
        }
    }
    pub fn reason(&self) -> Option<&str> {
        match self {
            Decision::Blocked(r) => Some(r.as_str()),
            Decision::Allowed(_) => None,
        }
    }
}

/// THE decision, for unattended runs only. Identical logic to the TS half.
pub fn unattended_decision(level: Level, action: ActionClass) -> Decision {
    // Looking is always allowed - a dial that stopped a run from reading its own
    // state would break the run without protecting anything.
    if matches!(action, ActionClass::Read) {
        return Decision::Allowed(Approval::None);
    }

    match level {
        Level::Observe => Decision::Blocked(
            "Trust is at I · OBSERVE — unattended runs watch and report, they don't touch the machine. Raise the dial to act while you're away."
                .to_string(),
        ),
        Level::Suggest => Decision::Blocked(
            "Trust is at Suggest — unattended runs draft the next move but never fire it. Raise the dial to II · PROPOSE or higher."
                .to_string(),
        ),
        // II · PROPOSE finally means what it always said: it DOES act, it asks first.
        Level::Approve => Decision::Allowed(Approval::Step),
        // III · EXECUTE: autonomous for ordinary work, asks at the irreversible ones.
        Level::Operator => Decision::Allowed(if matches!(action, ActionClass::Sensitive) {
            Approval::Step
        } else {
            Approval::None
        }),
        // IV · SOVEREIGN clears EVERYTHING.
        Level::Full => Decision::Allowed(Approval::None),
    }
}

fn autonomy_file() -> Option<PathBuf> {
    crate::praxis_dir().map(|d| d.join("autonomy.txt"))
}

/// The dial as the shell sees it - `%LOCALAPPDATA%\Praxis\autonomy.txt`, mirrored
/// from the frontend by `autonomy_sync`. Missing or unparseable falls back to
/// Operator, the same default `src/shared/autonomy.ts` ships, so the shell and the
/// webview agree before the dial has ever been touched.
pub fn effective_level() -> Level {
    autonomy_file()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| Level::parse(&raw))
        .unwrap_or(Level::Operator)
}

/// Convenience: may an unattended run of this class proceed at all right now?
pub fn unattended_allows(action: ActionClass) -> bool {
    unattended_decision(effective_level(), action).is_allowed()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observe_and_suggest_block_all_actuation() {
        for level in [Level::Observe, Level::Suggest] {
            assert!(!unattended_decision(level, ActionClass::Actuate).is_allowed());
            assert!(!unattended_decision(level, ActionClass::Sensitive).is_allowed());
            // ...but never blocks a read.
            assert!(unattended_decision(level, ActionClass::Read).is_allowed());
        }
    }

    #[test]
    fn observe_and_suggest_give_different_reasons() {
        // The whole point of the rewrite: rungs must be distinguishable. If these
        // two ever collapse into one string, the dial has silently lost a detent.
        let a = unattended_decision(Level::Observe, ActionClass::Actuate);
        let b = unattended_decision(Level::Suggest, ActionClass::Actuate);
        assert_ne!(a.reason(), b.reason());
    }

    #[test]
    fn propose_acts_but_asks_every_step() {
        let ordinary = unattended_decision(Level::Approve, ActionClass::Actuate);
        let sensitive = unattended_decision(Level::Approve, ActionClass::Sensitive);
        assert!(ordinary.is_allowed() && sensitive.is_allowed());
        assert_eq!(ordinary.approval(), Approval::Step);
        assert_eq!(sensitive.approval(), Approval::Step);
    }

    #[test]
    fn execute_is_autonomous_until_a_sensitive_step() {
        assert_eq!(
            unattended_decision(Level::Operator, ActionClass::Actuate).approval(),
            Approval::None
        );
        assert_eq!(
            unattended_decision(Level::Operator, ActionClass::Sensitive).approval(),
            Approval::Step
        );
    }

    #[test]
    fn sovereign_clears_everything() {
        // The owner's requirement, stated as a test: at the top detent, paying,
        // creating an account and submitting a form are permitted with NO prompt.
        for action in [ActionClass::Read, ActionClass::Actuate, ActionClass::Sensitive] {
            let d = unattended_decision(Level::Full, action);
            assert!(d.is_allowed());
            assert_eq!(d.approval(), Approval::None);
        }
        assert!(Level::Full.is_sovereign());
    }

    #[test]
    fn the_four_detents_are_four_distinct_behaviours() {
        // (allowed, approval) for (actuate, sensitive) must be unique per rung.
        let shape = |l: Level| {
            let a = unattended_decision(l, ActionClass::Actuate);
            let s = unattended_decision(l, ActionClass::Sensitive);
            (a.is_allowed(), a.approval(), s.is_allowed(), s.approval())
        };
        let detents = [Level::Observe, Level::Approve, Level::Operator, Level::Full];
        for (i, a) in detents.iter().enumerate() {
            for b in detents.iter().skip(i + 1) {
                assert_ne!(shape(*a), shape(*b), "{:?} and {:?} behave identically", a, b);
            }
        }
    }

    #[test]
    fn level_round_trips_and_rejects_junk() {
        for l in [Level::Observe, Level::Suggest, Level::Approve, Level::Operator, Level::Full] {
            assert_eq!(Level::parse(l.as_str()), Some(l));
        }
        assert_eq!(Level::parse("  FULL \n"), Some(Level::Full));
        assert_eq!(Level::parse("sovereign"), None);
        assert_eq!(Level::parse(""), None);
    }

    #[test]
    fn origin_defaults_to_the_gated_half() {
        // A missing origin must never buy the ungated live path.
        assert_eq!(ActionOrigin::default(), ActionOrigin::Unattended);
        assert!(ActionOrigin::Live.is_live());
        assert!(!ActionOrigin::Unattended.is_live());
    }

    #[test]
    fn ladder_orders_low_to_high() {
        assert!(Level::Observe < Level::Suggest);
        assert!(Level::Suggest < Level::Approve);
        assert!(Level::Approve < Level::Operator);
        assert!(Level::Operator < Level::Full);
    }
}
