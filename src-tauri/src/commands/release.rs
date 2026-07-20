use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{command, AppHandle, Emitter};

use super::branch::MutationOutput;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseProgressPayload {
    path: String,
    phase: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tag: Option<String>,
}

fn emit_release_progress(
    app: &AppHandle,
    path: &Path,
    phase: &str,
    message: &str,
    version: Option<&str>,
    tag: Option<&str>,
) {
    let _ = app.emit(
        "release-progress",
        ReleaseProgressPayload {
            path: path.to_string_lossy().to_string(),
            phase: phase.into(),
            message: message.into(),
            version: version.map(str::to_string),
            tag: tag.map(str::to_string),
        },
    );
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseRepoInput {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePreviewInput {
    pub path: String,
    /// "patch" | "minor" | "major" | explicit "x.y.z"
    pub bump: String,
    #[serde(default)]
    pub preid: Option<String>,
    #[serde(default)]
    pub push: Option<bool>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub tag_message: Option<String>,
    #[serde(default)]
    pub allow_dirty: Option<bool>,
    #[serde(default)]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseConfigInfo {
    pub product_name: String,
    pub tag_prefix: String,
    pub branch: String,
    pub require_clean: bool,
    pub push_default: bool,
    pub commit_message: String,
    pub tag_message: String,
    pub files: Vec<String>,
    pub config_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseStatusOutput {
    pub available: bool,
    pub message: String,
    pub config: Option<ReleaseConfigInfo>,
    pub current_version: Option<String>,
    pub current_branch: Option<String>,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePreviewOutput {
    pub ok: bool,
    pub message: String,
    pub product_name: String,
    pub current_version: String,
    pub next_version: String,
    pub tag: String,
    pub branch: String,
    pub current_branch: String,
    pub require_clean: bool,
    pub dirty: bool,
    pub will_push: bool,
    pub commit_message: String,
    pub tag_message: String,
    pub files: Vec<String>,
    #[serde(default)]
    pub dev_skipped_files: Vec<String>,
    pub blockers: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseFileSpec {
    path: String,
    kind: String,
    #[serde(default)]
    keys: Option<Vec<String>>,
    #[serde(default)]
    package: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseConfig {
    #[serde(default)]
    product_name: Option<String>,
    #[serde(default = "default_tag_prefix")]
    tag_prefix: String,
    #[serde(default = "default_branch")]
    branch: String,
    #[serde(default = "default_true")]
    require_clean: bool,
    #[serde(default)]
    push: bool,
    #[serde(default = "default_commit_message")]
    commit_message: String,
    #[serde(default = "default_tag_message")]
    tag_message: String,
    #[serde(default)]
    files: Vec<ReleaseFileSpec>,
}

fn default_tag_prefix() -> String {
    "v".into()
}
fn default_branch() -> String {
    "main".into()
}
fn default_true() -> bool {
    true
}
fn default_commit_message() -> String {
    "Release {{version}}".into()
}
fn default_tag_message() -> String {
    "{{productName}} {{version}}".into()
}

fn config_path(repo: &Path) -> PathBuf {
    repo.join("release.config.json")
}

fn load_config(repo: &Path) -> AppResult<ReleaseConfig> {
    let path = config_path(repo);
    if !path.exists() {
        return Err(crate::AppError::msg(
            "No release.config.json in this repo. Add one (see release.config.example.jsonc) to enable Release.",
        ));
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| crate::AppError::msg(format!("Could not read release.config.json: {e}")))?;
    let mut cfg: ReleaseConfig = serde_json::from_str(&text)
        .map_err(|e| crate::AppError::msg(format!("Invalid release.config.json: {e}")))?;
    if cfg.files.is_empty() {
        cfg.files.push(ReleaseFileSpec {
            path: "package.json".into(),
            kind: "json".into(),
            keys: Some(vec!["version".into()]),
            package: None,
        });
    }
    Ok(cfg)
}

fn infer_product_name(repo: &Path, cfg: &ReleaseConfig) -> String {
    if let Some(name) = cfg.product_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return name.to_string();
    }
    let tauri = repo.join("src-tauri/tauri.conf.json");
    if tauri.exists() {
        if let Ok(text) = fs::read_to_string(&tauri) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Some(n) = v.get("productName").and_then(|x| x.as_str()) {
                    return n.to_string();
                }
            }
        }
    }
    let pkg = repo.join("package.json");
    if pkg.exists() {
        if let Ok(text) = fs::read_to_string(&pkg) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Some(n) = v.get("name").and_then(|x| x.as_str()) {
                    return n.to_string();
                }
            }
        }
    }
    "App".into()
}

fn read_json_version(path: &Path, keys: &[String]) -> AppResult<String> {
    let text = fs::read_to_string(path)
        .map_err(|e| crate::AppError::msg(format!("Could not read {}: {e}", path.display())))?;
    let data: Value = serde_json::from_str(&text)
        .map_err(|e| crate::AppError::msg(format!("Invalid JSON {}: {e}", path.display())))?;
    let key = keys.first().map(String::as_str).unwrap_or("version");
    let mut cursor = &data;
    for part in key.split('.') {
        cursor = cursor
            .get(part)
            .ok_or_else(|| crate::AppError::msg(format!("Missing key {key} in {}", path.display())))?;
    }
    cursor
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| crate::AppError::msg(format!("Key {key} is not a string in {}", path.display())))
}

