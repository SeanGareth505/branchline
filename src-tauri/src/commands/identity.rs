use crate::infrastructure::git_cli::{self, ConfigScope};
use crate::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetGitIdentityInput {
    pub name: String,
    pub email: String,
    pub path: Option<String>,
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListIdentityContextsInput {
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityCandidate {
    pub id: String,
    pub name: String,
    pub email: String,
    pub source: String,
    pub label: String,
    pub commit_count: Option<i32>,
    pub is_active: bool,
    #[serde(default)]
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityContextsOutput {
    pub effective: GitIdentity,
    pub effective_scope: String,
    pub local: Option<GitIdentity>,
    pub global: Option<GitIdentity>,
    pub candidates: Vec<IdentityCandidate>,
    pub has_repo: bool,
}

#[derive(Default)]
struct HistoryAgg {
    names: HashMap<String, i32>,
    total: i32,
}

fn read_identity(repo: Option<&Path>, scope: ConfigScope) -> AppResult<Option<GitIdentity>> {
    let name = git_cli::config_get_scoped(repo, "user.name", scope)?.unwrap_or_default();
    let email = git_cli::config_get_scoped(repo, "user.email", scope)?.unwrap_or_default();
    if name.trim().is_empty() && email.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(GitIdentity {
        name: name.trim().to_string(),
        email: email.trim().to_string(),
    }))
}

fn email_key(email: &str) -> String {
    email.trim().to_lowercase()
}

fn identity_key(name: &str, email: &str) -> String {
    format!(
        "{} <{}>",
        name.trim().to_lowercase(),
        email.trim().to_lowercase()
    )
}

fn is_placeholder_email(email: &str) -> bool {
    let e = email.trim().to_lowercase();
    if e.is_empty() {
        return true;
    }
    e.ends_with("@personal.dev")
        || e.ends_with("@example.com")
        || e.ends_with("@example.org")
        || e.ends_with("@example.net")
        || e.ends_with("@localhost")
        || e.ends_with("@test.com")
        || e == "you@personal.dev"
        || e.starts_with("noreply@")
        || e.contains("users.noreply.github.com")
}

fn normalize_name(name: &str) -> String {
    name.trim().to_lowercase()
}

fn names_match(a: &str, b: &str) -> bool {
    let a = normalize_name(a);
    let b = normalize_name(b);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    a.starts_with(&format!("{b} ")) || b.starts_with(&format!("{a} "))
}

fn is_my_history_author(
    email_lower: &str,
    primary_name: &str,
    aliases: &[String],
    my_emails: &std::collections::HashSet<String>,
    my_names: &[String],
) -> bool {
    if my_emails.contains(email_lower) {
        return true;
    }
    if my_names.is_empty() {
        return false;
    }
    if my_names.iter().any(|n| names_match(n, primary_name)) {
        return true;
    }
    aliases
        .iter()
        .any(|alias| my_names.iter().any(|n| names_match(n, alias)))
}

fn best_history_name(agg: &HistoryAgg, preferred: Option<&str>) -> String {
    if let Some(pref) = preferred {
        let pref = pref.trim();
        if !pref.is_empty() && agg.names.contains_key(pref) {
            return pref.to_string();
        }
    }
    agg.names
        .iter()
        .max_by(|a, b| a.1.cmp(b.1).then_with(|| a.0.cmp(b.0)))
        .map(|(n, _)| n.clone())
        .unwrap_or_default()
}

fn alias_names(agg: &HistoryAgg, primary: &str) -> Vec<String> {
    let mut aliases: Vec<_> = agg
        .names
        .keys()
        .filter(|n| n.as_str() != primary)
        .cloned()
        .collect();
    aliases.sort();
    aliases
}

fn push_config_candidate(
    out: &mut Vec<IdentityCandidate>,
    by_email: &mut HashMap<String, usize>,
    name: &str,
    email: &str,
    source: &str,
    label: &str,
    active_key: &str,
) {
    let name = name.trim();
    let email = email.trim();
    if name.is_empty() && email.is_empty() {
        return;
    }
    let ek = email_key(email);
    if let Some(&idx) = by_email.get(&ek) {
        if source == "local" {
            out[idx].source = "local".into();
            out[idx].label = label.into();
            out[idx].name = if name.is_empty() {
                email.to_string()
            } else {
                name.to_string()
            };
            out[idx].id = format!("local:{ek}");
        }
        out[idx].is_active = identity_key(&out[idx].name, &out[idx].email) == active_key
            || identity_key(name, email) == active_key;
        return;
    }
    let display_name = if name.is_empty() {
        email.to_string()
    } else {
        name.to_string()
    };
    by_email.insert(ek.clone(), out.len());
    out.push(IdentityCandidate {
        id: format!("{source}:{ek}"),
        name: display_name.clone(),
        email: email.to_string(),
        source: source.into(),
        label: label.into(),
        commit_count: None,
        is_active: identity_key(name, email) == active_key
            || identity_key(&display_name, email) == active_key,
        aliases: Vec::new(),
    });
}

fn history_authors(path: &Path) -> HashMap<String, HistoryAgg> {
    let mut by_email: HashMap<String, HistoryAgg> = HashMap::new();

    let (ok, out, _) = git_cli::run_git_allow_fail(path, &["shortlog", "-sne", "--all", "HEAD"]);
    let lines: Vec<String> = if ok && !out.trim().is_empty() {
        out.lines().map(|l| l.to_string()).collect()
    } else {
        let (ok2, out2, _) = git_cli::run_git_allow_fail(
            path,
            &["log", "--all", "--format=%aN%x09%aE", "-n", "400"],
        );
        if !ok2 {
            return by_email;
        }
        let mut counts: HashMap<(String, String), i32> = HashMap::new();
        for line in out2.lines() {
            let Some((name, email)) = line.split_once('\t') else {
                continue;
            };
            let name = name.trim();
            let email = email.trim();
            if name.is_empty() || email.is_empty() {
                continue;
            }
            *counts
                .entry((name.to_string(), email.to_string()))
                .or_insert(0) += 1;
        }
        return fold_name_email_counts(counts);
    };

    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some((count_part, rest)) = trimmed.split_once('\t').or_else(|| {
            let parts: Vec<_> = trimmed.splitn(2, char::is_whitespace).collect();
            if parts.len() == 2 {
                Some((parts[0], parts[1]))
            } else {
                None
            }
        }) else {
            continue;
        };
        let count: i32 = count_part.trim().parse().unwrap_or(0);
        let rest = rest.trim();
        let (name, email) = if let Some(start) = rest.rfind('<') {
            let name = rest[..start].trim();
            let email = rest[start + 1..].trim().trim_end_matches('>');
            (name, email)
        } else {
            continue;
        };
        if name.is_empty() || email.is_empty() {
            continue;
        }
        let agg = by_email.entry(email_key(email)).or_default();
        *agg.names.entry(name.to_string()).or_insert(0) += count;
        agg.total += count;
    }
    by_email
}

fn fold_name_email_counts(counts: HashMap<(String, String), i32>) -> HashMap<String, HistoryAgg> {
    let mut by_email: HashMap<String, HistoryAgg> = HashMap::new();
    for ((name, email), count) in counts {
        let agg = by_email.entry(email_key(&email)).or_default();
        *agg.names.entry(name).or_insert(0) += count;
        agg.total += count;
    }
    by_email
}

#[command]
pub fn get_git_identity(input: Option<ListIdentityContextsInput>) -> AppResult<GitIdentity> {
    let path = input
        .and_then(|i| i.path)
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .map(PathBuf::from);
    let repo = path
        .as_ref()
        .filter(|p| git_cli::ensure_repo(p).is_ok())
        .map(|p| p.as_path());
    Ok(read_identity(repo, ConfigScope::Effective)?.unwrap_or(GitIdentity {
        name: String::new(),
        email: String::new(),
    }))
}

#[command]
pub fn set_git_identity(input: SetGitIdentityInput) -> AppResult<GitIdentity> {
    let name = input.name.trim();
    let email = input.email.trim();
    if name.is_empty() || email.is_empty() {
        return Err(AppError::msg("Name and email are required"));
    }

    let scope_raw = input
        .scope
        .as_deref()
        .unwrap_or("global")
        .to_ascii_lowercase();
    let path = input
        .path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(PathBuf::from);
    let scope = match scope_raw.as_str() {
        "local" => ConfigScope::Local,
        _ => ConfigScope::Global,
    };

    if matches!(scope, ConfigScope::Local) && path.is_none() {
        return Err(AppError::msg("Open a repository to set a local identity"));
    }

    if matches!(scope, ConfigScope::Local) {
        let repo = path.as_deref().unwrap();
        git_cli::config_set_scoped(Some(repo), "user.name", name, ConfigScope::Local)?;
        git_cli::config_set_scoped(Some(repo), "user.email", email, ConfigScope::Local)?;
    } else {
        git_cli::config_set_scoped(None, "user.name", name, ConfigScope::Global)?;
        git_cli::config_set_scoped(None, "user.email", email, ConfigScope::Global)?;
        // Choosing a global default clears any repo override so it applies here too.
        if let Some(repo) = path.as_deref() {
            if git_cli::ensure_repo(repo).is_ok() {
                let _ = git_cli::config_unset_scoped(Some(repo), "user.name", ConfigScope::Local);
                let _ = git_cli::config_unset_scoped(Some(repo), "user.email", ConfigScope::Local);
            }
        }
    }

    Ok(GitIdentity {
        name: name.to_string(),
        email: email.to_string(),
    })
}

#[command]
pub fn list_identity_contexts(
    input: ListIdentityContextsInput,
) -> AppResult<IdentityContextsOutput> {
    let path = input
        .path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(PathBuf::from);
    let has_repo = path
        .as_ref()
        .map(|p| git_cli::ensure_repo(p).is_ok())
        .unwrap_or(false);
    let repo = if has_repo { path.as_deref() } else { None };

    let global = read_identity(None, ConfigScope::Global)?;
    let local = if let Some(p) = repo {
        read_identity(Some(p), ConfigScope::Local)?
    } else {
        None
    };
    let effective = read_identity(repo, ConfigScope::Effective)?.unwrap_or(GitIdentity {
        name: String::new(),
        email: String::new(),
    });
    let effective_scope = if local.is_some() {
        "local".into()
    } else if global.is_some() {
        "global".into()
    } else {
        "unset".into()
    };

    let active_key = identity_key(&effective.name, &effective.email);
    let active_email = email_key(&effective.email);
    let mut my_emails: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut my_names: Vec<String> = Vec::new();
    for id in [&local, &global].into_iter().flatten() {
        let email = email_key(&id.email);
        if !email.is_empty() && !is_placeholder_email(&email) {
            my_emails.insert(email);
        }
        let name = id.name.trim();
        if !name.is_empty() {
            my_names.push(name.to_string());
        }
    }

    let mut candidates = Vec::new();
    let mut by_email: HashMap<String, usize> = HashMap::new();

    if let Some(id) = &local {
        if !is_placeholder_email(&id.email) {
            push_config_candidate(
                &mut candidates,
                &mut by_email,
                &id.name,
                &id.email,
                "local",
                "This repository",
                &active_key,
            );
        }
    }
    if let Some(id) = &global {
        if !is_placeholder_email(&id.email) {
            push_config_candidate(
                &mut candidates,
                &mut by_email,
                &id.name,
                &id.email,
                "global",
                "Global Git default",
                &active_key,
            );
        }
    }

    if let Some(p) = repo {
        let history = history_authors(p);
        let mut rows: Vec<_> = history.into_iter().collect();
        rows.sort_by(|a, b| b.1.total.cmp(&a.1.total).then(a.0.cmp(&b.0)));

        for (email_lower, agg) in rows.into_iter().take(24) {
            if is_placeholder_email(&email_lower) {
                continue;
            }

            let is_active_email = !active_email.is_empty() && email_lower == active_email;

            if let Some(&idx) = by_email.get(&email_lower) {
                let preferred = candidates[idx].name.clone();
                let primary = best_history_name(&agg, Some(&preferred));
                if candidates[idx].source == "history" {
                    candidates[idx].name = primary.clone();
                }
                candidates[idx].commit_count = Some(agg.total);
                candidates[idx].aliases = alias_names(&agg, &candidates[idx].name);
                if is_active_email {
                    candidates[idx].is_active = true;
                }
                continue;
            }

            let primary = best_history_name(&agg, None);
            if primary.is_empty() {
                continue;
            }
            let aliases = alias_names(&agg, &primary);
            if !is_my_history_author(&email_lower, &primary, &aliases, &my_emails, &my_names) {
                continue;
            }

            by_email.insert(email_lower.clone(), candidates.len());
            candidates.push(IdentityCandidate {
                id: format!("history:{email_lower}"),
                name: primary.clone(),
                email: email_lower.clone(),
                source: "history".into(),
                label: "Seen in commits".into(),
                commit_count: Some(agg.total),
                is_active: is_active_email,
                aliases,
            });
        }
    }

    for c in &mut candidates {
        if identity_key(&c.name, &c.email) == active_key || email_key(&c.email) == active_email {
            c.is_active = !active_email.is_empty() && email_key(&c.email) == active_email;
        }
    }

    Ok(IdentityContextsOutput {
        effective,
        effective_scope,
        local,
        global,
        candidates,
        has_repo,
    })
}
