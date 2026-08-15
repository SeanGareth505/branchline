use crate::infrastructure::{git_cli, sqlite};
use crate::state::AppState;
use crate::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{command, State};

const SETTINGS_KEY: &str = "repo_checks_json";
const RUN_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_OUTPUT_BYTES: usize = 512 * 1024;

const HOOK_TRIGGERS: &[&str] = &["pre-commit", "commit-msg", "pre-push"];
const SKIP_HOOK_KEYS: &[&str] = &[
    "commands",
    "scripts",
    "jobs",
    "parallel",
    "piped",
    "follow",
    "skip",
    "glob",
    "exclude",
    "root",
    "env",
    "stage_fixed",
    "fail_text",
    "min_version",
    "output",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCheck {
    pub id: String,
    pub name: String,
    pub command: String,
    pub trigger: String,
    pub source: String,
    pub source_label: String,
    pub enabled: bool,
    pub builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckManager {
    pub id: String,
    pub label: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoChecksOutput {
    pub path: String,
    pub managers: Vec<CheckManager>,
    pub checks: Vec<RepoCheck>,
    pub newly_detected: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPathInput {
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCheckScriptInput {
    pub path: String,
    pub id: Option<String>,
    pub name: String,
    pub command: String,
    pub trigger: String,
    pub enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckIdInput {
    pub path: String,
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCheckEnabledInput {
    pub path: String,
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCheckInput {
    pub path: String,
    pub command: String,
    pub trigger: Option<String>,
    pub commit_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCheckOutput {
    pub ok: bool,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCustomCheck {
    id: String,
    name: String,
    command: String,
    trigger: String,
    #[serde(default = "default_true")]
    enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRepoChecks {
    #[serde(default)]
    custom: Vec<StoredCustomCheck>,
    #[serde(default)]
    disabled_ids: Vec<String>,
    #[serde(default)]
    known_managers: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAll {
    #[serde(default)]
    by_repo: HashMap<String, StoredRepoChecks>,
}

#[command]
pub fn list_repo_checks(
    state: State<'_, AppState>,
    input: RepoPathInput,
) -> AppResult<RepoChecksOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let detected = detect_repo_checks(&path)?;

    let db = state
        .db
        .lock()
        .map_err(|_| AppError::msg("Database lock poisoned"))?;
    let mut stored_all = load_stored(&db)?;
    let key = repo_key(&path);
    let mut repo_stored = stored_all.by_repo.get(&key).cloned().unwrap_or_default();

    let mut newly_detected = Vec::new();
    for manager in &detected.managers {
        if !repo_stored
            .known_managers
            .iter()
            .any(|id| id == &manager.id)
        {
            newly_detected.push(manager.label.clone());
            repo_stored.known_managers.push(manager.id.clone());
        }
    }
    if !newly_detected.is_empty() {
        stored_all.by_repo.insert(key.clone(), repo_stored.clone());
        save_stored(&db, &stored_all)?;
    }

    Ok(merge_checks(
        &path,
        detected.managers,
        detected.checks,
        &repo_stored,
        newly_detected,
    ))
}

#[command]
pub fn save_check_script(
    state: State<'_, AppState>,
    input: SaveCheckScriptInput,
) -> AppResult<RepoChecksOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let name = input.name.trim().to_string();
    let command = input.command.trim().to_string();
    if name.is_empty() {
        return Err(AppError::msg("Check name is required"));
    }
    if command.is_empty() {
        return Err(AppError::msg("Command is required"));
    }
    let trigger = normalize_trigger(&input.trigger);

    let db = state
        .db
        .lock()
        .map_err(|_| AppError::msg("Database lock poisoned"))?;
    let mut stored_all = load_stored(&db)?;
    let key = repo_key(&path);
    let repo_stored = stored_all.by_repo.entry(key).or_default();

    if let Some(id) = input.id.as_ref().filter(|s| !s.trim().is_empty()) {
        let Some(existing) = repo_stored.custom.iter_mut().find(|c| &c.id == id) else {
            return Err(AppError::msg("Script not found"));
        };
        existing.name = name;
        existing.command = command;
        existing.trigger = trigger;
        if let Some(enabled) = input.enabled {
            existing.enabled = enabled;
        }
    } else {
        repo_stored.custom.push(StoredCustomCheck {
            id: format!("custom-{}", uuid::Uuid::new_v4().simple()),
            name,
            command,
            trigger,
            enabled: input.enabled.unwrap_or(true),
        });
    }

    save_stored(&db, &stored_all)?;
    drop(db);
    list_repo_checks_inner(&path, &state)
}

#[command]
pub fn delete_check_script(
    state: State<'_, AppState>,
    input: CheckIdInput,
) -> AppResult<RepoChecksOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    if !input.id.starts_with("custom-") {
        return Err(AppError::msg("Detected checks cannot be deleted — disable them instead"));
    }

    let db = state
        .db
        .lock()
        .map_err(|_| AppError::msg("Database lock poisoned"))?;
    let mut stored_all = load_stored(&db)?;
    let key = repo_key(&path);
    let repo_stored = stored_all.by_repo.entry(key).or_default();
    let before = repo_stored.custom.len();
    repo_stored.custom.retain(|c| c.id != input.id);
    if repo_stored.custom.len() == before {
        return Err(AppError::msg("Script not found"));
    }
    save_stored(&db, &stored_all)?;
    drop(db);
    list_repo_checks_inner(&path, &state)
}

#[command]
pub fn set_check_enabled(
    state: State<'_, AppState>,
    input: SetCheckEnabledInput,
) -> AppResult<RepoChecksOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;

    let db = state
        .db
        .lock()
        .map_err(|_| AppError::msg("Database lock poisoned"))?;
    let mut stored_all = load_stored(&db)?;
    let key = repo_key(&path);
    let repo_stored = stored_all.by_repo.entry(key).or_default();

    if let Some(custom) = repo_stored.custom.iter_mut().find(|c| c.id == input.id) {
        custom.enabled = input.enabled;
    } else if input.enabled {
        repo_stored.disabled_ids.retain(|id| id != &input.id);
    } else if !repo_stored.disabled_ids.iter().any(|id| id == &input.id) {
        repo_stored.disabled_ids.push(input.id.clone());
    }

    save_stored(&db, &stored_all)?;
    drop(db);
    list_repo_checks_inner(&path, &state)
}

#[command]
pub fn run_repo_check(input: RunCheckInput) -> AppResult<RunCheckOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let command = input.command.trim();
    if command.is_empty() {
        return Err(AppError::msg("Command is required"));
    }
    let trigger = input
        .trigger
        .as_deref()
        .map(normalize_trigger)
        .unwrap_or_else(|| "pre-commit".into());
    run_shell_command(&path, command, &trigger, input.commit_message.as_deref())
}

fn list_repo_checks_inner(path: &Path, state: &State<'_, AppState>) -> AppResult<RepoChecksOutput> {
    let detected = detect_repo_checks(path)?;
    let db = state
        .db
        .lock()
        .map_err(|_| AppError::msg("Database lock poisoned"))?;
    let stored_all = load_stored(&db)?;
    let repo_stored = stored_all
        .by_repo
        .get(&repo_key(path))
        .cloned()
        .unwrap_or_default();
    Ok(merge_checks(
        path,
        detected.managers,
        detected.checks,
        &repo_stored,
        Vec::new(),
    ))
}

fn load_stored(db: &rusqlite::Connection) -> AppResult<StoredAll> {
    match sqlite::get_setting(db, SETTINGS_KEY)? {
        Some(raw) => Ok(serde_json::from_str(&raw).unwrap_or_default()),
        None => Ok(StoredAll::default()),
    }
}

fn save_stored(db: &rusqlite::Connection, stored: &StoredAll) -> AppResult<()> {
    let raw = serde_json::to_string(stored).map_err(|e| AppError::msg(e.to_string()))?;
    sqlite::set_setting(db, SETTINGS_KEY, &raw)
}

fn repo_key(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

struct Detected {
    managers: Vec<CheckManager>,
    checks: Vec<RepoCheck>,
}

fn detect_repo_checks(path: &Path) -> AppResult<Detected> {
    let mut managers = Vec::new();
    let mut checks = Vec::new();
    let mut used_ids = std::collections::HashSet::new();

    let hooks_path = git_hooks_path(path);
    let husky_dir = path.join(".husky");
    let has_husky = husky_dir.is_dir();

    if has_husky {
        managers.push(CheckManager {
            id: "husky".into(),
            label: "Husky".into(),
            detail: ".husky/".into(),
        });
        for check in parse_hook_dir(&husky_dir, "husky", "Husky") {
            push_unique(&mut checks, &mut used_ids, check);
        }
    }

    if let Some(lefthook) = detect_lefthook(path) {
        managers.push(CheckManager {
            id: "lefthook".into(),
            label: "Lefthook".into(),
            detail: lefthook.detail,
        });
        for check in lefthook.checks {
            push_unique(&mut checks, &mut used_ids, check);
        }
    }

    if let Some(pre_commit) = detect_pre_commit_framework(path) {
        managers.push(CheckManager {
            id: "pre-commit".into(),
            label: "pre-commit".into(),
            detail: pre_commit.detail,
        });
        for check in pre_commit.checks {
            push_unique(&mut checks, &mut used_ids, check);
        }
    }

    if let Some(simple) = detect_simple_git_hooks(path) {
        managers.push(CheckManager {
            id: "simple-git-hooks".into(),
            label: "simple-git-hooks".into(),
            detail: "package.json".into(),
        });
        for check in simple {
            push_unique(&mut checks, &mut used_ids, check);
        }
    }

    if let Some(legacy) = detect_package_json_husky(path) {
        if !has_husky {
            managers.push(CheckManager {
                id: "husky".into(),
                label: "Husky".into(),
                detail: "package.json".into(),
            });
        }
        for check in legacy {
            push_unique(&mut checks, &mut used_ids, check);
        }
    }

    let skip_git_hooks = has_husky
        || managers.iter().any(|m| m.id == "lefthook" || m.id == "simple-git-hooks");
    if !skip_git_hooks {
        if let Some(dir) = hooks_path {
            if dir.is_dir() {
                let rel = dir
                    .strip_prefix(path)
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|_| dir.display().to_string());
                let parsed = parse_hook_dir(&dir, "git", "Git hooks");
                if !parsed.is_empty() {
                    managers.push(CheckManager {
                        id: "git".into(),
                        label: "Git hooks".into(),
                        detail: rel,
                    });
                    for check in parsed {
                        push_unique(&mut checks, &mut used_ids, check);
                    }
                }
            }
        }
    }

    Ok(Detected { managers, checks })
}

fn push_unique(
    checks: &mut Vec<RepoCheck>,
    used_ids: &mut std::collections::HashSet<String>,
    mut check: RepoCheck,
) {
    let mut id = check.id.clone();
    let mut n = 2;
    while used_ids.contains(&id) {
        id = format!("{}-{n}", check.id);
        n += 1;
    }
    check.id = id.clone();
    used_ids.insert(id);
    checks.push(check);
}

fn merge_checks(
    path: &Path,
    managers: Vec<CheckManager>,
    mut checks: Vec<RepoCheck>,
    stored: &StoredRepoChecks,
    newly_detected: Vec<String>,
) -> RepoChecksOutput {
    for check in &mut checks {
        check.enabled = !stored.disabled_ids.iter().any(|id| id == &check.id);
    }
    for custom in &stored.custom {
        checks.push(RepoCheck {
            id: custom.id.clone(),
            name: custom.name.clone(),
            command: custom.command.clone(),
            trigger: custom.trigger.clone(),
            source: "custom".into(),
            source_label: "Branchline".into(),
            enabled: custom.enabled,
            builtin: false,
        });
    }
    RepoChecksOutput {
        path: path.display().to_string(),
        managers,
        checks,
        newly_detected,
    }
}

fn git_hooks_path(repo: &Path) -> Option<PathBuf> {
    let configured = git_cli::run_git(repo, &["config", "--get", "core.hooksPath"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(raw) = configured {
        let p = PathBuf::from(&raw);
        Some(if p.is_absolute() {
            p
        } else {
            repo.join(p)
        })
    } else {
        Some(repo.join(".git").join("hooks"))
    }
}

fn parse_hook_dir(dir: &Path, source: &str, source_label: &str) -> Vec<RepoCheck> {
    let entries = match std::fs::read_dir(dir) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut checks = Vec::new();
    let mut names: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "_" || name.ends_with(".sample") {
                return None;
            }
            let path = e.path();
            if path.is_dir() {
                return None;
            }
            Some((name, path))
        })
        .collect();
    names.sort_by(|a, b| a.0.cmp(&b.0));

    for (hook_name, file) in names {
        let trigger = hook_trigger(&hook_name);
        if trigger == "manual" && !HOOK_TRIGGERS.contains(&hook_name.as_str()) {
            continue;
        }
        let contents = std::fs::read_to_string(&file).unwrap_or_default();
        if is_sample_or_empty_hook(&contents) {
            continue;
        }
        let commands = parse_hook_script(&contents);
        if commands.is_empty() {
            let cmd = format!("sh {}", file.display());
            checks.push(make_check(
                source,
                source_label,
                &hook_name,
                &friendly_hook_title(&hook_name, &cmd),
                &cmd,
                &trigger,
            ));
            continue;
        }
        for command in commands {
            let name = friendly_hook_title(&hook_name, &command);
            checks.push(make_check(
                source,
                source_label,
                &hook_name,
                &name,
                &command,
                &trigger,
            ));
        }
    }
    checks
}

fn is_sample_or_empty_hook(contents: &str) -> bool {
    let meaningful: Vec<&str> = contents
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("set "))
        .collect();
    meaningful.is_empty()
}

pub(crate) fn parse_hook_script(contents: &str) -> Vec<String> {
    let mut commands = Vec::new();
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with("set ") || trimmed.starts_with("set\t") {
            continue;
        }
        if trimmed.contains("husky.sh") || trimmed.contains("husky.local.sh") {
            continue;
        }
        if trimmed.starts_with('.') || trimmed.starts_with("source ") {
            continue;
        }
        if trimmed == "exit 0" || trimmed == "true" {
            continue;
        }
        commands.push(trimmed.to_string());
    }
    commands
}

struct NamedDetected {
    detail: String,
    checks: Vec<RepoCheck>,
}

fn detect_lefthook(path: &Path) -> Option<NamedDetected> {
    const FILES: &[&str] = &[
        "lefthook.yml",
        "lefthook.yaml",
        ".lefthook.yml",
        ".lefthook.yaml",
    ];
    for file in FILES {
        let full = path.join(file);
        if !full.is_file() {
            continue;
        }
        let contents = std::fs::read_to_string(&full).ok()?;
        let parsed = parse_lefthook_yaml(&contents);
        if parsed.is_empty() {
            continue;
        }
        let checks = parsed
            .into_iter()
            .map(|(trigger, name, command)| {
                make_check("lefthook", "Lefthook", &trigger, &name, &command, &trigger)
            })
            .collect();
        return Some(NamedDetected {
            detail: (*file).into(),
            checks,
        });
    }
    None
}

pub(crate) fn parse_lefthook_yaml(contents: &str) -> Vec<(String, String, String)> {
    let mut trigger: Option<String> = None;
    let mut cmd_name = String::new();
    let mut results = Vec::new();

    for line in contents.lines() {
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if indent == 0 && trimmed.ends_with(':') {
            let key = trimmed.trim_end_matches(':').trim();
            if is_hook_name(key) {
                trigger = Some(normalize_trigger(key));
                cmd_name.clear();
            } else {
                trigger = None;
            }
            continue;
        }
        let Some(current) = trigger.as_ref() else {
            continue;
        };
        if let Some(rest) = trimmed.strip_prefix("run:") {
            let command = unquote(rest.trim());
            if command.is_empty() {
                continue;
            }
            let name = if cmd_name.is_empty() {
                friendly_name(&command)
            } else {
                title_words(&cmd_name)
            };
            results.push((current.clone(), name, command));
            continue;
        }
        if trimmed.ends_with(':') {
            let key = trimmed.trim_end_matches(':').trim();
            if !SKIP_HOOK_KEYS.contains(&key) {
                cmd_name = key.to_string();
            }
        }
    }
    results
}

fn detect_pre_commit_framework(path: &Path) -> Option<NamedDetected> {
    const FILES: &[&str] = &[".pre-commit-config.yaml", ".pre-commit-config.yml"];
    for file in FILES {
        let full = path.join(file);
        if !full.is_file() {
            continue;
        }
        let contents = std::fs::read_to_string(&full).ok()?;
        let parsed = parse_pre_commit_config(&contents);
        if parsed.is_empty() {
            continue;
        }
        let checks = parsed
            .into_iter()
            .map(|(id, name, trigger)| {
                make_check(
                    "pre-commit",
                    "pre-commit",
                    &trigger,
                    &name,
                    &format!("pre-commit run {id} --hook-stage {trigger}"),
                    &trigger,
                )
            })
            .collect();
        return Some(NamedDetected {
            detail: (*file).into(),
            checks,
        });
    }
    None
}

pub(crate) fn parse_pre_commit_config(contents: &str) -> Vec<(String, String, String)> {
    let mut id: Option<String> = None;
    let mut name: Option<String> = None;
    let mut trigger = "pre-commit".to_string();
    let mut results = Vec::new();

    for line in contents.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed
            .strip_prefix("- id:")
            .or_else(|| trimmed.strip_prefix("id:"))
        {
            if let Some(prev) = id.take() {
                results.push((
                    prev.clone(),
                    name.take().unwrap_or_else(|| title_words(&prev)),
                    trigger.clone(),
                ));
            }
            id = Some(unquote(rest.trim()));
            name = None;
            trigger = "pre-commit".into();
        } else if trimmed.starts_with("name:") && id.is_some() {
            name = Some(unquote(trimmed["name:".len()..].trim()));
        } else if trimmed.starts_with("stages:") && id.is_some() {
            let rest = trimmed["stages:".len()..].to_lowercase();
            if rest.contains("commit-msg") {
                trigger = "commit-msg".into();
            } else if rest.contains("push") {
                trigger = "pre-push".into();
            }
        }
    }
    if let Some(prev) = id {
        results.push((
            prev.clone(),
            name.unwrap_or_else(|| title_words(&prev)),
            trigger,
        ));
    }
    results
}

fn detect_simple_git_hooks(path: &Path) -> Option<Vec<RepoCheck>> {
    let package = read_package_json(path)?;
    let hooks = package.get("simple-git-hooks")?.as_object()?;
    let mut checks = Vec::new();
    for (hook, value) in hooks {
        let command = json_command(value)?;
        let trigger = hook_trigger(hook);
        checks.push(make_check(
            "simple-git-hooks",
            "simple-git-hooks",
            hook,
            &friendly_hook_title(hook, &command),
            &command,
            &trigger,
        ));
    }
    if checks.is_empty() {
        None
    } else {
        Some(checks)
    }
}

fn detect_package_json_husky(path: &Path) -> Option<Vec<RepoCheck>> {
    let package = read_package_json(path)?;
    let hooks = package.get("husky")?.get("hooks")?.as_object()?;
    let mut checks = Vec::new();
    for (hook, value) in hooks {
        let command = json_command(value)?;
        let trigger = hook_trigger(hook);
        checks.push(make_check(
            "husky",
            "Husky",
            hook,
            &friendly_hook_title(hook, &command),
            &command,
            &trigger,
        ));
    }
    if checks.is_empty() {
        None
    } else {
        Some(checks)
    }
}

fn read_package_json(path: &Path) -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(path.join("package.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

fn json_command(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        serde_json::Value::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join(" && "))
            }
        }
        _ => None,
    }
}

fn make_check(
    source: &str,
    source_label: &str,
    _hook: &str,
    name: &str,
    command: &str,
    trigger: &str,
) -> RepoCheck {
    RepoCheck {
        id: check_id(source, trigger, name, command),
        name: name.to_string(),
        command: command.to_string(),
        trigger: trigger.to_string(),
        source: source.to_string(),
        source_label: source_label.to_string(),
        enabled: true,
        builtin: true,
    }
}

fn check_id(source: &str, trigger: &str, name: &str, command: &str) -> String {
    let mut slug = slugify(name);
    if slug.is_empty() {
        slug = slugify(command);
    }
    if slug.is_empty() {
        slug = slugify(trigger);
    }
    format!("{source}:{trigger}:{slug}")
}

fn slugify(value: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            dash = false;
        } else if !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
    }
    out.trim_matches('-').chars().take(40).collect()
}

