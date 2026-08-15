use crate::commands::branch::MutationOutput;
use crate::infrastructure::git_cli;
use crate::AppResult;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::command;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFlowInput {
    pub path: String,
    pub kind: String,
    pub action: String,
    pub name: String,
    #[serde(default)]
    pub main: String,
    #[serde(default)]
    pub develop: String,
    #[serde(default)]
    pub delete_branch: Option<bool>,
    #[serde(default)]
    pub tag: Option<bool>,
    #[serde(default)]
    pub push: Option<bool>,
}

fn branch_exists(path: &Path, name: &str) -> bool {
    git_cli::run_git_allow_fail(path, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")]).0
}

fn resolve_base(path: &Path, preferred: &str, fallbacks: &[&str]) -> Result<String, String> {
    let preferred = preferred.trim();
    if !preferred.is_empty() && branch_exists(path, preferred) {
        return Ok(preferred.to_string());
    }
    for name in fallbacks {
        if branch_exists(path, name) {
            return Ok((*name).to_string());
        }
    }
    Err(format!(
        "Could not find {} (or {}). Create that branch first.",
        if preferred.is_empty() {
            fallbacks.first().copied().unwrap_or("main")
        } else {
            preferred
        },
        fallbacks.join(" / ")
    ))
}

fn prefixed(kind: &str, name: &str) -> Result<(String, String), String> {
    let kind = kind.trim().to_ascii_lowercase();
    let prefix = match kind.as_str() {
        "feature" => "feature/",
        "release" => "release/",
        "hotfix" => "hotfix/",
        _ => return Err("Kind must be feature, release, or hotfix.".into()),
    };
    let raw = name.trim().trim_matches('/').to_string();
    if raw.is_empty() {
        return Err("Name is required.".into());
    }
    let branch = if raw.starts_with(prefix) || raw.contains('/') {
        raw
    } else {
        format!("{prefix}{raw}")
    };
    Ok((kind, branch))
}

fn run(path: &Path, args: &[&str]) -> Result<String, String> {
    let (ok, out, err) = git_cli::run_git_allow_fail(path, args);
    if ok {
        Ok(out)
    } else {
        let detail = if !err.trim().is_empty() { err } else { out };
        Err(detail.trim().to_string())
    }
}

fn checkout(path: &Path, name: &str) -> Result<(), String> {
    run(path, &["checkout", name]).map(|_| ())
}

fn merge_no_ff(path: &Path, name: &str) -> Result<(), String> {
    run(
        path,
        &[
            "merge",
            "--no-ff",
            "-m",
            &format!("Merge branch '{name}'"),
            name,
        ],
    )
    .map(|_| ())
}

fn delete_local(path: &Path, name: &str) -> Result<(), String> {
    run(path, &["branch", "-d", name]).map(|_| ())
}

fn create_and_checkout(path: &Path, branch: &str, start: &str) -> Result<(), String> {
    run(path, &["checkout", "-b", branch, start]).map(|_| ())
}

fn tag_release(path: &Path, name: &str) -> Result<(), String> {
    let tag = name
        .rsplit('/')
        .next()
        .unwrap_or(name)
        .trim()
        .to_string();
    if tag.is_empty() {
        return Err("Tag name is empty.".into());
    }
    if git_cli::run_git_allow_fail(path, &["rev-parse", "--verify", "--quiet", &format!("refs/tags/{tag}")]).0
    {
        return Ok(());
    }
    run(path, &["tag", "-a", &tag, "-m", &format!("Release {tag}")]).map(|_| ())
}

fn push_refs(path: &Path, refs: &[&str]) -> Result<(), String> {
    let mut args = vec!["push", "origin"];
    args.extend(refs.iter().copied());
    run(path, &args).map(|_| ())
}

fn start_flow(path: &Path, kind: &str, branch: &str, main: &str, develop: &str) -> Result<String, String> {
    if branch_exists(path, branch) {
        return Err(format!("Branch {branch} already exists."));
    }
    let start = if kind == "hotfix" {
        resolve_base(path, main, &["main", "master"])?
    } else {
        match resolve_base(path, develop, &["develop", "dev"]) {
            Ok(name) => name,
            Err(_) if kind == "feature" => resolve_base(path, main, &["main", "master"])?,
            Err(err) => return Err(err),
        }
    };
    checkout(path, &start)?;
    create_and_checkout(path, branch, &start)?;
    Ok(format!("Started {kind} {branch} from {start}"))
}

fn finish_flow(
    path: &Path,
    kind: &str,
    branch: &str,
    main: &str,
    develop: &str,
    delete_branch: bool,
    tag: bool,
    push: bool,
) -> Result<String, String> {
    if !branch_exists(path, branch) {
        return Err(format!("Branch {branch} does not exist."));
    }
    let main_name = resolve_base(path, main, &["main", "master"])?;
    let develop_name = resolve_base(path, develop, &["develop", "dev"]).ok();
    let mut notes = Vec::new();

    match kind {
        "feature" => {
            let target = develop_name
                .clone()
                .unwrap_or_else(|| main_name.clone());
            checkout(path, &target)?;
            merge_no_ff(path, branch)?;
            notes.push(format!("Merged {branch} into {target}"));
            if delete_branch {
                delete_local(path, branch)?;
                notes.push(format!("Deleted {branch}"));
            }
            if push {
                push_refs(path, &[target.as_str()])?;
                notes.push("Pushed to origin".into());
            }
        }
        "release" | "hotfix" => {
            checkout(path, &main_name)?;
            merge_no_ff(path, branch)?;
            notes.push(format!("Merged {branch} into {main_name}"));
            if tag {
                tag_release(path, branch)?;
                notes.push("Created release tag".into());
            }
            if let Some(dev) = develop_name.as_deref() {
                if dev != main_name {
                    checkout(path, dev)?;
                    merge_no_ff(path, branch)?;
                    notes.push(format!("Merged {branch} into {dev}"));
                }
            } else {
                notes.push("No develop branch — skipped the second merge".into());
            }
            if delete_branch {
                delete_local(path, branch)?;
                notes.push(format!("Deleted {branch}"));
            }
            if push {
                let mut refs = vec![main_name.as_str()];
                if let Some(dev) = develop_name.as_deref() {
                    if dev != main_name {
                        refs.push(dev);
                    }
                }
                if tag {
                    let _ = run(path, &["push", "origin", "--tags"]);
                }
                push_refs(path, &refs)?;
                notes.push("Pushed to origin".into());
            } else {
                checkout(path, &main_name)?;
            }
        }
        _ => return Err("Kind must be feature, release, or hotfix.".into()),
    }

    Ok(notes.join(". "))
}

#[command]
pub fn git_flow(input: GitFlowInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let (kind, branch) = match prefixed(&input.kind, &input.name) {
            Ok(pair) => pair,
            Err(message) => {
                return Ok(MutationOutput {
                    ok: false,
                    message,
                });
            }
        };
        let action = input.action.trim().to_ascii_lowercase();
        let result = match action.as_str() {
            "start" => start_flow(path, &kind, &branch, &input.main, &input.develop),
            "finish" => finish_flow(
                path,
                &kind,
                &branch,
                &input.main,
                &input.develop,
                input.delete_branch.unwrap_or(true),
                input.tag.unwrap_or(kind != "feature"),
                input.push.unwrap_or(false),
            ),
            _ => Err("Action must be start or finish.".into()),
        };
        Ok(match result {
            Ok(message) => MutationOutput { ok: true, message },
            Err(message) => MutationOutput { ok: false, message },
        })
    })
}
