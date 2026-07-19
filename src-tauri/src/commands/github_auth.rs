use crate::AppError;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use tauri::command;

const DEFAULT_SCOPE: &str = "repo workflow read:user";
const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDeviceStartInput {
    pub client_id: String,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDeviceStartOutput {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDevicePollInput {
    pub client_id: String,
    pub device_code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDevicePollOutput {
    pub status: String,
    pub access_token: Option<String>,
    pub token_type: Option<String>,
    pub scope: Option<String>,
    pub error_description: Option<String>,
    pub interval: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    expires_in: u64,
    interval: u64,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    token_type: Option<String>,
    scope: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
    interval: Option<u64>,
}

#[command]
pub fn github_device_login_start(
    input: GithubDeviceStartInput,
) -> AppResult<GithubDeviceStartOutput> {
    let client_id = input.client_id.trim();
    if client_id.is_empty() {
        return Err(AppError::msg(
            "GitHub OAuth Client ID is missing from this build.",
        ));
    }

    let scope = input
        .scope
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_SCOPE);

    let client = reqwest::blocking::Client::new();
    let response = client
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .header("User-Agent", "Branchline")
        .form(&[("client_id", client_id), ("scope", scope)])
        .send()
        .map_err(|e| AppError::msg(format!("Could not start GitHub sign-in: {e}")))?;

    let status = response.status();
    let body = response
        .text()
        .map_err(|e| AppError::msg(format!("Could not read GitHub response: {e}")))?;

    let parsed: DeviceCodeResponse = serde_json::from_str(&body).map_err(|e| {
        AppError::msg(format!(
            "GitHub device login failed ({status}): {body} ({e})"
        ))
    })?;

    if let Some(err) = parsed.error {
        return Err(AppError::msg(format!(
            "GitHub device login failed: {} — {}",
            err,
            parsed.error_description.unwrap_or_default()
        )));
    }

    Ok(GithubDeviceStartOutput {
        device_code: parsed.device_code,
        user_code: parsed.user_code,
        verification_uri: parsed.verification_uri,
        verification_uri_complete: parsed.verification_uri_complete,
        expires_in: parsed.expires_in,
        interval: parsed.interval.max(1),
    })
}

#[command]
pub fn github_device_login_poll(input: GithubDevicePollInput) -> AppResult<GithubDevicePollOutput> {
    let client_id = input.client_id.trim();
    let device_code = input.device_code.trim();
    if client_id.is_empty() || device_code.is_empty() {
        return Err(AppError::msg("Missing client ID or device code."));
    }

    let client = reqwest::blocking::Client::new();
    let response = client
        .post(TOKEN_URL)
        .header("Accept", "application/json")
        .header("User-Agent", "Branchline")
        .form(&[
            ("client_id", client_id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .map_err(|e| AppError::msg(format!("Could not poll GitHub sign-in: {e}")))?;

    let body = response
        .text()
        .map_err(|e| AppError::msg(format!("Could not read GitHub poll response: {e}")))?;

    let parsed: TokenResponse = serde_json::from_str(&body).map_err(|e| {
        AppError::msg(format!(
            "Could not parse GitHub poll response: {e} ({body})"
        ))
    })?;

    if let Some(token) = parsed.access_token.filter(|t| !t.is_empty()) {
        return Ok(GithubDevicePollOutput {
            status: "complete".into(),
            access_token: Some(token),
            token_type: parsed.token_type,
            scope: parsed.scope,
            error_description: None,
            interval: None,
        });
    }

    let error = parsed.error.unwrap_or_else(|| "unknown".into());
    let status = match error.as_str() {
        "authorization_pending" => "pending",
        "slow_down" => "slow_down",
        "expired_token" => "expired",
        "access_denied" => "denied",
        "incorrect_client_credentials" | "incorrect_device_code" => "error",
        other => other,
    };

    Ok(GithubDevicePollOutput {
        status: status.into(),
        access_token: None,
        token_type: None,
        scope: None,
        error_description: parsed.error_description.or(Some(error)),
        interval: parsed.interval,
    })
}