fn hook_trigger(name: &str) -> String {
    match name.trim() {
        "pre-commit" | "prepare-commit-msg" => "pre-commit".into(),
        "commit-msg" => "commit-msg".into(),
        "pre-push" => "pre-push".into(),
        other if is_hook_name(other) => normalize_trigger(other),
        _ => "manual".into(),
    }
}

fn is_hook_name(name: &str) -> bool {
    matches!(
        name,
        "pre-commit"
            | "prepare-commit-msg"
            | "commit-msg"
            | "post-commit"
            | "pre-push"
            | "pre-rebase"
            | "post-checkout"
            | "post-merge"
            | "post-rewrite"
            | "pre-auto-gc"
            | "applypatch-msg"
            | "pre-applypatch"
            | "post-applypatch"
    )
}

fn normalize_trigger(value: &str) -> String {
    match value.trim() {
        "pre-commit" | "commit" => "pre-commit".into(),
        "commit-msg" | "message" => "commit-msg".into(),
        "pre-push" | "push" => "pre-push".into(),
        "manual" => "manual".into(),
        other => other.to_string(),
    }
}

fn friendly_hook_title(hook: &str, command: &str) -> String {
    let named = friendly_name(command);
    if named != command {
        return named;
    }
    match hook {
        "pre-commit" => "Pre-commit".into(),
        "commit-msg" => "Commit message".into(),
        "pre-push" => "Pre-push".into(),
        other => title_words(other),
    }
}

