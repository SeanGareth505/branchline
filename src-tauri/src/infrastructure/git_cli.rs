use crate::{AppError, AppResult};
use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

/// Hard cap for git stdout/stderr captured into memory (protects against OOM).
pub const MAX_GIT_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const GIT_LOCK_RETRIES: u32 = 8;
const GIT_LOCK_RETRY_MS: u64 = 40;
type OutputCallback = Arc<dyn Fn(String) + Send + Sync>;

pub fn git_bin() -> AppResult<String> {
    which::which("git")
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|_| AppError::msg("Git executable not found on PATH"))
}

pub fn apply_tool_path(cmd: &mut Command) {
    cmd.env("PATH", enriched_path());
}

pub fn detach_child(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        const DETACHED_PROCESS: u32 = 0x00000008;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_NO_WINDOW);
    }
}

pub fn clarify_git_error(raw: &str) -> String {
    let text = raw.trim();
    if text.is_empty() {
        return "Git command failed.".into();
    }
    let lower = text.to_ascii_lowercase();
    let missing_node = lower.contains("npm: command not found")
        || lower.contains("npx: command not found")
        || lower.contains("node: command not found")
        || lower.contains("npm is not recognized")
        || lower.contains("npx is not recognized")
        || lower.contains("node is not recognized");
    if missing_node || (lower.contains("husky") && lower.contains("code 127")) {
        return "A Git hook could not find Node.js (npm). Restart Branchline so it can see Homebrew or nvm, then retry.".into();
    }
    if lower.contains("husky -") && lower.contains("script failed") {
        return "A Git hook blocked this commit. Fix the failing check, then retry.".into();
    }
    if lower.contains("hook declined") {
        return "A Git hook blocked this operation. Fix the hook output, then retry.".into();
    }
    text.to_string()
}

fn git_failure(args: &[&str], stdout: &str, stderr: &str) -> AppError {
    let message = if !stderr.trim().is_empty() {
        stderr.trim().to_string()
    } else if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        format!("git {args:?} failed")
    };
    AppError::git(clarify_git_error(&message))
}

fn extra_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/opt/node/bin"),
        PathBuf::from("/usr/local/opt/node/bin"),
    ];
    if let Ok(home) = env::var("HOME") {
        let home = PathBuf::from(home);
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".volta/bin"));
        dirs.push(home.join(".asdf/shims"));
        dirs.push(home.join(".fnm/aliases/default/bin"));
        dirs.push(home.join(".local/share/fnm/aliases/default/bin"));
        dirs.push(home.join(".nodenv/shims"));
        let nvm = home.join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(&nvm) {
            let mut versions: Vec<_> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
            versions.sort();
            if let Some(latest) = versions.last() {
                dirs.push(latest.join("bin"));
            }
        }
    }
    dirs.into_iter().filter(|path| path.is_dir()).collect()
}

fn enriched_path() -> OsString {
    static PATH: OnceLock<OsString> = OnceLock::new();
    PATH.get_or_init(|| {
        let mut dirs = extra_bin_dirs();
        if let Some(current) = env::var_os("PATH") {
            for part in env::split_paths(&current) {
                if !part.as_os_str().is_empty() && !dirs.iter().any(|dir| dir == &part) {
                    dirs.push(part);
                }
            }
        }
        env::join_paths(&dirs).unwrap_or_else(|_| env::var_os("PATH").unwrap_or_default())
    })
    .clone()
}

fn read_capped(
    mut reader: impl Read,
    max: usize,
    on_output: Option<OutputCallback>,
) -> (Vec<u8>, bool) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    let mut truncated = false;
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if let Some(emit) = &on_output {
                    emit(String::from_utf8_lossy(&chunk[..n]).to_string());
                }
                if buf.len() >= max {
                    truncated = true;
                    continue;
                }
                let room = max - buf.len();
                if n > room {
                    buf.extend_from_slice(&chunk[..room]);
                    truncated = true;
                } else {
                    buf.extend_from_slice(&chunk[..n]);
                }
            }
            Err(_) => break,
        }
    }
    (buf, truncated)
}