fn current_version(repo: &Path, cfg: &ReleaseConfig) -> AppResult<String> {
    let pkg = repo.join("package.json");
    if pkg.exists() {
        return read_json_version(&pkg, &["version".into()]);
    }
    for file in &cfg.files {
        if file.kind == "json" {
            let keys = file.keys.clone().unwrap_or_else(|| vec!["version".into()]);
            return read_json_version(&repo.join(&file.path), &keys);
        }
    }
    Err(crate::AppError::msg(
        "Could not find a version source (package.json or a json file in release.config.json)",
    ))
}

fn parse_semver(version: &str) -> AppResult<(u64, u64, u64, Vec<String>)> {
    let trimmed = version.trim();
    let (core, pre) = match trimmed.split_once('-') {
        Some((c, rest)) => {
            let pre = rest.split('+').next().unwrap_or(rest);
            (
                c,
                pre.split('.')
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>(),
            )
        }
        None => (trimmed.split('+').next().unwrap_or(trimmed), Vec::new()),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return Err(crate::AppError::msg(format!("Invalid semver: {version}")));
    }
    let major = parts[0]
        .parse()
        .map_err(|_| crate::AppError::msg(format!("Invalid semver: {version}")))?;
    let minor = parts[1]
        .parse()
        .map_err(|_| crate::AppError::msg(format!("Invalid semver: {version}")))?;
    let patch = parts[2]
        .parse()
        .map_err(|_| crate::AppError::msg(format!("Invalid semver: {version}")))?;
    Ok((major, minor, patch, pre))
}

fn bump_version(current: &str, bump: &str, preid: Option<&str>) -> AppResult<String> {
    let bump = bump.trim();
    if bump.chars().next().is_some_and(|c| c.is_ascii_digit()) && bump.contains('.') {
        let _ = parse_semver(bump)?;
        return Ok(bump.to_string());
    }
    if !matches!(bump, "patch" | "minor" | "major") {
        return Err(crate::AppError::msg(format!(
            "Unknown bump \"{bump}\". Use patch, minor, major, or an explicit x.y.z"
        )));
    }

    let (mut major, mut minor, mut patch, mut prerelease) = parse_semver(current)?;

    if let Some(id) = preid.map(str::trim).filter(|s| !s.is_empty()) {
        let same_pre = prerelease.first().map(String::as_str) == Some(id)
            && prerelease.len() >= 2
            && prerelease[1].chars().all(|c| c.is_ascii_digit());
        if same_pre {
            let n: u64 = prerelease[1].parse().unwrap_or(0);
            prerelease = vec![id.to_string(), (n + 1).to_string()];
        } else {
            match bump {
                "major" => {
                    major += 1;
                    minor = 0;
                    patch = 0;
                }
                "minor" => {
                    minor += 1;
                    patch = 0;
                }
                _ => patch += 1,
            }
            prerelease = vec![id.to_string(), "0".into()];
        }
        return Ok(format!("{major}.{minor}.{patch}-{}", prerelease.join(".")));
    }

    if !prerelease.is_empty() {
        return Ok(format!("{major}.{minor}.{patch}"));
    }

    match bump {
        "major" => {
            major += 1;
            minor = 0;
            patch = 0;
        }
        "minor" => {
            minor += 1;
            patch = 0;
        }
        _ => patch += 1,
    }
    Ok(format!("{major}.{minor}.{patch}"))
}

fn template(text: &str, version: &str, previous: &str, tag: &str, product: &str) -> String {
    text.replace("{{version}}", version)
        .replace("{{previousVersion}}", previous)
        .replace("{{tag}}", tag)
        .replace("{{productName}}", product)
}