pub(crate) fn friendly_name(command: &str) -> String {
    let lower = command.to_lowercase();
    if lower.contains("lint-staged") {
        return "Lint staged files".into();
    }
    if lower.contains("commitlint") {
        return "Commit message".into();
    }
    if lower.contains("eslint") {
        return "ESLint".into();
    }
    if lower.contains("prettier") {
        return "Prettier".into();
    }
    if lower.contains("typecheck") || lower.contains("tsc --noemit") || lower.contains("tsc -p") {
        return "Typecheck".into();
    }
    if lower.contains("cargo clippy") {
        return "Clippy".into();
    }
    if lower.contains("cargo fmt") {
        return "Format".into();
    }
    if lower.contains("cargo test") {
        return "Tests".into();
    }
    if lower.contains("npm test") || lower.contains("yarn test") || lower.contains("pnpm test") {
        return "Tests".into();
    }
    if let Some(script) = extract_run_script(command) {
        return title_words(&script);
    }
    let first = command
        .split_whitespace()
        .find(|p| {
            !matches!(
                *p,
                "npx" | "npm" | "yarn" | "pnpm" | "bun" | "bunx" | "--no" | "--yes" | "-y" | "--"
            )
        })
        .unwrap_or(command);
    if first.len() < command.len() {
        title_words(first)
    } else {
        command.chars().take(48).collect()
    }
}