fn capture_git(
    cwd: Option<&Path>,
    args: &[&str],
    max_bytes: usize,
    on_output: Option<OutputCallback>,
) -> AppResult<(bool, String, String)> {
    let bin = git_bin()?;
    let mut cmd = Command::new(&bin);
    apply_tool_path(&mut cmd);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = cwd {
        cmd.current_dir(path);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::git(format!("Failed to run git: {e}")))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::git("Failed to capture git stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::git("Failed to capture git stderr"))?;

    let stdout_callback = on_output.clone();
    let out_handle = thread::spawn(move || read_capped(stdout, max_bytes, stdout_callback));
    let err_handle = thread::spawn(move || read_capped(stderr, max_bytes, on_output));

    let status = child
        .wait()
        .map_err(|e| AppError::git(format!("Failed to wait for git: {e}")))?;
    let (out_bytes, out_trunc) = out_handle
        .join()
        .unwrap_or_else(|_| (Vec::new(), false));
    let (err_bytes, err_trunc) = err_handle
        .join()
        .unwrap_or_else(|_| (Vec::new(), false));

    let mut stdout = String::from_utf8_lossy(&out_bytes).to_string();
    let mut stderr = String::from_utf8_lossy(&err_bytes).to_string();
    if out_trunc {
        stdout.push_str("\n… output truncated");
        log::warn!("git {:?} stdout truncated at {max_bytes} bytes", args);
    }
    if err_trunc {
        stderr.push_str("\n… output truncated");
    }

    Ok((status.success(), stdout, stderr))
}

pub fn run_git_capture(cwd: &Path, args: &[&str]) -> AppResult<(bool, String, String)> {
    capture_git(Some(cwd), args, MAX_GIT_OUTPUT_BYTES, None)
}

pub fn is_lock_contention(stdout: &str, stderr: &str) -> bool {
    let text = if stderr.trim().is_empty() {
        stdout
    } else {
        stderr
    };
    let lower = text.to_ascii_lowercase();
    lower.contains("index.lock")
        || lower.contains("another git process seems to be running")
        || (lower.contains("unable to create") && lower.contains(".lock"))
}

fn retry_lock_delay(attempt: u32) -> Duration {
    Duration::from_millis(GIT_LOCK_RETRY_MS.saturating_mul(u64::from(attempt.max(1))))
}

pub fn run_git(cwd: &Path, args: &[&str]) -> AppResult<String> {
    let (stdout, _) = run_git_out_err(cwd, args)?;
    Ok(stdout)
}

pub fn run_git_out_err(cwd: &Path, args: &[&str]) -> AppResult<(String, String)> {
    let mut attempt = 0u32;
    loop {
        let (ok, stdout, stderr) = run_git_capture(cwd, args)?;
        if ok {
            return Ok((stdout.trim_end().to_string(), stderr.trim_end().to_string()));
        }
        if attempt < GIT_LOCK_RETRIES && is_lock_contention(&stdout, &stderr) {
            attempt += 1;
            thread::sleep(retry_lock_delay(attempt));
            continue;
        }
        return Err(git_failure(args, &stdout, &stderr));
    }
}

pub fn run_git_out_err_stream<F>(
    cwd: &Path,
    args: &[&str],
    on_output: F,
) -> AppResult<(String, String)>
where
    F: Fn(String) + Send + Sync + 'static,
{
    let callback: OutputCallback = Arc::new(on_output);
    let mut attempt = 0u32;
    loop {
        let (ok, stdout, stderr) = capture_git(
            Some(cwd),
            args,
            MAX_GIT_OUTPUT_BYTES,
            Some(callback.clone()),
        )?;
        if ok {
            return Ok((stdout.trim_end().to_string(), stderr.trim_end().to_string()));
        }
        if attempt < GIT_LOCK_RETRIES && is_lock_contention(&stdout, &stderr) {
            attempt += 1;
            thread::sleep(retry_lock_delay(attempt));
            continue;
        }
        return Err(git_failure(args, &stdout, &stderr));
    }
}

pub fn run_git_strings(cwd: &Path, args: &[String]) -> AppResult<String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(cwd, &refs)
}

fn optional_remote(remote: Option<&str>) -> Option<&str> {
    remote.map(str::trim).filter(|s| !s.is_empty())
}

pub fn combine_git_output(stdout: &str, stderr: &str) -> String {
    let out = stdout.trim_end();
    let err = stderr.trim_end();
    if out.is_empty() {
        err.to_string()
    } else if err.is_empty() {
        out.to_string()
    } else {
        format!("{err}\n{out}")
    }
}

