//! That reader is withheld. The state type and commands are kept so the frontend contract is
//! complete, and the state stays at its honest default: not read.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct Grant {
    #[serde(default)]
    pub amount_usd: Option<f64>,
    #[serde(default)]
    pub used_usd: Option<f64>,
    #[serde(default)]
    pub remaining_usd: Option<f64>,
    #[serde(default)]
    pub effective_at: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct BillingState {
    pub status: String,
    pub balance_usd: Option<f64>,
    pub granted_usd: Option<f64>,
    pub used_usd: Option<f64>,
    #[serde(default)]
    pub grants: Vec<Grant>,
    pub read_at_ms: u64,
    pub source: String,
    pub detail: String,
    #[serde(default)]
    pub praxis_spend_at_read_usd: Option<f64>,
}

impl Default for BillingState {
    fn default() -> Self {
        Self {
            status: "never".into(),
            balance_usd: None,
            granted_usd: None,
            used_usd: None,
            grants: Vec::new(),
            read_at_ms: 0,
            source: String::new(),
            detail: "OpenAI balance has not been read yet".into(),
            praxis_spend_at_read_usd: None,
        }
    }
}

#[tauri::command]
pub fn openai_billing_state() -> BillingState {
    BillingState::default()
}

#[tauri::command]
pub async fn openai_billing_refresh(_app: tauri::AppHandle) -> BillingState {
    BillingState::default()
}

#[tauri::command]
pub async fn openai_billing_sign_in(_app: tauri::AppHandle) {}

pub fn install(_app: &tauri::AppHandle) {}