fn extract_run_script(command: &str) -> Option<String> {
    let tokens: Vec<&str> = command.split_whitespace().collect();
    for (i, token) in tokens.iter().enumerate() {
        if *token == "run" {
            if let Some(next) = tokens.get(i + 1) {
                if !next.starts_with('-') {
                    return Some((*next).to_string());
                }
            }
        }
    }
    None
}

fn title_words(value: &str) -> String {
    value
        .replace(['-', '_', ':'], " ")
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(c) => format!("{}{}", c.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn unquote(value: &str) -> String {
    let v = value.trim();
    if (v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')) {
        v[1..v.len() - 1].to_string()
    } else {
        v.to_string()
    }
}

fn run_shell_command(
    cwd: &Path,
    command: &str,
    trigger: &str,
    commit_message: Option<&str>,
) -> AppResult<RunCheckOutput> {
    let mut temp_msg: Option<temp_path::TempFile> = None;
    let mut resolved = command.to_string();
    if trigger == "commit-msg" {
        let file = temp_path::TempFile::write(commit_message.unwrap_or_default())?;
        let quoted = shell_quote(&file.path_string());
        resolved = resolved.replace("$1", &quoted);
        if !command.contains("$1") && !command.contains("$@") {
            resolved = format!("{resolved} {quoted}");
        }
        temp_msg = Some(file);
    }

    let mut cmd = shell_cmd(&resolved);
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_DIR", cwd.join(".git"))
        .env("GIT_WORK_TREE", cwd);
    if let Some(file) = &temp_msg {
        cmd.env("COMMIT_MSG_FILE", file.path_string());
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::msg(format!("Failed to start check: {e}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::msg("Failed to capture check stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::msg("Failed to capture check stderr"))?;

    let out_handle = std::thread::spawn(move || read_capped(stdout));
    let err_handle = std::thread::spawn(move || read_capped(stderr));

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() > RUN_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(RunCheckOutput {
                        ok: false,
                        exit_code: 124,
                        stdout: String::new(),
                        stderr: "Check timed out after 3 minutes".into(),
                    });
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(e) => return Err(AppError::msg(format!("Failed to wait for check: {e}"))),
        }
    };

    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    let exit_code = status.code().unwrap_or(1);
    drop(temp_msg);
    Ok(RunCheckOutput {
        ok: status.success(),
        exit_code,
        stdout,
        stderr,
    })
}

fn read_capped(mut reader: impl Read) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() < MAX_OUTPUT_BYTES {
                    let room = MAX_OUTPUT_BYTES - buf.len();
                    buf.extend_from_slice(&chunk[..n.min(room)]);
                }
            }
            Err(_) => break,
        }
    }
    let mut text = String::from_utf8_lossy(&buf).to_string();
    if buf.len() >= MAX_OUTPUT_BYTES {
        text.push_str("\n… output truncated");
    }
    text
}

