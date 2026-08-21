use crate::commands::branch::{MutationOutput, RepoPathInput};
use crate::commands::settings::{load_settings_with_tokens, AppSettings};
use crate::infrastructure::git_cli;
use crate::state::AppState;
use crate::{run_blocking, AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::command;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchHygieneEntry {
    pub name: String,
    pub reason: String,
    pub detail: String,
    pub safe_to_delete: bool,
    pub tip_sha: String,
    pub tip_short_sha: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCommitEntry {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCommitsInput {
    pub path: String,
    pub direction: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanEntry {
    pub path: String,
    pub kind: String,
    pub size_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCleanInput {
    pub path: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileEntry {
    pub path: String,
    pub size_label: String,
    pub bytes: u64,
    pub lfs: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetFileFlagInput {
    pub path: String,
    pub file: String,
    pub flag: String,
    pub enable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFlagEntry {
    pub path: String,
    pub skip_worktree: bool,
    pub assume_unchanged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatPatchInput {
    pub path: String,
    pub sha: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatPatchOutput {
    pub patch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyMailboxPatchInput {
    pub path: String,
    pub patch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitStatusesInput {
    pub path: String,
    pub shas: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitStatusEntry {
    pub sha: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobPreviewInput {
    pub path: String,
    pub file: String,
    #[serde(default)]
    pub revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobPreviewOutput {
    pub kind: String,
    pub mime: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
}

const HYGIENE_CAP: usize = 200;
const CLEAN_CAP: usize = 500;
const DANGLING_CAP: usize = 40;
const LARGE_FILE_CAP: usize = 40;
const LARGE_FILE_MIN_BYTES: u64 = 512_000;
const FILE_FLAGS_CAP: usize = 200;
const STATUS_SHA_CAP: usize = 12;
const BLOB_MAX_BYTES: u64 = 1_572_864;
const STALE_SECS: i64 = 90 * 24 * 60 * 60;

fn format_size_label(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * 1024;
    if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{} KB", bytes / KB)
    } else if bytes == 0 {
        "—".into()
    } else {
        format!("{bytes} B")
    }
}

fn file_size_label(repo: &Path, rel: &str) -> String {
    match std::fs::metadata(repo.join(rel)) {
        Ok(meta) => format_size_label(meta.len()),
        Err(_) => "—".into(),
    }
}

fn unquote_git_path(raw: &str) -> String {
    let s = raw.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s[1..s.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\")
    } else {
        s.to_string()
    }
}

fn parse_log_entries(out: &str) -> Vec<SyncCommitEntry> {
    let mut entries = Vec::new();
    for line in out.lines() {
        let parts: Vec<&str> = line.split('\x1f').collect();
        if parts.len() < 5 {
            continue;
        }
        entries.push(SyncCommitEntry {
            sha: parts[0].to_string(),
            short_sha: parts[1].to_string(),
            subject: parts[2].to_string(),
            author: parts[3].to_string(),
            timestamp: parts[4].parse().unwrap_or(0),
        });
    }
    entries
}

fn is_protected_branch(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "main" | "master" | "develop" | "trunk"
    )
}

fn encode_base64(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let a = chunk[0] as u32;
        let b = chunk.get(1).copied().unwrap_or(0) as u32;
        let c = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (a << 16) | (b << 8) | c;
        out.push(CHARS[((n >> 18) & 63) as usize] as char);
        out.push(CHARS[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(CHARS[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(CHARS[(n & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn mime_from_file(file: &str) -> (bool, String) {
    let ext = Path::new(file)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => (true, "image/png".into()),
        "jpg" | "jpeg" => (true, "image/jpeg".into()),
        "gif" => (true, "image/gif".into()),
        "webp" => (true, "image/webp".into()),
        "svg" => (true, "image/svg+xml".into()),
        "bmp" => (true, "image/bmp".into()),
        "ico" => (true, "image/x-icon".into()),
        _ => (false, "application/octet-stream".into()),
    }
}

fn parse_github_owner_repo(url: &str) -> Option<(String, String)> {
    let u = url.trim();
    let rest = if let Some(r) = u.strip_prefix("git@github.com:") {
        r
    } else if let Some(r) = u.strip_prefix("ssh://git@github.com/") {
        r
    } else if let Some(r) = u.strip_prefix("https://github.com/") {
        r
    } else if let Some(r) = u.strip_prefix("http://github.com/") {
        r
    } else if let Some(idx) = u.find("github.com/") {
        &u[idx + "github.com/".len()..]
    } else if let Some(idx) = u.find("github.com:") {
        &u[idx + "github.com:".len()..]
    } else {
        return None;
    };
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let mut parts = rest.split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

fn resolve_github_repo(path: &Path) -> Option<(String, String)> {
    for remote in ["origin", "upstream"] {
        let (ok, out, _) = git_cli::run_git_allow_fail(path, &["remote", "get-url", remote]);
        if ok {
            if let Some(pair) = parse_github_owner_repo(out.trim()) {
                return Some(pair);
            }
        }
    }
    let (ok, out, _) = git_cli::run_git_allow_fail(path, &["remote", "-v"]);
    if ok {
        for line in out.lines() {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() >= 2 {
                if let Some(pair) = parse_github_owner_repo(cols[1]) {
                    return Some(pair);
                }
            }
        }
    }
    None
}

fn github_http_client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new())
    })
}

fn github_token_from_settings(settings: &AppSettings) -> Option<String> {
    crate::commands::github_git::resolve_github_api_connection(settings)
        .map(|connection| connection.token)
}

fn map_github_state(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "success" => "success".into(),
        "failure" | "error" => "failure".into(),
        "pending" => "pending".into(),
        _ => "unknown".into(),
    }
}

fn unknown_statuses(shas: &[String]) -> Vec<CommitStatusEntry> {
    shas.iter()
        .map(|sha| CommitStatusEntry {
            sha: sha.clone(),
            state: "unknown".into(),
        })
        .collect()
}

fn git_blob_size(path: &Path, spec: &str) -> Option<u64> {
    let (ok, out, _) = git_cli::run_git_allow_fail(path, &["cat-file", "-s", spec]);
    if !ok {
        return None;
    }
    out.trim().parse().ok()
}

fn git_blob_bytes(path: &Path, spec: &str) -> AppResult<Vec<u8>> {
    let bin = git_cli::git_bin()?;
    let output = Command::new(bin)
        .args(["show", spec])
        .current_dir(path)
        .output()
        .map_err(|e| AppError::git(format!("Failed to read blob: {e}")))?;
    if !output.status.success() {
        return Err(AppError::git("Blob not found"));
    }
    Ok(output.stdout)
}

fn has_upstream_remote(path: &Path) -> bool {
    let (ok, out, _) = git_cli::run_git_allow_fail(path, &["remote"]);
    ok && out.lines().any(|l| l.trim() == "upstream")
}

fn upstream_default_ref(path: &Path) -> Option<String> {
    let (ok, out, _) =
        git_cli::run_git_allow_fail(path, &["symbolic-ref", "refs/remotes/upstream/HEAD"]);
    if ok {
        let trimmed = out.trim();
        if !trimmed.is_empty() {
            let name = trimmed
                .strip_prefix("refs/remotes/")
                .unwrap_or(trimmed)
                .to_string();
            return Some(name);
        }
    }
    for name in ["upstream/main", "upstream/master"] {
        let (ok, _, _) =
            git_cli::run_git_allow_fail(path, &["rev-parse", "--verify", "--quiet", name]);
        if ok {
            return Some(name.to_string());
        }
    }
    None
}

fn check_attr_lfs(path: &Path, files: &[String]) -> std::collections::HashSet<String> {
    let mut lfs = std::collections::HashSet::new();
    if files.is_empty() {
        return lfs;
    }
    let mut args = vec!["check-attr".to_string(), "filter".to_string(), "--".to_string()];
    args.extend(files.iter().cloned());
    let (ok, out, _) = {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        git_cli::run_git_allow_fail(path, &refs)
    };
    if !ok {
        return lfs;
    }
    for line in out.lines() {
        if let Some((file, rest)) = line.split_once(": filter: ") {
            if rest.trim() == "lfs" {
                lfs.insert(file.to_string());
            }
        }
    }
    lfs
}

fn containing_remote_branch(path: &Path, tip_sha: &str) -> Option<String> {
    let contains = format!("--contains={tip_sha}");
    let (ok, out, _) = git_cli::run_git_allow_fail(
        path,
        &[
            "for-each-ref",
            &contains,
            "--format=%(refname:short)",
            "refs/remotes",
        ],
    );
    if !ok {
        return None;
    }
    out.lines()
        .map(str::trim)
        .find(|name| !name.is_empty() && !name.ends_with("/HEAD"))
        .map(str::to_string)
}

#[command]
pub fn list_branch_hygiene(input: RepoPathInput) -> AppResult<Vec<BranchHygieneEntry>> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let current = git_cli::run_git_allow_fail(&path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .1
        .trim()
        .to_string();
    let (ok, out, _) = git_cli::run_git_allow_fail(
        &path,
        &[
            "for-each-ref",
            "refs/heads",
            "--format=%(refname:short)|%(objectname)|%(objectname:short)|%(committerdate:unix)|%(upstream:track)",
        ],
    );
    if !ok {
        return Ok(vec![]);
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let stale_before = now.saturating_sub(STALE_SECS);
    let mut entries = Vec::new();
    for line in out.lines() {
        if entries.len() >= HYGIENE_CAP {
            break;
        }
        let parts: Vec<&str> = line.splitn(5, '|').collect();
        if parts.len() < 4 {
            continue;
        }
        let name = parts[0].trim();
        if name.is_empty() || name == current || is_protected_branch(name) {
            continue;
        }
        let tip_sha = parts[1].to_string();
        let tip_short_sha = parts[2].to_string();
        let committerdate: i64 = parts[3].parse().unwrap_or(0);
        let track = parts.get(4).copied().unwrap_or("");
        let gone = track.contains("[gone]");
        let merged_into_head = git_cli::run_git_allow_fail(
            &path,
            &[
                "merge-base",
                "--is-ancestor",
                &format!("refs/heads/{name}"),
                "HEAD",
            ],
        )
        .0;
        let remote_merge_target = if gone && !merged_into_head {
            containing_remote_branch(&path, &tip_sha)
        } else {
            None
        };
        let safe_to_delete = merged_into_head || remote_merge_target.is_some();
        let (reason, detail) = if gone {
            (
                "gone",
                if merged_into_head {
                    "Merged into HEAD".to_string()
                } else if let Some(target) = remote_merge_target {
                    format!("Merged into {target}")
                } else if track.trim().is_empty() {
                    "Remote-tracking branch is gone".to_string()
                } else {
                    track.trim().to_string()
                },
            )
        } else {
            if safe_to_delete {
                ("merged", "Merged into HEAD".to_string())
            } else if committerdate > 0 && committerdate < stale_before {
                let days = ((now - committerdate) / 86_400).max(1);
                ("stale", format!("Last commit {days} days ago"))
            } else {
                continue;
            }
        };
        entries.push(BranchHygieneEntry {
            name: name.to_string(),
            reason: reason.into(),
            detail,
            safe_to_delete,
            tip_sha,
            tip_short_sha,
        });
    }
    Ok(entries)
}

#[command]
pub fn list_sync_commits(input: SyncCommitsInput) -> AppResult<Vec<SyncCommitEntry>> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let (ok, _, _) = git_cli::run_git_allow_fail(&path, &["rev-parse", "--abbrev-ref", "@{upstream}"]);
    if !ok {
        return Ok(vec![]);
    }
    let range = match input.direction.trim().to_ascii_lowercase().as_str() {
        "incoming" => "HEAD..@{upstream}",
        "outgoing" => "@{upstream}..HEAD",
        _ => {
            return Err(AppError::msg(
                "direction must be incoming or outgoing",
            ))
        }
    };
    let (ok, out, _) = git_cli::run_git_allow_fail(
        &path,
        &[
            "log",
            "--max-count=50",
            "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%at",
            range,
        ],
    );
    if !ok {
        return Ok(vec![]);
    }
    Ok(parse_log_entries(&out))
}

#[command]
pub fn preview_clean(input: RepoPathInput) -> AppResult<Vec<CleanEntry>> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let (ok, out, _) = git_cli::run_git_allow_fail(&path, &["clean", "-nd"]);
    if !ok {
        return Ok(vec![]);
    }
    let mut entries = Vec::new();
    for line in out.lines() {
        if entries.len() >= CLEAN_CAP {
            break;
        }
        let Some(rest) = line.strip_prefix("Would remove ") else {
            continue;
        };
        let rel = unquote_git_path(rest);
        if rel.is_empty() {
            continue;
        }
        entries.push(CleanEntry {
            path: rel.clone(),
            kind: "untracked".into(),
            size_label: file_size_label(&path, &rel),
        });
    }
    Ok(entries)
}

#[command]
pub fn run_clean(input: RunCleanInput) -> AppResult<MutationOutput> {
    git_cli::validate_pathspecs(&input.paths)?;
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        if input.paths.is_empty() {
            return Ok(MutationOutput {
                ok: false,
                message: "No paths to clean".into(),
            });
        }
        let mut args = vec!["clean".to_string(), "-fd".to_string(), "--".to_string()];
        args.extend(input.paths.iter().cloned());
        match git_cli::run_git_strings(path, &args) {
            Ok(out) => Ok(MutationOutput {
                ok: true,
                message: if out.trim().is_empty() {
                    "Cleaned".into()
                } else {
                    out
                },
            }),
            Err(e) => Ok(MutationOutput {
                ok: false,
                message: e.to_string(),
            }),
        }
    })
}

#[command]
pub fn list_dangling_commits(input: RepoPathInput) -> AppResult<Vec<SyncCommitEntry>> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let (ok, out, _) =
        git_cli::run_git_allow_fail(&path, &["fsck", "--unreachable", "--no-reflogs"]);
    if !ok {
        return Ok(vec![]);
    }
    let mut entries = Vec::new();
    for line in out.lines() {
        if entries.len() >= DANGLING_CAP {
            break;
        }
        let Some(sha) = line.strip_prefix("unreachable commit ") else {
            continue;
        };
        let sha = sha.trim();
        if sha.is_empty() {
            continue;
        }
        let (ok, log_out, _) = git_cli::run_git_allow_fail(
            &path,
            &[
                "log",
                "-1",
                "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%at",
                sha,
            ],
        );
        if !ok {
            continue;
        }
        entries.extend(parse_log_entries(&log_out));
    }
    Ok(entries)
}

#[command]
pub fn list_large_files(input: RepoPathInput) -> AppResult<Vec<LargeFileEntry>> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let (ok, out, _) = git_cli::run_git_allow_fail(&path, &["ls-files", "-z"]);
    if !ok {
        return Ok(vec![]);
    }
    let mut candidates: Vec<(String, u64)> = Vec::new();
    for rel in out.split('\0') {
        if rel.is_empty() {
            continue;
        }
        if rel == ".git" || rel.starts_with(".git/") || rel.starts_with(".git\\") {
            continue;
        }
        let full = path.join(rel);
        let Ok(meta) = std::fs::metadata(&full) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let bytes = meta.len();
        if bytes >= LARGE_FILE_MIN_BYTES {
            candidates.push((rel.to_string(), bytes));
        }
    }
    candidates.sort_by(|a, b| b.1.cmp(&a.1));
    candidates.truncate(LARGE_FILE_CAP);
    let paths: Vec<String> = candidates.iter().map(|(p, _)| p.clone()).collect();
    let lfs_set = check_attr_lfs(&path, &paths);
    Ok(candidates
        .into_iter()
        .map(|(rel, bytes)| LargeFileEntry {
            lfs: lfs_set.contains(&rel),
            path: rel,
            size_label: format_size_label(bytes),
            bytes,
        })
        .collect())
}

#[command]
pub fn set_file_flag(input: SetFileFlagInput) -> AppResult<MutationOutput> {
    git_cli::validate_pathspecs(&[input.file.clone()])?;
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let file = input.file.trim();
        if file.is_empty() {
            return Ok(MutationOutput {
                ok: false,
                message: "File path is required".into(),
            });
        }
        let flag = match input.flag.trim() {
            "skip-worktree" => {
                if input.enable {
                    "--skip-worktree"
                } else {
                    "--no-skip-worktree"
                }
            }
            "assume-unchanged" => {
                if input.enable {
                    "--assume-unchanged"
                } else {
                    "--no-assume-unchanged"
                }
            }
            _ => {
                return Ok(MutationOutput {
                    ok: false,
                    message: "flag must be skip-worktree or assume-unchanged".into(),
                })
            }
        };
        match git_cli::run_git(path, &["update-index", flag, "--", file]) {
            Ok(_) => Ok(MutationOutput {
                ok: true,
                message: if input.enable {
                    format!("Set {flag} on {file}")
                } else {
                    format!("Cleared {flag} on {file}")
                },
            }),
            Err(e) => Ok(MutationOutput {
                ok: false,
                message: e.to_string(),
            }),
        }
    })
}

#[command]
pub fn list_file_flags(input: RepoPathInput) -> AppResult<Vec<FileFlagEntry>> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let (ok, out, _) = git_cli::run_git_allow_fail(&path, &["ls-files", "-v"]);
    if !ok {
        return Ok(vec![]);
    }
    let mut entries = Vec::new();
    for line in out.lines() {
        if entries.len() >= FILE_FLAGS_CAP {
            break;
        }
        let mut chars = line.chars();
        let Some(tag) = chars.next() else {
            continue;
        };
        if chars.next() != Some(' ') {
            continue;
        }
        let rel = chars.as_str();
        if rel.is_empty() {
            continue;
        }
        let skip_worktree = tag == 'S' || tag == 's';
        let assume_unchanged = tag.is_ascii_lowercase();
        if !skip_worktree && !assume_unchanged {
            continue;
        }
        entries.push(FileFlagEntry {
            path: rel.to_string(),
            skip_worktree,
            assume_unchanged,
        });
    }
    Ok(entries)
}

#[command]
pub fn format_patch(input: FormatPatchInput) -> AppResult<FormatPatchOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::ensure_repo(&path)?;
    let sha = input.sha.trim();
    if sha.is_empty() {
        return Err(AppError::msg("Commit SHA is required"));
    }
    let patch = git_cli::run_git(&path, &["format-patch", "-1", "--stdout", sha])?;
    Ok(FormatPatchOutput { patch })
}

#[command]
pub fn apply_mailbox_patch(input: ApplyMailboxPatchInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        let patch = input.patch.trim();
        if patch.is_empty() {
            return Ok(MutationOutput {
                ok: false,
                message: "No patch to apply".into(),
            });
        }
        let payload = format!("{patch}\n");
        let result = if patch.starts_with("From ") {
            git_cli::run_git_with_stdin(path, &["am", "--3way"], &payload)
        } else {
            git_cli::run_git_with_stdin(path, &["apply", "--whitespace=nowarn", "-"], &payload)
        };
        match result {
            Ok(out) => Ok(MutationOutput {
                ok: true,
                message: if out.trim().is_empty() {
                    "Patch applied".into()
                } else {
                    out
                },
            }),
            Err(e) => {
                let msg = e.to_string();
                if msg.to_lowercase().contains("conflict") {
                    Ok(MutationOutput {
                        ok: false,
                        message: format!("Patch conflicts — resolve files, then continue. {msg}"),
                    })
                } else {
                    Ok(MutationOutput {
                        ok: false,
                        message: msg,
                    })
                }
            }
        }
    })
}

#[command]
pub fn sync_upstream(input: RepoPathInput) -> AppResult<MutationOutput> {
    git_cli::with_repo_lock(&PathBuf::from(&input.path), |path| {
        if !has_upstream_remote(path) {
            return Ok(MutationOutput {
                ok: false,
                message: "No remote named upstream".into(),
            });
        }
        if let Err(e) = git_cli::run_git(path, &["fetch", "upstream"]) {
            return Ok(MutationOutput {
                ok: false,
                message: e.to_string(),
            });
        }
        let Some(merge_ref) = upstream_default_ref(path) else {
            return Ok(MutationOutput {
                ok: false,
                message: "Could not detect upstream default branch".into(),
            });
        };
        match git_cli::run_git(path, &["merge", "--no-edit", &merge_ref]) {
            Ok(out) => Ok(MutationOutput {
                ok: true,
                message: if out.trim().is_empty() {
                    format!("Merged {merge_ref}")
                } else {
                    out
                },
            }),
            Err(e) => {
                let msg = e.to_string();
                if msg.to_lowercase().contains("conflict") {
                    Ok(MutationOutput {
                        ok: false,
                        message: format!(
                            "Merge conflicts while syncing {merge_ref} — resolve files, then Continue. {msg}"
                        ),
                    })
                } else {
                    Ok(MutationOutput {
                        ok: false,
                        message: msg,
                    })
                }
            }
        }
    })
}

#[command]
pub async fn list_commit_statuses(
    state: State<'_, AppState>,
    input: CommitStatusesInput,
) -> AppResult<Vec<CommitStatusEntry>> {
    let settings = load_settings_with_tokens(&state).ok();
    run_blocking(move || list_commit_statuses_inner(settings, input)).await
}

fn list_commit_statuses_inner(
    settings: Option<AppSettings>,
    input: CommitStatusesInput,
) -> AppResult<Vec<CommitStatusEntry>> {
    let mut shas: Vec<String> = input
        .shas
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .take(STATUS_SHA_CAP)
        .collect();
    shas.dedup();
    if shas.is_empty() {
        return Ok(vec![]);
    }
    let path = PathBuf::from(&input.path);
    if git_cli::ensure_repo(&path).is_err() {
        return Ok(unknown_statuses(&shas));
    }
    let Some((owner, repo)) = resolve_github_repo(&path) else {
        return Ok(unknown_statuses(&shas));
    };
    let token = settings.as_ref().and_then(github_token_from_settings);
    let client = github_http_client();
    let mut out = Vec::with_capacity(shas.len());
    for sha in &shas {
        let url = format!("https://api.github.com/repos/{owner}/{repo}/commits/{sha}/status");
        let mut req = client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "Branchline")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(token) = token.as_deref() {
            req = req.bearer_auth(token);
        }
        let state = match req.send() {
            Ok(response) if response.status().is_success() => {
                let parsed: serde_json::Value = response.json().unwrap_or(serde_json::Value::Null);
                parsed
                    .get("state")
                    .and_then(|v| v.as_str())
                    .map(map_github_state)
                    .unwrap_or_else(|| "unknown".into())
            }
            _ => "unknown".into(),
        };
        out.push(CommitStatusEntry {
            sha: sha.clone(),
            state,
        });
    }
    Ok(out)
}

#[command]
pub fn get_blob_preview(input: BlobPreviewInput) -> AppResult<BlobPreviewOutput> {
    let path = PathBuf::from(&input.path);
    git_cli::validate_pathspecs(&[input.file.clone()])?;
    git_cli::ensure_repo(&path)?;
    let file = input.file.trim();
    if file.is_empty() {
        return Ok(BlobPreviewOutput {
            kind: "missing".into(),
            mime: "application/octet-stream".into(),
            base64: None,
        });
    }
    let (is_image, mime) = mime_from_file(file);
    let revision = input
        .revision
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let git_path = file.replace('\\', "/");

    let (exists, size, bytes) = if let Some(rev) = revision {
        let spec = format!("{rev}:{git_path}");
        match git_blob_size(&path, &spec) {
            Some(size) => {
                if is_image && size <= BLOB_MAX_BYTES {
                    match git_blob_bytes(&path, &spec) {
                        Ok(data) => (true, size, Some(data)),
                        Err(_) => (false, 0, None),
                    }
                } else {
                    (true, size, None)
                }
            }
            None => (false, 0, None),
        }
    } else {
        let full = path.join(file);
        match std::fs::metadata(&full) {
            Ok(meta) if meta.is_file() => {
                let size = meta.len();
                if is_image && size <= BLOB_MAX_BYTES {
                    match std::fs::read(&full) {
                        Ok(data) => (true, size, Some(data)),
                        Err(_) => (false, 0, None),
                    }
                } else {
                    (true, size, None)
                }
            }
            _ => (false, 0, None),
        }
    };

    if !exists {
        return Ok(BlobPreviewOutput {
            kind: "missing".into(),
            mime,
            base64: None,
        });
    }
    if is_image && size <= BLOB_MAX_BYTES {
        if let Some(data) = bytes {
            return Ok(BlobPreviewOutput {
                kind: "image".into(),
                mime,
                base64: Some(encode_base64(&data)),
            });
        }
    }
    Ok(BlobPreviewOutput {
        kind: "binary".into(),
        mime,
        base64: None,
    })
}
