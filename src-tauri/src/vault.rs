//! Local encrypted credential vault for Praxis' sovereign layer.
//!
//! `%LOCALAPPDATA%\Praxis\vault.dat` stores a JSON map encrypted with Windows
//! DPAPI current-user scope. Missing file = empty vault; plaintext is never
//! written to disk.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct VaultEntry {
    pub username: String,
    pub password: String,
    pub notes: String,
    pub updated_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct VaultListEntry {
    pub label: String,
    pub username: String,
    pub has_password: bool,
    pub updated_ms: u64,
}

type VaultMap = BTreeMap<String, VaultEntry>;

/// `%LOCALAPPDATA%\Praxis\vault.dat` - same home as runs.jsonl / usage.json.
fn vault_file_path() -> Option<std::path::PathBuf> {
    crate::praxis_dir().map(|d| d.join("vault.dat"))
}

fn now_ms() -> u64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    millis.min(u128::from(u64::MAX)) as u64
}

fn load_vault() -> Result<VaultMap, String> {
    let path = vault_file_path().ok_or_else(|| "LOCALAPPDATA not set".to_string())?;
    let encrypted = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(VaultMap::new()),
        Err(e) => return Err(format!("vault read: {e}")),
    };
    let json = unprotect_bytes(&encrypted)?;
    serde_json::from_slice(&json).map_err(|e| format!("vault parse: {e}"))
}

fn save_vault(vault: &VaultMap) -> Result<(), String> {
    let path = vault_file_path().ok_or_else(|| "LOCALAPPDATA not set".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("vault mkdir: {e}"))?;
    }

    let json = serde_json::to_vec(vault).map_err(|e| format!("vault serialize: {e}"))?;
    let encrypted = protect_bytes(&json)?;
    std::fs::write(&path, encrypted).map_err(|e| format!("vault write: {e}"))?;
    Ok(())
}

#[cfg(windows)]
fn protect_bytes(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext
            .len()
            .try_into()
            .map_err(|_| "vault encrypt: plaintext too large".to_string())?,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| format!("vault encrypt: {e}"))?;

        let encrypted = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData as *mut core::ffi::c_void));
        Ok(encrypted)
    }
}

#[cfg(windows)]
fn unprotect_bytes(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: ciphertext
            .len()
            .try_into()
            .map_err(|_| "vault decrypt: ciphertext too large".to_string())?,
        pbData: ciphertext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| format!("vault decrypt: {e}"))?;

        let decrypted = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData as *mut core::ffi::c_void));
        Ok(decrypted)
    }
}

#[cfg(not(windows))]
fn protect_bytes(_plaintext: &[u8]) -> Result<Vec<u8>, String> {
    Err("vault encryption requires Windows DPAPI".to_string())
}

#[cfg(not(windows))]
fn unprotect_bytes(_ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    Err("vault decryption requires Windows DPAPI".to_string())
}

#[tauri::command]
pub fn vault_set(
    label: String,
    username: String,
    password: String,
    notes: String,
) -> Result<(), String> {
    let label = label.trim().to_string();
    if label.is_empty() {
        return Err("vault label is required".to_string());
    }

    let mut vault = load_vault()?;
    vault.insert(
        label,
        VaultEntry {
            username,
            password,
            notes,
            updated_ms: now_ms(),
        },
    );
    save_vault(&vault)
}

#[tauri::command]
pub fn vault_get(label: String) -> Result<Option<VaultEntry>, String> {
    let vault = load_vault()?;
    Ok(vault.get(label.trim()).cloned())
}

#[tauri::command]
pub fn vault_list() -> Result<Vec<VaultListEntry>, String> {
    let vault = load_vault()?;
    Ok(vault
        .into_iter()
        .map(|(label, entry)| VaultListEntry {
            label,
            username: entry.username,
            has_password: !entry.password.is_empty(),
            updated_ms: entry.updated_ms,
        })
        .collect())
}

#[tauri::command]
pub fn vault_delete(label: String) -> Result<(), String> {
    let mut vault = load_vault()?;
    vault.remove(label.trim());
    save_vault(&vault)
}

#[tauri::command]
pub fn vault_has(label: String) -> Result<bool, String> {
    let vault = load_vault()?;
    Ok(vault.contains_key(label.trim()))
}