pub fn pull_args(remote: Option<&str>, rebase: bool) -> Vec<String> {
    let mut args = vec!["pull".to_string(), "--progress".to_string()];
    if rebase {
        args.push("--rebase".to_string());
    } else {
        args.push("--no-rebase".to_string());
    }
    if let Some(r) = optional_remote(remote) {
        args.push(r.to_string());
    }
    args
}

pub fn fetch_args(
    remote: Option<&str>,
    all_remotes: bool,
    prune: bool,
    tags: bool,
) -> Vec<String> {
    let mut args = vec!["fetch".to_string(), "--progress".to_string()];
    if all_remotes {
        args.push("--all".to_string());
    }
    if prune {
        args.push("--prune".to_string());
    }
    if tags {
        args.push("--tags".to_string());
    }
    if !all_remotes {
        if let Some(r) = optional_remote(remote) {
            args.push(r.to_string());
        }
    }
    args
}

pub fn run_git_with_stdin(cwd: &Path, args: &[&str], stdin_data: &str) -> AppResult<String> {
    let mut attempt = 0u32;
    loop {
        match run_git_with_stdin_once(cwd, args, stdin_data) {
            Ok(out) => return Ok(out),
            Err(err)
                if attempt < GIT_LOCK_RETRIES && is_lock_contention(&err.to_string(), "") =>
            {
                attempt += 1;
                thread::sleep(retry_lock_delay(attempt));
            }
            Err(err) => return Err(err),
        }
    }
}

fn run_git_with_stdin_once(cwd: &Path, args: &[&str], stdin_data: &str) -> AppResult<String> {
    use std::io::Write;

    let bin = git_bin()?;
    let mut child_cmd = Command::new(&bin);
    apply_tool_path(&mut child_cmd);
    let mut child = child_cmd
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::git(format!("Failed to spawn git: {e}")))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::git("Failed to open git stdin"))?;
    let payload = stdin_data.as_bytes().to_vec();
    let writer = thread::spawn(move || stdin.write_all(&payload));

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::git("Failed to capture git stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::git("Failed to capture git stderr"))?;
    let out_handle = thread::spawn(move || read_capped(stdout, MAX_GIT_OUTPUT_BYTES, None));
    let err_handle = thread::spawn(move || read_capped(stderr, MAX_GIT_OUTPUT_BYTES, None));

    let status = child
        .wait()
        .map_err(|e| AppError::git(format!("Failed to run git: {e}")))?;
    let _ = writer.join();
    let (out_bytes, out_trunc) = out_handle
        .join()
        .unwrap_or_else(|_| (Vec::new(), false));
    let (err_bytes, _) = err_handle
        .join()
        .unwrap_or_else(|_| (Vec::new(), false));

    let mut stdout = String::from_utf8_lossy(&out_bytes).to_string();
    let stderr = String::from_utf8_lossy(&err_bytes).to_string();
    if out_trunc {
        stdout.push_str("\n… output truncated");
    }

    if status.success() {
        Ok(stdout.trim_end().to_string())
    } else {
        Err(git_failure(args, &stdout, &stderr))
    }
}

pub fn run_git_global(args: &[&str]) -> AppResult<String> {
    let (ok, stdout, stderr) = capture_git(None, args, MAX_GIT_OUTPUT_BYTES, None)?;
    if ok {
        Ok(stdout.trim_end().to_string())
    } else {
        Err(AppError::git(clarify_git_error(&if stderr.trim().is_empty() {
            format!("git {:?} failed", args)
        } else {
            stderr.trim().to_string()
        })))
    }
}

pub fn run_git_allow_fail(cwd: &Path, args: &[&str]) -> (bool, String, String) {
    match capture_git(Some(cwd), args, MAX_GIT_OUTPUT_BYTES, None) {
        Ok(v) => v,
        Err(e) => (false, String::new(), e.to_string()),
    }
}

pub fn version() -> AppResult<String> {
    let out = run_git_global(&["--version"])?;
    Ok(out)
}

pub fn config_get(key: &str) -> AppResult<Option<String>> {
    config_get_scoped(None, key, ConfigScope::Global)
}

pub fn config_set(key: &str, value: &str) -> AppResult<()> {
    config_set_scoped(None, key, value, ConfigScope::Global)
}

