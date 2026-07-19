use crate::infrastructure::git2_repo;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SafetyAction {
    DeleteBranch,
    HardReset,
    ForcePush,
    Discard,
    DeleteTag,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetyCheck {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetyAnalysis {
    pub action: SafetyAction,
    pub title: String,
    pub severity: String,
    pub target: Option<String>,
    pub consequence: String,
    pub advice: String,
    pub checks: Vec<SafetyCheck>,
    pub recommended_label: String,
    pub recommended_action: String,
    pub proceed_label: String,
    pub git_command: String,
    pub proceed_git_command: String,
    pub confirm_prompt: String,
    pub require_typed_confirm: bool,
    pub blocked: bool,
    pub can_proceed: bool,
}

pub fn analyze_with_lock(
    path: &Path,
    action: SafetyAction,
    target: Option<String>,
    locked: bool,
    lock_reason: Option<String>,
) -> SafetyAnalysis {
    match action {
        SafetyAction::DeleteBranch => analyze_delete_branch(path, target, locked, lock_reason),
        SafetyAction::HardReset => analyze_hard_reset(path, target),
        SafetyAction::ForcePush => analyze_force_push(path, target, locked, lock_reason),
        SafetyAction::Discard => analyze_discard(path, target),
        SafetyAction::DeleteTag => analyze_delete_tag(path, target),
    }
}

fn analyze_delete_branch(
    path: &Path,
    target: Option<String>,
    locked: bool,
    lock_reason: Option<String>,
) -> SafetyAnalysis {
    let branch = target.clone().unwrap_or_default();
    let current = git2_repo::current_branch(path).unwrap_or_default();
    let is_current = !branch.is_empty() && branch == current;
    let merged = !branch.is_empty() && git2_repo::is_branch_merged(path, &branch);
    let has_upstream = !branch.is_empty() && git2_repo::branch_has_upstream(path, &branch);

    let checks = vec![
        SafetyCheck {
            id: "not_current".into(),
            label: "Not the current branch".into(),
            ok: !is_current,
            detail: if is_current {
                "Switch branches before deleting this one".into()
            } else {
                "Safe to delete a non-checked-out branch".into()
            },
        },
        SafetyCheck {
            id: "not_locked".into(),
            label: "Branch is not locked".into(),
            ok: !locked,
            detail: if locked {
                match lock_reason.as_deref().filter(|r| !r.trim().is_empty()) {
                    Some(reason) => format!("Locked: {reason}"),
                    None => "Unlock this branch before deleting".into(),
                }
            } else {
                "No Branchline lock on this branch".into()
            },
        },
        SafetyCheck {
            id: "merged".into(),
            label: "Merged into HEAD".into(),
            ok: merged,
            detail: if merged {
                "Branch tip is reachable from HEAD".into()
            } else {
                "Branch contains commits not in HEAD — they may be hard to recover".into()
            },
        },
        SafetyCheck {
            id: "no_upstream".into(),
            label: "No remote tracking branch".into(),
            ok: !has_upstream,
            detail: if has_upstream {
                "A remote branch may still exist — delete remote separately if needed".into()
            } else {
                "Local-only branch".into()
            },
        },
    ];

    let blocked = is_current || locked;
    let severity = if blocked {
        "danger"
    } else if merged {
        "warning"
    } else {
        "danger"
    };

    let (recommended_label, recommended_action, proceed_label) = if blocked {
        ("Close".into(), "keep".into(), "Close".into())
    } else if merged {
        (
            "Delete local branch".into(),
            "delete".into(),
            "Delete anyway".into(),
        )
    } else {
        (
            "Keep branch".into(),
            "keep".into(),
            "Delete unmerged (backup first)".into(),
        )
    };

    let advice = if locked {
        "Unlock the branch from the Branches panel, then try again.".into()
    } else if blocked {
        "Checkout another branch first, then try again.".into()
    } else if merged {
        "Prefer deleting only after the branch is merged or you no longer need it.".into()
    } else {
        "Consider creating a backup branch or cherry-picking commits you still need.".into()
    };

    SafetyAnalysis {
        action: SafetyAction::DeleteBranch,
        title: format!("Delete branch '{branch}'?"),
        severity: severity.into(),
        target,
        consequence: if locked {
            format!("Branch '{branch}' is locked and cannot be deleted until unlocked.")
        } else if merged {
            format!("Delete local branch '{branch}'. Work appears merged into HEAD.")
        } else {
            format!("Delete local branch '{branch}'. Unmerged commits may become harder to find.")
        },
        advice,
        checks,
        recommended_label,
        recommended_action,
        proceed_label,
        git_command: format!("git branch -d {branch}"),
        proceed_git_command: format!("git branch -D {branch}"),
        confirm_prompt: format!("I understand I am deleting local branch '{branch}'"),
        require_typed_confirm: !merged && !blocked,
        blocked,
        can_proceed: !blocked,
    }
}

fn analyze_hard_reset(path: &Path, target: Option<String>) -> SafetyAnalysis {
    let target_ref = target.clone().unwrap_or_else(|| "HEAD".into());
    let status = git2_repo::repo_status(path).ok();
    let dirty = status
        .as_ref()
        .map(|s| {
            !s.staged.is_empty()
                || !s.unstaged.is_empty()
                || !s.untracked.is_empty()
                || !s.conflicted.is_empty()
        })
        .unwrap_or(false);
    let (ahead, _) = git2_repo::ahead_behind(path);

    let checks = vec![
        SafetyCheck {
            id: "clean_tree".into(),
            label: "Working tree clean".into(),
            ok: !dirty,
            detail: if dirty {
                "Uncommitted changes will be discarded".into()
            } else {
                "No uncommitted changes".into()
            },
        },
        SafetyCheck {
            id: "not_ahead".into(),
            label: "Not ahead of upstream".into(),
            ok: ahead == 0,
            detail: if ahead > 0 {
                format!("{ahead} local commit(s) may leave the tip — backup recommended")
            } else {
                "Not ahead of upstream".into()
            },
        },
    ];

    SafetyAnalysis {
        action: SafetyAction::HardReset,
        title: format!("Hard reset to '{target_ref}'?"),
        severity: "danger".into(),
        target,
        consequence: format!(
            "Hard reset moves HEAD to '{target_ref}' and discards commits and working-tree changes from this branch tip."
        ),
        advice: "Recommended path creates a backup branch first so you can recover with checkout.".into(),
        checks,
        recommended_label: "Backup branch, then hard reset".into(),
        recommended_action: "backup_branch".into(),
        proceed_label: "Hard reset without backup".into(),
        git_command: format!("git branch backup/… && git reset --hard {target_ref}"),
        proceed_git_command: format!("git reset --hard {target_ref}"),
        confirm_prompt: "I understand commits and local changes may be lost".into(),
        require_typed_confirm: true,
        blocked: false,
        can_proceed: true,
    }
}

fn analyze_force_push(
    path: &Path,
    target: Option<String>,
    locked: bool,
    lock_reason: Option<String>,
) -> SafetyAnalysis {
    let branch = target
        .clone()
        .unwrap_or_else(|| git2_repo::current_branch(path).unwrap_or_else(|_| "HEAD".into()));
    let protected = matches!(
        branch.as_str(),
        "main" | "master" | "develop" | "release" | "trunk"
    ) || branch.starts_with("release/");
    let (ahead, behind) = git2_repo::ahead_behind(path);
    let lease_safe = behind == 0;

    let checks = vec![
        SafetyCheck {
            id: "not_locked".into(),
            label: "Branch is not locked".into(),
            ok: !locked,
            detail: if locked {
                match lock_reason.as_deref().filter(|r| !r.trim().is_empty()) {
                    Some(reason) => format!("Locked: {reason}"),
                    None => "Unlock this branch before pushing".into(),
                }
            } else {
                "No Branchline lock on this branch".into()
            },
        },
        SafetyCheck {
            id: "not_protected".into(),
            label: "Not a protected branch".into(),
            ok: !protected,
            detail: if protected {
                format!("'{branch}' is commonly protected — type the name to continue")
            } else {
                "Branch name is not a common protected name".into()
            },
        },
        SafetyCheck {
            id: "lease_safe".into(),
            label: "Remote has not moved ahead".into(),
            ok: lease_safe,
            detail: if behind > 0 {
                format!(
                    "Upstream is {behind} commit(s) ahead — fetch first; --force-with-lease will refuse if remote moved"
                )
            } else {
                "Upstream is not ahead of your local tip".into()
            },
        },
        SafetyCheck {
            id: "has_local".into(),
            label: "Has local commits to publish".into(),
            ok: ahead > 0,
            detail: if ahead > 0 {
                format!("Ahead by {ahead} commit(s)")
            } else {
                "Nothing ahead — force push still rewrites remote refs".into()
            },
        },
        SafetyCheck {
            id: "prefer_lease".into(),
            label: "Prefer --force-with-lease".into(),
            ok: true,
            detail: "Safer than --force: refuses if someone else pushed since your last fetch"
                .into(),
        },
    ];

    let advice = if locked {
        "This branch is locked in Branchline. Unlock it from the Branches panel before pushing."
            .into()
    } else if protected {
        format!(
            "Force-pushing '{branch}' can disrupt the whole team. Prefer a new branch + PR. If you must continue, use --force-with-lease and type the branch name."
        )
    } else if behind > 0 {
        "Fetch first so lease compares against the latest remote tip. Bare --force ignores collaborators' new commits.".into()
    } else {
        "--force-with-lease is the Git Extensions–style default. Only use bare --force if you intentionally overwrite the remote.".into()
    };

    SafetyAnalysis {
        action: SafetyAction::ForcePush,
        title: format!("Force push '{branch}'?"),
        severity: if locked || protected {
            "danger"
        } else {
            "warning"
        }
        .into(),
        target: Some(branch.clone()),
        consequence: if locked {
            format!("Branch '{branch}' is locked. Push and force-push are blocked until unlocked.")
        } else {
            format!(
                "This rewrites remote history on origin/{branch}. Collaborators who based work on the old tip will need to recover (rebase or reset)."
            )
        },
        advice,
        checks,
        recommended_label: if locked {
            "Close".into()
        } else {
            "Push with --force-with-lease".into()
        },
        recommended_action: if locked {
            "keep".into()
        } else {
            "force_with_lease".into()
        },
        proceed_label: if locked {
            "Close".into()
        } else {
            "Push with --force".into()
        },
        git_command: format!("git push --force-with-lease origin {branch}"),
        proceed_git_command: format!("git push --force origin {branch}"),
        confirm_prompt: format!("I understand this rewrites remote history on '{branch}'"),
        require_typed_confirm: !locked && (protected || !lease_safe),
        blocked: locked,
        can_proceed: !locked,
    }
}

fn analyze_discard(path: &Path, target: Option<String>) -> SafetyAnalysis {
    let status = git2_repo::repo_status(path).ok();
    let count = status
        .as_ref()
        .map(|s| s.unstaged.len() + s.untracked.len())
        .unwrap_or(0);
    let large = count > 20;
    let pathspec = target.clone().unwrap_or_else(|| ".".into());
    let selected = split_pathspecs(&pathspec);
    let scope_label = if selected.len() > 1 {
        format!("{} selected paths", selected.len())
    } else {
        selected.first().copied().unwrap_or(".").to_string()
    };

    let checks = vec![
        SafetyCheck {
            id: "scope".into(),
            label: "Discard scope is limited".into(),
            ok: target.is_some(),
            detail: if target.is_some() {
                format!("Only '{scope_label}' will be discarded")
            } else {
                "All unstaged / untracked changes may be discarded".into()
            },
        },
        SafetyCheck {
            id: "size".into(),
            label: "Small change set".into(),
            ok: !large,
            detail: format!("{count} file(s) with unstaged/untracked changes"),
        },
    ];

    SafetyAnalysis {
        action: SafetyAction::Discard,
        title: "Discard uncommitted changes?".into(),
        severity: if large { "danger" } else { "warning" }.into(),
        target,
        consequence: format!(
            "Discard uncommitted changes for '{scope_label}'. Staged changes are left alone."
        ),
        advice: "Recommended path stashes first and records an undo journal entry.".into(),
        checks,
        recommended_label: "Discard (keep undo)".into(),
        recommended_action: "discard_with_undo".into(),
        proceed_label: "Discard without undo".into(),
        git_command: format!("git stash push -u -- {scope_label}"),
        proceed_git_command: format!("git checkout -- {scope_label}"),
        confirm_prompt: "I understand these local changes may be lost".into(),
        require_typed_confirm: large,
        blocked: false,
        can_proceed: true,
    }
}

fn analyze_delete_tag(path: &Path, target: Option<String>) -> SafetyAnalysis {
    let tag = target.clone().unwrap_or_default();
    let exists = {
        let (ok, out, _) =
            crate::infrastructure::git_cli::run_git_allow_fail(path, &["tag", "--list", &tag]);
        ok && out.lines().any(|l| l.trim() == tag)
    };

    let checks = vec![SafetyCheck {
        id: "exists".into(),
        label: "Tag exists locally".into(),
        ok: exists,
        detail: if exists {
            format!("Found tag '{tag}'")
        } else {
            format!("Tag '{tag}' not found")
        },
    }];

    SafetyAnalysis {
        action: SafetyAction::DeleteTag,
        title: format!("Delete tag '{tag}'?"),
        severity: "warning".into(),
        target,
        consequence: format!(
            "Delete local tag '{tag}'. The remote tag is unchanged unless you push a delete separately."
        ),
        advice: "Remote cleanup is a separate step: git push origin :refs/tags/<tag>.".into(),
        checks,
        recommended_label: "Delete local tag".into(),
        recommended_action: "delete_local".into(),
        proceed_label: "Delete local tag".into(),
        git_command: format!("git tag -d {tag}"),
        proceed_git_command: format!("git tag -d {tag}"),
        confirm_prompt: format!("I understand I am deleting local tag '{tag}'"),
        require_typed_confirm: false,
        blocked: !exists,
        can_proceed: exists,
    }
}

pub fn execute(
    path: &Path,
    analysis: &SafetyAnalysis,
    use_recommended: bool,
    allow_bare_force: bool,
) -> crate::AppResult<ExecuteOutcome> {
    use crate::infrastructure::git_cli;
    use serde_json::json;

    match analysis.action {
        SafetyAction::DeleteBranch => {
            let branch = analysis.target.clone().unwrap_or_default();
            if !use_recommended {
                if analysis.recommended_action == "keep" {
                    let backup = format!(
                        "backup/{}-{}",
                        branch.replace('/', "-"),
                        chrono::Utc::now().format("%Y%m%d-%H%M%S")
                    );
                    git_cli::run_git(path, &["branch", &backup, &branch])?;
                    let flag = if analysis.checks.iter().any(|c| c.id == "merged" && c.ok) {
                        "-d"
                    } else {
                        "-D"
                    };
                    git_cli::run_git(path, &["branch", flag, &branch])?;
                    return Ok(ExecuteOutcome {
                        message: format!("Deleted '{branch}' (backup: {backup})"),
                        undoable: false,
                        undo_action: None,
                        undo_label: None,
                        undo_payload: None,
                    });
                }
                let flag = if analysis.checks.iter().any(|c| c.id == "merged" && c.ok) {
                    "-d"
                } else {
                    "-D"
                };
                let msg = git_cli::run_git(path, &["branch", flag, &branch])?;
                return Ok(outcome_msg(msg));
            }
            if analysis.recommended_action == "keep" {
                return Ok(outcome_msg("Kept branch — nothing deleted"));
            }
            let flag = if analysis.checks.iter().any(|c| c.id == "merged" && c.ok) {
                "-d"
            } else {
                "-D"
            };
            Ok(outcome_msg(git_cli::run_git(
                path,
                &["branch", flag, &branch],
            )?))
        }
        SafetyAction::HardReset => {
            let target = analysis.target.clone().unwrap_or_else(|| "HEAD".into());
            let previous = git_cli::run_git(path, &["rev-parse", "HEAD"])?
                .trim()
                .to_string();
            let backup = if use_recommended {
                let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
                let backup = format!("backup/before-reset-{stamp}");
                git_cli::run_git(path, &["branch", &backup])?;
                Some(backup)
            } else {
                None
            };
            git_cli::run_git(path, &["reset", "--hard", &target])?;
            if let Some(backup) = backup {
                Ok(ExecuteOutcome {
                    message: format!("Hard reset to {target} (backup: {backup})"),
                    undoable: true,
                    undo_action: Some("hard_reset".into()),
                    undo_label: Some(format!("Restore from {backup}")),
                    undo_payload: Some(json!({
                        "backupBranch": backup,
                        "previousHead": previous,
                        "target": target,
                    })),
                })
            } else {
                Ok(outcome_msg(format!("Hard reset to {target}")))
            }
        }
        SafetyAction::ForcePush => {
            let branch = analysis.target.clone().unwrap_or_else(|| {
                git2_repo::current_branch(path).unwrap_or_else(|_| "HEAD".into())
            });
            let msg = if use_recommended {
                git_cli::run_git(path, &["push", "--force-with-lease", "origin", &branch])?
            } else if allow_bare_force {
                git_cli::run_git(path, &["push", "--force", "origin", &branch])?
            } else {
                return Err(crate::AppError::msg(
                    "Bare --force requires explicit confirmation",
                ));
            };
            Ok(outcome_msg(if msg.trim().is_empty() {
                if use_recommended {
                    format!("Pushed origin/{branch} with --force-with-lease")
                } else {
                    format!("Force-pushed origin/{branch}")
                }
            } else {
                msg
            }))
        }
        SafetyAction::Discard => {
            let pathspec = analysis.target.clone().unwrap_or_else(|| ".".into());
            let paths = split_pathspecs(&pathspec);
            if use_recommended {
                let mut args = vec![
                    "stash".into(),
                    "push".into(),
                    "-u".into(),
                    "-m".into(),
                    format!(
                        "branchline-undo-discard {}",
                        chrono::Utc::now().to_rfc3339()
                    ),
                    "--".into(),
                ];
                args.extend(paths.iter().map(|s| (*s).to_string()));
                let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
                git_cli::run_git(path, &arg_refs)?;
                let stash_oid = git_cli::stash_tip_oid(path).unwrap_or_else(|_| "stash@{0}".into());
                return Ok(ExecuteOutcome {
                    message: "Discarded changes (undo available)".into(),
                    undoable: true,
                    undo_action: Some("discard".into()),
                    undo_label: Some("Restore discarded changes".into()),
                    undo_payload: Some(json!({
                        "paths": paths,
                        "stashRef": stash_oid,
                    })),
                });
            }
            if paths.len() == 1 && paths[0] == "." {
                git_cli::run_git(path, &["checkout", "--", "."])?;
                Ok(outcome_msg(git_cli::run_git(path, &["clean", "-fd"])?))
            } else {
                let mut checkout = vec!["checkout", "--"];
                checkout.extend(paths.iter().copied());
                git_cli::run_git(path, &checkout)?;
                let mut clean = vec!["clean", "-fd", "--"];
                clean.extend(paths.iter().copied());
                let _ = git_cli::run_git(path, &clean);
                Ok(outcome_msg("Discarded changes"))
            }
        }
        SafetyAction::DeleteTag => {
            let tag = analysis.target.clone().unwrap_or_default();
            Ok(outcome_msg(git_cli::run_git(path, &["tag", "-d", &tag])?))
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExecuteOutcome {
    pub message: String,
    pub undoable: bool,
    pub undo_action: Option<String>,
    pub undo_label: Option<String>,
    pub undo_payload: Option<serde_json::Value>,
}

fn outcome_msg(message: impl Into<String>) -> ExecuteOutcome {
    ExecuteOutcome {
        message: message.into(),
        undoable: false,
        undo_action: None,
        undo_label: None,
        undo_payload: None,
    }
}

fn split_pathspecs(target: &str) -> Vec<&str> {
    if target.contains('\n') {
        target
            .split('\n')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect()
    } else if target.contains(',') {
        target
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        vec![target]
    }
}
