use crate::AppResult;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::command;

const KEY_BASENAMES: &[&str] = &["id_ed25519", "id_rsa", "id_ecdsa"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSetupOutput {
    pub keys_found: bool,
    pub private_key_paths: Vec<String>,
    pub public_key_path: Option<String>,
    pub public_key: Option<String>,
    pub preferred_key_name: Option<String>,
    pub generated: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSshKeyInput {
    #[serde(default)]
    pub comment: String,
}

fn ssh_dir() -> AppResult<PathBuf> {
    let home =
        dirs::home_dir().ok_or_else(|| crate::AppError::msg("Could not resolve home directory"))?;
    Ok(home.join(".ssh"))
}

fn ensure_ssh_dir(dir: &Path) -> AppResult<()> {
    if !dir.exists() {
        fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

fn read_public_key(pub_path: &Path) -> Option<String> {
    fs::read_to_string(pub_path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn collect_setup(generated: bool, message: impl Into<String>) -> AppResult<SshSetupOutput> {
    let dir = ssh_dir()?;
    let mut private_key_paths = Vec::new();
    let mut public_key_path = None;
    let mut public_key = None;
    let mut preferred_key_name = None;

    for name in KEY_BASENAMES {
        let private = dir.join(name);
        if !private.exists() {
            continue;
        }
        private_key_paths.push(private.to_string_lossy().to_string());
        if preferred_key_name.is_none() {
            preferred_key_name = Some((*name).to_string());
            let pub_path = dir.join(format!("{name}.pub"));
            if pub_path.exists() {
                public_key_path = Some(pub_path.to_string_lossy().to_string());
                public_key = read_public_key(&pub_path);
            }
        }
    }

    let keys_found = !private_key_paths.is_empty();
    Ok(SshSetupOutput {
        keys_found,
        private_key_paths,
        public_key_path,
        public_key,
        preferred_key_name,
        generated,
        message: message.into(),
    })
}

#[command]
pub fn get_ssh_setup() -> AppResult<SshSetupOutput> {
    let snapshot = collect_setup(false, "")?;
    let message = if snapshot.keys_found {
        format!(
            "SSH key ready ({})",
            snapshot
                .preferred_key_name
                .as_deref()
                .unwrap_or("key found")
        )
    } else {
        "No SSH key found yet — Branchline can create one for you.".into()
    };
    Ok(SshSetupOutput {
        message,
        ..snapshot
    })
}

#[command]
pub fn generate_ssh_key(input: GenerateSshKeyInput) -> AppResult<SshSetupOutput> {
    let dir = ssh_dir()?;
    ensure_ssh_dir(&dir)?;

    let private = dir.join("id_ed25519");
    let public = dir.join("id_ed25519.pub");
    if private.exists() || public.exists() {
        return collect_setup(
            false,
            "An ed25519 key already exists — copy it and add it to GitHub.",
        );
    }

    let ssh_keygen = which::which("ssh-keygen").map_err(|_| {
        crate::AppError::msg(
            "ssh-keygen was not found. Install OpenSSH, then try again — or generate a key in Terminal.",
        )
    })?;

    let comment = {
        let trimmed = input.comment.trim();
        if trimmed.is_empty() {
            "branchline".to_string()
        } else {
            trimmed.to_string()
        }
    };

    let output = Command::new(ssh_keygen)
        .args([
            "-t",
            "ed25519",
            "-f",
            private
                .to_str()
                .ok_or_else(|| crate::AppError::msg("Invalid SSH key path"))?,
            "-N",
            "",
            "-C",
            &comment,
            "-q",
        ])
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(crate::AppError::msg(if stderr.is_empty() {
            "Failed to generate SSH key with ssh-keygen.".into()
        } else {
            format!("Failed to generate SSH key: {stderr}")
        }));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if private.exists() {
            fs::set_permissions(&private, fs::Permissions::from_mode(0o600))?;
        }
    }

    collect_setup(
        true,
        "Created ~/.ssh/id_ed25519 — copy the public key and add it on GitHub.",
    )
}