fn set_json_keys(path: &Path, keys: &[String], version: &str) -> AppResult<()> {
    let text = fs::read_to_string(path)
        .map_err(|e| crate::AppError::msg(format!("Could not read {}: {e}", path.display())))?;
    let mut data: Value = serde_json::from_str(&text)
        .map_err(|e| crate::AppError::msg(format!("Invalid JSON {}: {e}", path.display())))?;
    for key in keys {
        let parts: Vec<&str> = key.split('.').collect();
        let mut cursor = &mut data;
        for part in &parts[..parts.len().saturating_sub(1)] {
            cursor = cursor
                .get_mut(*part)
                .ok_or_else(|| crate::AppError::msg(format!("Cannot set {key} in {}", path.display())))?;
        }
        let last = parts.last().copied().unwrap_or("version");
        let obj = cursor
            .as_object_mut()
            .ok_or_else(|| crate::AppError::msg(format!("Cannot set {key} in {}", path.display())))?;
        obj.insert(last.to_string(), Value::String(version.to_string()));
    }
    let out = format!(
        "{}\n",
        serde_json::to_string_pretty(&data)
            .map_err(|e| crate::AppError::msg(format!("Could not serialize {}: {e}", path.display())))?
    );
    fs::write(path, out)
        .map_err(|e| crate::AppError::msg(format!("Could not write {}: {e}", path.display())))?;
    Ok(())
}

fn set_toml_package_version(path: &Path, version: &str) -> AppResult<()> {
    let text = fs::read_to_string(path)
        .map_err(|e| crate::AppError::msg(format!("Could not read {}: {e}", path.display())))?;
    let next = replace_toml_package_version(&text, version).ok_or_else(|| {
        crate::AppError::msg(format!("Could not find [package] version in {}", path.display()))
    })?;
    fs::write(path, next)
        .map_err(|e| crate::AppError::msg(format!("Could not write {}: {e}", path.display())))?;
    Ok(())
}

fn replace_toml_package_version(text: &str, version: &str) -> Option<String> {
    let mut out = String::new();
    let mut in_package = false;
    let mut replaced = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_package = trimmed == "[package]";
        }
        if in_package && !replaced && trimmed.starts_with("version") && trimmed.contains('=') {
            let indent = line.len() - line.trim_start().len();
            out.push_str(&" ".repeat(indent));
            out.push_str("version = \"");
            out.push_str(version);
            out.push_str("\"\n");
            replaced = true;
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if !text.ends_with('\n') && out.ends_with('\n') {
        out.pop();
    }
    if replaced {
        Some(out)
    } else {
        None
    }
}

fn set_cargo_lock_package_version(path: &Path, package_name: &str, version: &str) -> AppResult<()> {
    let text = fs::read_to_string(path)
        .map_err(|e| crate::AppError::msg(format!("Could not read {}: {e}", path.display())))?;
    let needle = format!("name = \"{package_name}\"\nversion = \"");
    let Some(idx) = text.find(&needle) else {
        return Err(crate::AppError::msg(format!(
            "Could not find package \"{package_name}\" in {}",
            path.display()
        )));
    };
    let start = idx + needle.len();
    let rest = &text[start..];
    let end_rel = rest
        .find('"')
        .ok_or_else(|| crate::AppError::msg(format!("Malformed version in {}", path.display())))?;
    let mut next = String::with_capacity(text.len());
    next.push_str(&text[..start]);
    next.push_str(version);
    next.push_str(&rest[end_rel..]);
    fs::write(path, next)
        .map_err(|e| crate::AppError::msg(format!("Could not write {}: {e}", path.display())))?;
    Ok(())
}

fn is_cargo_watch_file(kind: &str) -> bool {
    matches!(kind, "toml-package-version" | "cargo-lock-package")
}

fn should_skip_dev_watch_write(file: &ReleaseFileSpec) -> bool {
    if !cfg!(debug_assertions) {
        return false;
    }
    is_cargo_watch_file(&file.kind)
        || file.path.replace('\\', "/").starts_with("src-tauri/")
}

struct ApplyFilesResult {
    changed: Vec<String>,
    dev_skipped: Vec<String>,
}