#[derive(Debug, Clone, Copy)]
pub enum ConfigScope {
    Global,
    Local,
    Effective,
}

pub fn config_get_scoped(
    repo: Option<&Path>,
    key: &str,
    scope: ConfigScope,
) -> AppResult<Option<String>> {
    let bin = git_bin()?;
    let mut cmd = Command::new(&bin);
    apply_tool_path(&mut cmd);
    match scope {
        ConfigScope::Global => {
            cmd.args(["config", "--global", "--get", key]);
        }
        ConfigScope::Local => {
            let Some(path) = repo else {
                return Ok(None);
            };
            cmd.current_dir(path).args(["config", "--local", "--get", key]);
        }
        ConfigScope::Effective => {
            if let Some(path) = repo {
                cmd.current_dir(path).args(["config", "--get", key]);
            } else {
                cmd.args(["config", "--get", key]);
            }
        }
    }
    let output = cmd
        .output()
        .map_err(|e| AppError::git(format!("Failed to read git config: {e}")))?;
    if output.status.success() {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if value.is_empty() {
            Ok(None)
        } else {
            Ok(Some(value))
        }
    } else {
        Ok(None)
    }
}

pub fn config_set_scoped(
    repo: Option<&Path>,
    key: &str,
    value: &str,
    scope: ConfigScope,
) -> AppResult<()> {
    match scope {
        ConfigScope::Global | ConfigScope::Effective => {
            run_git_global(&["config", "--global", key, value])?;
        }
        ConfigScope::Local => {
            let path = repo.ok_or_else(|| AppError::msg("Repository path required for local config"))?;
            ensure_repo(path)?;
            run_git(path, &["config", "--local", key, value])?;
        }
    }
    Ok(())
}

pub fn config_unset_scoped(repo: Option<&Path>, key: &str, scope: ConfigScope) -> AppResult<()> {
    let args = match scope {
        ConfigScope::Global | ConfigScope::Effective => ["config", "--global", "--unset", key],
        ConfigScope::Local => ["config", "--local", "--unset", key],
    };
    if matches!(scope, ConfigScope::Local) {
        let path =
            repo.ok_or_else(|| AppError::msg("Repository path required for local config"))?;
        ensure_repo(path)?;
        let _ = run_git_allow_fail(path, &args);
        return Ok(());
    }
    let _ = capture_git(None, &args, MAX_GIT_OUTPUT_BYTES, None)?;
    Ok(())
}

