use crate::infrastructure::git_cli;
use crate::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatusEntry {
    pub path: String,
    pub status: FileStatusKind,
    pub original_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileStatusKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Conflicted,
    TypeChanged,
    Ignored,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationInfo {
    pub kind: String,
    pub label: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub path: String,
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: i32,
    pub behind: i32,
    pub is_detached: bool,
    pub staged: Vec<FileStatusEntry>,
    pub unstaged: Vec<FileStatusEntry>,
    pub untracked: Vec<FileStatusEntry>,
    pub conflicted: Vec<FileStatusEntry>,
    pub operation: Option<GitOperationInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: String,
    pub short_sha: String,
    pub message: String,
    pub subject: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    pub lane_hint: i32,
    pub is_relative_to_head: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtificialCommit {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub file_count: usize,
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub upstream_gone: bool,
    pub tip_sha: Option<String>,
    pub tip_short_sha: Option<String>,
    pub tip_subject: Option<String>,
    pub tip_author: Option<String>,
    pub tip_email: Option<String>,
    pub locked: bool,
    pub lock_reason: Option<String>,
}

pub fn repo_status(path: &Path) -> AppResult<RepoStatus> {
    git_cli::ensure_repo(path)?;
    let porcelain = git_cli::run_git(path, &["status", "--porcelain=v2", "--branch"])?;

    let mut branch = "HEAD".to_string();
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut is_detached = false;
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();
    let mut conflicted = Vec::new();

    for line in porcelain.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            if rest == "(detached)" {
                is_detached = true;
                branch = git_cli::run_git(path, &["rev-parse", "--short", "HEAD"])
                    .unwrap_or_else(|_| "detached".into());
            } else {
                branch = rest.to_string();
            }
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            upstream = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() >= 2 {
                ahead = parts[0].trim_start_matches('+').parse().unwrap_or(0);
                behind = parts[1].trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if let Some(rest) = line.strip_prefix("? ") {
            if untracked.len() < 5_000 {
                untracked.push(FileStatusEntry {
                    path: rest.to_string(),
                    status: FileStatusKind::Untracked,
                    original_path: None,
                    conflict_kind: None,
                    conflict_label: None,
                });
            }
        } else if let Some(rest) = line.strip_prefix("u ") {
            if conflicted.len() < 2_000 {
                if let Some(entry) = parse_unmerged_change(rest) {
                    conflicted.push(entry);
                }
            }
        } else if let Some(rest) = line.strip_prefix("1 ") {
            if staged.len() + unstaged.len() < 8_000 {
                parse_ordinary_change(rest, &mut staged, &mut unstaged);
            }
        } else if let Some(rest) = line.strip_prefix("2 ") {
            if staged.len() + unstaged.len() < 8_000 {
                parse_rename_change(rest, &mut staged, &mut unstaged);
            }
        }
    }

    let operation = detect_git_operation(path);

    Ok(RepoStatus {
        path: path.to_string_lossy().to_string(),
        branch,
        upstream,
        ahead,
        behind,
        is_detached,
        staged,
        unstaged,
        untracked,
        conflicted,
        operation,
    })
}

fn detect_git_operation(path: &Path) -> Option<GitOperationInfo> {
    let git_dir = {
        let (ok, out, _) = git_cli::run_git_allow_fail(path, &["rev-parse", "--git-dir"]);
        if !ok {
            return None;
        }
        let gd = PathBuf::from(out.trim());
        if gd.is_absolute() {
            gd
        } else {
            path.join(gd)
        }
    };

    if git_dir.join("CHERRY_PICK_HEAD").exists() {
        return Some(GitOperationInfo {
            kind: "cherryPick".into(),
            label: "Cherry-pick in progress".into(),
            detail: None,
        });
    }
    if git_dir.join("REVERT_HEAD").exists() {
        return Some(GitOperationInfo {
            kind: "revert".into(),
            label: "Revert in progress".into(),
            detail: None,
        });
    }
    if git_dir.join("REBASE_HEAD").exists()
        || git_dir.join("rebase-merge").exists()
        || git_dir.join("rebase-apply").exists()
    {
        let detail = rebase_progress_detail(&git_dir);
        return Some(GitOperationInfo {
            kind: "rebase".into(),
            label: "Rebase in progress".into(),
            detail,
        });
    }
    if git_dir.join("MERGE_HEAD").exists() {
        return Some(GitOperationInfo {
            kind: "merge".into(),
            label: "Merge in progress".into(),
            detail: None,
        });
    }
    None
}

fn rebase_progress_detail(git_dir: &Path) -> Option<String> {
    let dir = if git_dir.join("rebase-merge").exists() {
        git_dir.join("rebase-merge")
    } else if git_dir.join("rebase-apply").exists() {
        git_dir.join("rebase-apply")
    } else {
        return None;
    };
    let msgnum = std::fs::read_to_string(dir.join("msgnum"))
        .ok()?
        .trim()
        .to_string();
    let end = std::fs::read_to_string(dir.join("end"))
        .ok()?
        .trim()
        .to_string();
    if msgnum.is_empty() || end.is_empty() {
        return None;
    }
    Some(format!("step {msgnum} of {end}"))
}

fn parse_unmerged_change(rest: &str) -> Option<FileStatusEntry> {
    // u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
    let mut parts = rest.splitn(10, ' ');
    let xy = parts.next().unwrap_or("UU");
    for _ in 0..8 {
        let _ = parts.next();
    }
    let path = parts.next()?.to_string();
    if path.is_empty() {
        return None;
    }
    let (kind, label) = map_conflict_xy(xy);
    Some(FileStatusEntry {
        path,
        status: FileStatusKind::Conflicted,
        original_path: None,
        conflict_kind: Some(kind.into()),
        conflict_label: Some(label.into()),
    })
}

fn map_conflict_xy(xy: &str) -> (&'static str, &'static str) {
    match xy.trim() {
        "UU" => ("bothModified", "both modified"),
        "AA" => ("bothAdded", "both added"),
        "DD" => ("bothDeleted", "both deleted"),
        "AU" => ("addedByUs", "added by us"),
        "UA" => ("addedByThem", "added by them"),
        "DU" => ("deletedByUs", "deleted by us"),
        "UD" => ("deletedByThem", "deleted by them"),
        _ => ("conflict", "conflict"),
    }
}

fn parse_ordinary_change(
    rest: &str,
    staged: &mut Vec<FileStatusEntry>,
    unstaged: &mut Vec<FileStatusEntry>,
) {
    let mut parts = rest.splitn(8, ' ');
    let xy = parts.next().unwrap_or("..");
    for _ in 0..6 {
        let _ = parts.next();
    }
    let path = parts.next().unwrap_or("").to_string();
    let chars: Vec<char> = xy.chars().collect();
    let x = chars.first().copied().unwrap_or('.');
    let y = chars.get(1).copied().unwrap_or('.');
    if x != '.' {
        staged.push(FileStatusEntry {
            path: path.clone(),
            status: map_status_char(x),
            original_path: None,
            conflict_kind: None,
            conflict_label: None,
        });
    }
    if y != '.' {
        unstaged.push(FileStatusEntry {
            path,
            status: map_status_char(y),
            original_path: None,
            conflict_kind: None,
            conflict_label: None,
        });
    }
}

fn parse_rename_change(
    rest: &str,
    staged: &mut Vec<FileStatusEntry>,
    unstaged: &mut Vec<FileStatusEntry>,
) {
    let mut parts = rest.splitn(9, ' ');
    let xy = parts.next().unwrap_or("..");
    for _ in 0..6 {
        let _ = parts.next();
    }
    let _score = parts.next();
    let paths = parts.next().unwrap_or("");
    let (new_path, old_path) = if let Some((a, b)) = paths.split_once('\t') {
        (a.to_string(), Some(b.to_string()))
    } else {
        (paths.to_string(), None)
    };
    let chars: Vec<char> = xy.chars().collect();
    let x = chars.first().copied().unwrap_or('.');
    let y = chars.get(1).copied().unwrap_or('.');
    if x != '.' {
        staged.push(FileStatusEntry {
            path: new_path.clone(),
            status: FileStatusKind::Renamed,
            original_path: old_path.clone(),
            conflict_kind: None,
            conflict_label: None,
        });
    }
    if y != '.' {
        unstaged.push(FileStatusEntry {
            path: new_path,
            status: map_status_char(y),
            original_path: old_path,
            conflict_kind: None,
            conflict_label: None,
        });
    }
}

fn map_status_char(c: char) -> FileStatusKind {
    match c {
        'M' => FileStatusKind::Modified,
        'A' => FileStatusKind::Added,
        'D' => FileStatusKind::Deleted,
        'R' => FileStatusKind::Renamed,
        'C' => FileStatusKind::Copied,
        'T' => FileStatusKind::TypeChanged,
        'U' => FileStatusKind::Conflicted,
        _ => FileStatusKind::Unknown,
    }
}

pub fn commit_log(path: &Path, limit: usize) -> AppResult<Vec<CommitInfo>> {
    git_cli::ensure_repo(path)?;
    let repo = git2::Repository::open(path).map_err(|e| AppError::git(e.message()))?;
    let head_oid = repo.head().ok().and_then(|h| h.target());

    // Cap the ancestry walk — never materialize the entire history.
    let mut relative = std::collections::HashSet::new();
    if let Some(oid) = head_oid {
        if let Ok(mut walk) = repo.revwalk() {
            let _ = walk.push(oid);
            let walk_limit = limit.saturating_mul(3).clamp(64, 2_000);
            for (i, walked) in walk.flatten().enumerate() {
                if i >= walk_limit {
                    break;
                }
                relative.insert(walked);
            }
        }
    }

    let mut ref_map: std::collections::HashMap<git2::Oid, Vec<String>> =
        std::collections::HashMap::new();
    if let Ok(refs) = repo.references() {
        for reference in refs.flatten() {
            if let Some(oid) = reference.target() {
                if let Some(name) = reference.shorthand() {
                    ref_map.entry(oid).or_default().push(name.to_string());
                }
            }
        }
    }

    let format = "%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%at%x1f%P%x1e";
    let out = git_cli::run_git(
        path,
        &[
            "log",
            &format!("--max-count={limit}"),
            &format!("--pretty=format:{format}"),
            "--decorate=short",
            "--all",
        ],
    )?;

    let mut commits = Vec::new();
    let mut lane = 0i32;
    for entry in out.split('\x1e') {
        let entry = entry.trim_matches(|c| c == '\n' || c == '\r');
        if entry.is_empty() {
            continue;
        }
        let parts: Vec<&str> = entry.split('\x1f').collect();
        if parts.len() < 7 {
            continue;
        }
        let sha = parts[0].to_string();
        let oid = git2::Oid::from_str(&sha).ok();
        let parents: Vec<String> = parts[6]
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();
        let refs = oid
            .and_then(|o| ref_map.get(&o).cloned())
            .unwrap_or_default();
        let is_relative = oid.map(|o| relative.contains(&o)).unwrap_or(false);
        let subject = parts[2].to_string();
        let message = subject.clone();
        commits.push(CommitInfo {
            sha,
            short_sha: parts[1].to_string(),
            subject,
            message,
            author: parts[3].to_string(),
            email: parts[4].to_string(),
            timestamp: parts[5].parse().unwrap_or(0),
            parents,
            refs,
            lane_hint: lane % 8,
            is_relative_to_head: is_relative,
        });
        lane += 1;
    }
    Ok(commits)
}

pub fn commit_range(
    path: &Path,
    from: Option<&str>,
    to: Option<&str>,
    limit: usize,
) -> AppResult<Vec<CommitInfo>> {
    git_cli::ensure_repo(path)?;
    let range = match (from.filter(|s| !s.is_empty()), to.filter(|s| !s.is_empty())) {
        (Some(f), Some(t)) => format!("{f}..{t}"),
        (Some(f), None) => format!("{f}..HEAD"),
        (None, Some(t)) => t.to_string(),
        (None, None) => "HEAD".to_string(),
    };

    let format = "%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%at%x1f%P%x1e";
    let out = git_cli::run_git(
        path,
        &[
            "log",
            &format!("--max-count={limit}"),
            &format!("--pretty=format:{format}"),
            &range,
        ],
    )?;

    let mut commits = Vec::new();
    let mut lane = 0i32;
    for entry in out.split('\x1e') {
        let entry = entry.trim_matches(|c| c == '\n' || c == '\r');
        if entry.is_empty() {
            continue;
        }
        let parts: Vec<&str> = entry.split('\x1f').collect();
        if parts.len() < 8 {
            continue;
        }
        let subject = parts[2].to_string();
        let body = parts[3].trim().to_string();
        let message = if body.is_empty() {
            subject.clone()
        } else {
            format!("{subject}\n\n{body}")
        };
        let parents: Vec<String> = parts[7]
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();
        commits.push(CommitInfo {
            sha: parts[0].to_string(),
            short_sha: parts[1].to_string(),
            subject,
            message,
            author: parts[4].to_string(),
            email: parts[5].to_string(),
            timestamp: parts[6].parse().unwrap_or(0),
            parents,
            refs: vec![],
            lane_hint: lane % 8,
            is_relative_to_head: true,
        });
        lane += 1;
    }
    Ok(commits)
}

pub fn artificial_commits(path: &Path) -> AppResult<Vec<ArtificialCommit>> {
    let status = repo_status(path)?;
    let working_files: Vec<_> = status
        .unstaged
        .iter()
        .chain(status.untracked.iter())
        .chain(status.conflicted.iter())
        .collect();
    let staged_files = &status.staged;

    let count_kinds = |files: &[&FileStatusEntry]| {
        let mut added = 0;
        let mut modified = 0;
        let mut deleted = 0;
        for f in files {
            match f.status {
                FileStatusKind::Added | FileStatusKind::Untracked => added += 1,
                FileStatusKind::Deleted => deleted += 1,
                _ => modified += 1,
            }
        }
        (added, modified, deleted)
    };

    let working_refs: Vec<&FileStatusEntry> = working_files;
    let (w_added, w_mod, w_del) = count_kinds(&working_refs);
    let staged_refs: Vec<&FileStatusEntry> = staged_files.iter().collect();
    let (s_added, s_mod, s_del) = count_kinds(&staged_refs);

    Ok(vec![
        ArtificialCommit {
            id: "artificial:working".into(),
            kind: "workingDirectory".into(),
            label: "Working Directory".into(),
            file_count: working_refs.len(),
            added: w_added,
            modified: w_mod,
            deleted: w_del,
        },
        ArtificialCommit {
            id: "artificial:staged".into(),
            kind: "staged".into(),
            label: "Staged Changes".into(),
            file_count: staged_refs.len(),
            added: s_added,
            modified: s_mod,
            deleted: s_del,
        },
    ])
}

pub fn list_branches(path: &Path) -> AppResult<Vec<BranchInfo>> {
    git_cli::ensure_repo(path)?;
    let out = git_cli::run_git(
        path,
        &[
            "for-each-ref",
            "--format=%(refname)%09%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:track)%09%(objectname:short)%09%(objectname)%09%(contents:subject)%09%(authorname)%09%(authoremail)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;

    let mut branches = Vec::new();
    for line in out.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 2 {
            continue;
        }
        let full_ref = parts[0];
        if full_ref == "refs/remotes/origin/HEAD" || full_ref.ends_with("/HEAD") {
            continue;
        }
        let name = parts[1].to_string();
        let is_current = parts.get(2).map(|s| *s == "*").unwrap_or(false);
        let is_remote = full_ref.starts_with("refs/remotes/");
        let upstream = parts
            .get(3)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let track = parts.get(4).copied().unwrap_or("");
        let tip_short = parts
            .get(5)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let tip_sha = parts
            .get(6)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let tip_subject = parts
            .get(7)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let tip_author = parts
            .get(8)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let tip_email = parts
            .get(9)
            .filter(|s| !s.is_empty())
            .map(|s| s.trim_matches(|c| c == '<' || c == '>').to_string());
        branches.push(BranchInfo {
            name,
            is_current,
            is_remote,
            upstream,
            upstream_gone: track.contains("[gone]"),
            tip_sha,
            tip_short_sha: tip_short,
            tip_subject,
            tip_author,
            tip_email,
            locked: false,
            lock_reason: None,
        });
    }
    Ok(branches)
}

pub fn current_branch(path: &Path) -> AppResult<String> {
    let (ok, out, _) = git_cli::run_git_allow_fail(path, &["symbolic-ref", "--short", "HEAD"]);
    if ok {
        Ok(out.trim().to_string())
    } else {
        git_cli::run_git(path, &["rev-parse", "--short", "HEAD"])
    }
}

pub fn is_branch_merged(path: &Path, branch: &str) -> bool {
    let (ok, out, _) = git_cli::run_git_allow_fail(path, &["branch", "--merged"]);
    ok && out
        .lines()
        .any(|l| l.trim().trim_start_matches('*').trim() == branch)
}

pub fn is_remote_tracking_merged(path: &Path, remote_tracking: &str) -> bool {
    let (ok, out, _) = git_cli::run_git_allow_fail(path, &["branch", "-r", "--merged"]);
    ok && out.lines().any(|l| {
        let name = l.trim().trim_start_matches('*').trim();
        name == remote_tracking || name.strip_prefix("remotes/") == Some(remote_tracking)
    })
}

pub fn ref_exists(path: &Path, full_ref: &str) -> bool {
    let (ok, _, _) = git_cli::run_git_allow_fail(path, &["show-ref", "--verify", "--quiet", full_ref]);
    ok
}

pub fn is_remote_tracking_name(path: &Path, name: &str) -> bool {
    if name.is_empty() || name == "HEAD" {
        return false;
    }
    ref_exists(path, &format!("refs/remotes/{name}"))
}

pub fn parse_remote_tracking_name(name: &str) -> Option<(String, String)> {
    let name = name
        .strip_prefix("refs/remotes/")
        .or_else(|| name.strip_prefix("remotes/"))
        .unwrap_or(name);
    let slash = name.find('/')?;
    if slash == 0 || slash + 1 >= name.len() {
        return None;
    }
    let remote = name[..slash].to_string();
    let branch = name[slash + 1..].to_string();
    if remote.is_empty() || branch.is_empty() || branch == "HEAD" {
        return None;
    }
    Some((remote, branch))
}

pub fn branch_upstream_name(path: &Path, branch: &str) -> Option<String> {
    let (ok, out, _) = git_cli::run_git_allow_fail(
        path,
        &[
            "rev-parse",
            "--abbrev-ref",
            &format!("{branch}@{{upstream}}"),
        ],
    );
    if !ok {
        return None;
    }
    let name = out.trim();
    if name.is_empty() || name == "@{upstream}" {
        None
    } else {
        Some(name.to_string())
    }
}

pub fn local_branch_for_remote_tracking(path: &Path, remote_tracking: &str) -> Option<String> {
    if let Ok(branches) = list_branches(path) {
        if let Some(local) = branches.iter().find(|b| {
            !b.is_remote && b.upstream.as_deref() == Some(remote_tracking)
        }) {
            return Some(local.name.clone());
        }
    }
    let (_, branch) = parse_remote_tracking_name(remote_tracking)?;
    if ref_exists(path, &format!("refs/heads/{branch}")) {
        Some(branch)
    } else {
        None
    }
}

pub fn branch_has_upstream(path: &Path, branch: &str) -> bool {
    branch_upstream_name(path, branch).is_some()
}

pub fn ahead_behind(path: &Path) -> (i32, i32) {
    match repo_status(path) {
        Ok(s) => (s.ahead, s.behind),
        Err(_) => (0, 0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_remote_tracking_name_splits_remote_and_branch() {
        assert_eq!(
            parse_remote_tracking_name("origin/demo/graph-left"),
            Some(("origin".into(), "demo/graph-left".into()))
        );
        assert_eq!(
            parse_remote_tracking_name("refs/remotes/origin/feature/x"),
            Some(("origin".into(), "feature/x".into()))
        );
        assert_eq!(parse_remote_tracking_name("origin"), None);
        assert_eq!(parse_remote_tracking_name("origin/HEAD"), None);
    }

    #[test]
    fn parse_ordinary_unstaged_modified_path() {
        let rest = ".M N... 100644 100644 100644 d9ef4bb83307dc82828180265c36387b1fe48e80 d9ef4bb83307dc82828180265c36387b1fe48e80 src/app/features/commits/commit-dialog/commit-dialog.ts";
        let mut staged = Vec::new();
        let mut unstaged = Vec::new();
        parse_ordinary_change(rest, &mut staged, &mut unstaged);
        assert!(staged.is_empty());
        assert_eq!(unstaged.len(), 1);
        assert_eq!(
            unstaged[0].path,
            "src/app/features/commits/commit-dialog/commit-dialog.ts"
        );
        assert_eq!(unstaged[0].status, FileStatusKind::Modified);
    }

    #[test]
    fn parse_ordinary_staged_and_unstaged() {
        let rest = "MM N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb package.json";
        let mut staged = Vec::new();
        let mut unstaged = Vec::new();
        parse_ordinary_change(rest, &mut staged, &mut unstaged);
        assert_eq!(staged[0].path, "package.json");
        assert_eq!(staged[0].status, FileStatusKind::Modified);
        assert_eq!(unstaged[0].path, "package.json");
        assert_eq!(unstaged[0].status, FileStatusKind::Modified);
    }

    #[test]
    fn parse_rename_staged_paths() {
        let rest = "R. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb R100 new/name.ts\told/name.ts";
        let mut staged = Vec::new();
        let mut unstaged = Vec::new();
        parse_rename_change(rest, &mut staged, &mut unstaged);
        assert!(unstaged.is_empty());
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].path, "new/name.ts");
        assert_eq!(staged[0].original_path.as_deref(), Some("old/name.ts"));
        assert_eq!(staged[0].status, FileStatusKind::Renamed);
    }

    #[test]
    fn parse_unmerged_both_modified() {
        let rest = "UU N... 100644 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc docs/conflict demo.txt";
        let entry = parse_unmerged_change(rest).expect("parsed");
        assert_eq!(entry.path, "docs/conflict demo.txt");
        assert_eq!(entry.conflict_kind.as_deref(), Some("bothModified"));
        assert_eq!(entry.conflict_label.as_deref(), Some("both modified"));
    }

    #[test]
    fn parse_unmerged_deleted_by_us() {
        let rest = "DU N... 100644 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc src/gone.ts";
        let entry = parse_unmerged_change(rest).expect("parsed");
        assert_eq!(entry.conflict_kind.as_deref(), Some("deletedByUs"));
    }
}