fn shell_cmd(command: &str) -> Command {
    if cfg!(windows) {
        if let Some(sh) = windows_sh() {
            let mut cmd = Command::new(sh);
            cmd.arg("-c").arg(command);
            return cmd;
        }
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(command);
        cmd
    } else {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(command);
        cmd
    }
}

fn windows_sh() -> Option<PathBuf> {
    which::which("sh").ok().or_else(|| {
        let git = which::which("git").ok()?;
        let sh = git
            .parent()?
            .parent()?
            .join("usr")
            .join("bin")
            .join("sh.exe");
        if sh.is_file() {
            Some(sh)
        } else {
            None
        }
    })
}

fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".into();
    }
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | ':'))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

mod temp_path {
    use crate::AppResult;
    use std::path::PathBuf;

    pub struct TempFile {
        path: PathBuf,
    }

    impl TempFile {
        pub fn write(contents: &str) -> AppResult<Self> {
            let path = std::env::temp_dir().join(format!(
                "branchline-commit-msg-{}.txt",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::write(&path, contents)?;
            Ok(Self { path })
        }

        pub fn path_string(&self) -> String {
            self.path.to_string_lossy().to_string()
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_husky_pre_commit_commands() {
        let script = r#"
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npx lint-staged
npm run typecheck
"#;
        let commands = parse_hook_script(script);
        assert_eq!(commands, vec!["npx lint-staged", "npm run typecheck"]);
    }

    #[test]
    fn names_common_tools() {
        assert_eq!(friendly_name("npx lint-staged"), "Lint staged files");
        assert_eq!(friendly_name("npx --no -- commitlint --edit $1"), "Commit message");
        assert_eq!(friendly_name("npm run lint"), "Lint");
        assert_eq!(friendly_name("pnpm test"), "Tests");
    }

    #[test]
    fn parses_lefthook_commands() {
        let yaml = r#"
pre-commit:
  parallel: true
  commands:
    lint:
      run: npm run lint
    types:
      run: npx tsc --noEmit
pre-push:
  commands:
    test:
      run: npm test
"#;
        let parsed = parse_lefthook_yaml(yaml);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0], ("pre-commit".into(), "Lint".into(), "npm run lint".into()));
        assert_eq!(parsed[1].0, "pre-commit");
        assert_eq!(parsed[1].1, "Types");
        assert_eq!(parsed[2], ("pre-push".into(), "Test".into(), "npm test".into()));
    }

    #[test]
    fn parses_pre_commit_hook_ids() {
        let yaml = r#"
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    hooks:
      - id: trailing-whitespace
        name: Trim Trailing Whitespace
      - id: end-of-file-fixer
"#;
        let parsed = parse_pre_commit_config(yaml);
        assert_eq!(parsed[0].0, "trailing-whitespace");
        assert_eq!(parsed[0].1, "Trim Trailing Whitespace");
        assert_eq!(parsed[1].0, "end-of-file-fixer");
        assert_eq!(parsed[1].1, "End Of File Fixer");
    }
}