pub fn ensure_repo(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::msg(format!(
            "Path does not exist: {}",
            path.display()
        )));
    }
    let git_dir = path.join(".git");
    if !git_dir.exists() {
        let (ok, _, _) = run_git_allow_fail(path, &["rev-parse", "--git-dir"]);
        if !ok {
            return Err(AppError::msg(format!(
                "Not a Git repository: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

pub fn resolve_repo_path(path: &Path) -> AppResult<PathBuf> {
    ensure_repo(path)?;
    let canonical = path
        .canonicalize()
        .map_err(|e| AppError::msg(format!("Invalid repository path: {e}")))?;
    let (ok, toplevel, err) = run_git_allow_fail(&canonical, &["rev-parse", "--show-toplevel"]);
    if !ok {
        return Err(AppError::msg(if err.trim().is_empty() {
            format!("Not a Git repository: {}", canonical.display())
        } else {
            err.trim().to_string()
        }));
    }
    let top = PathBuf::from(toplevel.trim());
    top.canonicalize()
        .or(Ok(top))
        .map_err(|e: std::io::Error| AppError::msg(e.to_string()))
}

pub fn validate_pathspecs(paths: &[String]) -> AppResult<()> {
    for raw in paths {
        let p = raw.trim();
        if p.is_empty() || p == "." {
            continue;
        }
        let path = Path::new(p);
        if path.is_absolute() {
            return Err(AppError::msg(format!(
                "Absolute pathspecs are not allowed: {p}"
            )));
        }
        for component in path.components() {
            match component {
                Component::ParentDir => {
                    return Err(AppError::msg(format!(
                        "Pathspecs may not contain '..': {p}"
                    )));
                }
                Component::RootDir | Component::Prefix(_) => {
                    return Err(AppError::msg(format!("Invalid pathspec: {p}")));
                }
                _ => {}
            }
        }
    }
    Ok(())
}

fn repo_lock_map() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn with_repo_lock<T, F>(path: &Path, f: F) -> AppResult<T>
where
    F: FnOnce(&Path) -> AppResult<T>,
{
    let resolved = resolve_repo_path(path)?;
    let key = resolved.to_string_lossy().to_string();
    let lock = {
        let mut map = repo_lock_map()
            .lock()
            .map_err(|e| AppError::msg(e.to_string()))?;
        map.entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _guard = lock.lock().map_err(|e| AppError::msg(e.to_string()))?;
    f(&resolved)
}

pub fn stash_tip_oid(path: &Path) -> AppResult<String> {
    let oid = run_git(path, &["rev-parse", "-q", "--verify", "refs/stash"])?;
    if oid.trim().is_empty() {
        return Err(AppError::msg("No stash entry created"));
    }
    Ok(oid.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pull_without_remote_lets_git_use_configured_upstream() {
        assert_eq!(
            pull_args(None, false),
            vec!["pull", "--progress", "--no-rebase"]
        );
        assert_eq!(
            pull_args(Some(""), false),
            vec!["pull", "--progress", "--no-rebase"]
        );
        assert_eq!(
            pull_args(Some("  "), true),
            vec!["pull", "--progress", "--rebase"]
        );
    }

    #[test]
    fn pull_with_named_remote_does_not_assume_origin() {
        assert_eq!(
            pull_args(Some("upstream"), false),
            vec!["pull", "--progress", "--no-rebase", "upstream"]
        );
        assert_eq!(
            pull_args(Some("origin"), true),
            vec!["pull", "--progress", "--rebase", "origin"]
        );
    }

    #[test]
    fn fetch_without_remote_lets_git_use_configured_upstream() {
        assert_eq!(
            fetch_args(None, false, false, false),
            vec!["fetch", "--progress"]
        );
        assert_eq!(
            fetch_args(Some("upstream"), false, false, false),
            vec!["fetch", "--progress", "upstream"]
        );
    }

    #[test]
    fn combine_stdout_and_stderr() {
        assert_eq!(combine_git_output("pushed", ""), "pushed");
        assert_eq!(combine_git_output("", "writing objects"), "writing objects");
        assert_eq!(
            combine_git_output("to origin\n", "enumerating objects\n"),
            "enumerating objects\nto origin"
        );
    }

    #[test]
    fn streams_git_output_while_capturing_result() {
        let chunks = Arc::new(Mutex::new(String::new()));
        let streamed = chunks.clone();
        let (stdout, stderr) = run_git_out_err_stream(Path::new("."), &["--version"], move |chunk| {
            streamed.lock().unwrap().push_str(&chunk);
        })
        .unwrap();

        assert!(stderr.is_empty());
        assert!(stdout.starts_with("git version"));
        assert!(chunks.lock().unwrap().starts_with("git version"));
    }

    #[test]
    fn fetch_all_prune_and_tags_flags() {
        assert_eq!(
            fetch_args(Some("origin"), true, true, false),
            vec!["fetch", "--progress", "--all", "--prune"]
        );
        assert_eq!(
            fetch_args(Some("origin"), false, true, true),
            vec!["fetch", "--progress", "--prune", "--tags", "origin"]
        );
    }

    #[test]
    fn clarifies_missing_npm_in_husky_hooks() {
        let message = clarify_git_error(
            ".husky/pre-commit: line 1: npm: command not found\nhusky - pre-commit script failed (code 127)",
        );
        assert!(message.to_ascii_lowercase().contains("npm"));
        assert!(message.to_ascii_lowercase().contains("restart"));
    }

    #[test]
    fn clarifies_generic_husky_failures() {
        let message = clarify_git_error("husky - pre-commit script failed (code 1)");
        assert!(message.to_ascii_lowercase().contains("hook"));
        assert!(message.to_ascii_lowercase().contains("retry"));
    }

    #[test]
    fn detects_index_lock_contention() {
        assert!(is_lock_contention(
            "",
            "fatal: Unable to create '/tmp/repo/.git/index.lock': File exists.\nAnother git process seems to be running in this repository",
        ));
        assert!(is_lock_contention(
            "",
            "fatal: Unable to create '/tmp/repo/.git/refs/heads/main.lock': File exists.",
        ));
        assert!(!is_lock_contention("", "fatal: not a git repository"));
    }
}