fn apply_files(repo: &Path, files: &[ReleaseFileSpec], version: &str, dry_run: bool) -> AppResult<ApplyFilesResult> {
    let mut ordered: Vec<&ReleaseFileSpec> = files.iter().collect();
    ordered.sort_by_key(|f| is_cargo_watch_file(&f.kind));

    let mut changed = Vec::new();
    let mut dev_skipped = Vec::new();
    for file in ordered {
        let path = repo.join(&file.path);
        if !path.exists() {
            return Err(crate::AppError::msg(format!("Missing file: {}", file.path)));
        }
        if should_skip_dev_watch_write(file) {
            dev_skipped.push(file.path.clone());
            continue;
        }
        changed.push(file.path.clone());
        if dry_run {
            continue;
        }
        match file.kind.as_str() {
            "json" => {
                let keys = file.keys.clone().unwrap_or_else(|| vec!["version".into()]);
                set_json_keys(&path, &keys, version)?;
            }
            "toml-package-version" => set_toml_package_version(&path, version)?,
            "cargo-lock-package" => {
                let pkg = file.package.as_deref().unwrap_or("app");
                set_cargo_lock_package_version(&path, pkg, version)?;
            }
            other => {
                return Err(crate::AppError::msg(format!(
                    "Unknown file kind \"{other}\" for {}",
                    file.path
                )));
            }
        }
    }
    Ok(ApplyFilesResult {
        changed,
        dev_skipped,
    })
}

fn build_preview(repo: &Path, input: &ReleasePreviewInput) -> AppResult<ReleasePreviewOutput> {
    let cfg = load_config(repo)?;
    let product_name = infer_product_name(repo, &cfg);
    let current = current_version(repo, &cfg)?;
    let next = bump_version(
        &current,
        &input.bump,
        input.preid.as_deref(),
    )?;
    let tag = format!("{}{next}", cfg.tag_prefix);
    let branch = input
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(cfg.branch.as_str())
        .to_string();
    let current_branch = git_cli::run_git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    let dirty = !git_cli::run_git(repo, &["status", "--porcelain"])?
        .trim()
        .is_empty();
    let require_clean = if input.allow_dirty.unwrap_or(false) {
        false
    } else {
        cfg.require_clean
    };
    let will_push = input.push.unwrap_or(cfg.push);
    let commit_message = template(
        input
            .message
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&cfg.commit_message),
        &next,
        &current,
        &tag,
        &product_name,
    );
    let tag_message = template(
        input
            .tag_message
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&cfg.tag_message),
        &next,
        &current,
        &tag,
        &product_name,
    );
    let applied = apply_files(repo, &cfg.files, &next, true)?;
    let files = applied.changed;
    let dev_skipped_files = applied.dev_skipped;

    let mut blockers = Vec::new();
    if current_branch != branch {
        blockers.push(format!(
            "On branch \"{current_branch}\", expected \"{branch}\""
        ));
    }
    if require_clean && dirty {
        blockers.push("Working tree is dirty. Commit or stash first.".into());
    }
    let (tag_exists, _, _) =
        git_cli::run_git_allow_fail(repo, &["rev-parse", "-q", "--verify", &format!("refs/tags/{tag}")]);
    if tag_exists {
        blockers.push(format!("Tag {tag} already exists"));
    }
    if files.is_empty() && !dev_skipped_files.is_empty() {
        blockers.push(
            "No version files can be updated in this dev build. Use npm run release from a terminal."
                .into(),
        );
    }

    Ok(ReleasePreviewOutput {
        ok: blockers.is_empty(),
        message: if blockers.is_empty() {
            if dev_skipped_files.is_empty() {
                format!("Ready to release {product_name} {current} → {next}")
            } else {
                format!(
                    "Ready to release {product_name} {current} → {next} (dev: skipping {} tauri:dev watch file(s))",
                    dev_skipped_files.len()
                )
            }
        } else {
            blockers.join(" · ")
        },
        product_name,
        current_version: current,
        next_version: next,
        tag,
        branch,
        current_branch,
        require_clean,
        dirty,
        will_push,
        commit_message,
        tag_message,
        files,
        dev_skipped_files,
        blockers,
    })
}

#[command]
pub fn get_release_status(input: ReleaseRepoInput) -> AppResult<ReleaseStatusOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let cfg_path = config_path(path);
        if !cfg_path.exists() {
            return Ok(ReleaseStatusOutput {
                available: false,
                message: "Add release.config.json to enable Release for this repo.".into(),
                config: None,
                current_version: None,
                current_branch: git_cli::run_git(path, &["rev-parse", "--abbrev-ref", "HEAD"])
                    .ok()
                    .map(|s| s.trim().to_string()),
                dirty: git_cli::run_git(path, &["status", "--porcelain"])
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false),
            });
        }
        let cfg = load_config(path)?;
        let product_name = infer_product_name(path, &cfg);
        let current = current_version(path, &cfg).ok();
        let current_branch = git_cli::run_git(path, &["rev-parse", "--abbrev-ref", "HEAD"])
            .ok()
            .map(|s| s.trim().to_string());
        let dirty = git_cli::run_git(path, &["status", "--porcelain"])
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        Ok(ReleaseStatusOutput {
            available: true,
            message: format!(
                "{} release ready{}",
                product_name,
                current
                    .as_deref()
                    .map(|v| format!(" (currently {v})"))
                    .unwrap_or_default()
            ),
            config: Some(ReleaseConfigInfo {
                product_name,
                tag_prefix: cfg.tag_prefix,
                branch: cfg.branch,
                require_clean: cfg.require_clean,
                push_default: cfg.push,
                commit_message: cfg.commit_message,
                tag_message: cfg.tag_message,
                files: cfg.files.iter().map(|f| f.path.clone()).collect(),
                config_path: cfg_path.to_string_lossy().to_string(),
            }),
            current_version: current,
            current_branch,
            dirty,
        })
    })
}

#[command]
pub fn preview_release(input: ReleasePreviewInput) -> AppResult<ReleasePreviewOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| build_preview(path, &input))
}

#[command]
pub fn run_release(app: AppHandle, input: ReleasePreviewInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        emit_release_progress(
            &app,
            path,
            "preparing",
            "Checking release preconditions…",
            None,
            None,
        );
        let preview = build_preview(path, &input)?;
        if !preview.blockers.is_empty() {
            let message = preview.blockers.join(" · ");
            emit_release_progress(&app, path, "error", &message, None, None);
            return Ok(MutationOutput {
                ok: false,
                message,
            });
        }
        let cfg = load_config(path)?;
        let bump_message = if preview.dev_skipped_files.is_empty() {
            format!("Bumping version files to {}…", preview.next_version)
        } else {
            format!(
                "Bumping {} file(s) to {}… (skipping {} under tauri:dev)",
                preview.files.len(),
                preview.next_version,
                preview.dev_skipped_files.len()
            )
        };
        emit_release_progress(
            &app,
            path,
            "bumping",
            &bump_message,
            Some(&preview.next_version),
            Some(&preview.tag),
        );
        let applied = apply_files(path, &cfg.files, &preview.next_version, false)?;
        let changed = applied.changed;
        emit_release_progress(
            &app,
            path,
            "staging",
            &format!("Staging {} file(s)…", changed.len()),
            Some(&preview.next_version),
            Some(&preview.tag),
        );
        let add_args: Vec<&str> = std::iter::once("add")
            .chain(std::iter::once("--"))
            .chain(changed.iter().map(String::as_str))
            .collect();
        git_cli::run_git(path, &add_args)?;
        emit_release_progress(
            &app,
            path,
            "committing",
            "Creating release commit…",
            Some(&preview.next_version),
            Some(&preview.tag),
        );
        git_cli::run_git(path, &["commit", "-m", &preview.commit_message])?;
        emit_release_progress(
            &app,
            path,
            "tagging",
            &format!("Creating tag {}…", preview.tag),
            Some(&preview.next_version),
            Some(&preview.tag),
        );
        git_cli::run_git(
            path,
            &["tag", "-a", &preview.tag, "-m", &preview.tag_message],
        )?;
        if preview.will_push {
            emit_release_progress(
                &app,
                path,
                "pushing",
                "Pushing commit and tags to origin…",
                Some(&preview.next_version),
                Some(&preview.tag),
            );
            git_cli::run_git(path, &["push", "origin", "HEAD", "--tags"])?;
            let mut message = format!(
                "Released {} {} and pushed {}",
                preview.product_name, preview.next_version, preview.tag
            );
            if !preview.dev_skipped_files.is_empty() {
                message.push_str(
                    " — run npm run release from a terminal to sync Cargo/tauri.conf versions",
                );
            }
            emit_release_progress(
                &app,
                path,
                "done",
                &message,
                Some(&preview.next_version),
                Some(&preview.tag),
            );
            return Ok(MutationOutput {
                ok: true,
                message,
            });
        }
        let mut message = format!(
            "Released {} {} ({}) — push when ready",
            preview.product_name, preview.next_version, preview.tag
        );
        if !preview.dev_skipped_files.is_empty() {
            message.push_str(" — run npm run release from a terminal to sync Cargo/tauri.conf versions");
        }
        emit_release_progress(
            &app,
            path,
            "done",
            &message,
            Some(&preview.next_version),
            Some(&preview.tag),
        );
        Ok(MutationOutput {
            ok: true,
            message,
        })
    })
}
