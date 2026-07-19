use crate::{AppError, AppResult};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

/// Hard cap for git stdout/stderr captured into memory (protects against OOM).
pub const MAX_GIT_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

pub fn git_bin() -> AppResult<String> {
    which::which("git")
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|_| AppError::msg("Git executable not found on PATH"))
}

fn read_capped(mut reader: impl Read, max: usize) -> (Vec<u8>, bool) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    let mut truncated = false;
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
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
) -> AppResult<(bool, String, String)> {
    let bin = git_bin()?;
    let mut cmd = Command::new(&bin);
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

    let out_handle = thread::spawn(move || read_capped(stdout, max_bytes));
    let err_handle = thread::spawn(move || read_capped(stderr, max_bytes));

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

pub fn run_git(cwd: &Path, args: &[&str]) -> AppResult<String> {
    let (ok, stdout, stderr) = capture_git(Some(cwd), args, MAX_GIT_OUTPUT_BYTES)?;
    if ok {
        Ok(stdout.trim_end().to_string())
    } else {
        let message = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("git {:?} failed", args)
        };
        Err(AppError::git(message))
    }
}

pub fn run_git_with_stdin(cwd: &Path, args: &[&str], stdin_data: &str) -> AppResult<String> {
    use std::io::Write;

    let bin = git_bin()?;
    let mut child = Command::new(&bin)
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
    let out_handle = thread::spawn(move || read_capped(stdout, MAX_GIT_OUTPUT_BYTES));
    let err_handle = thread::spawn(move || read_capped(stderr, MAX_GIT_OUTPUT_BYTES));

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
        let message = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("git {:?} failed", args)
        };
        Err(AppError::git(message))
    }
}

pub fn run_git_global(args: &[&str]) -> AppResult<String> {
    let (ok, stdout, stderr) = capture_git(None, args, MAX_GIT_OUTPUT_BYTES)?;
    if ok {
        Ok(stdout.trim_end().to_string())
    } else {
        Err(AppError::git(if stderr.trim().is_empty() {
            format!("git {:?} failed", args)
        } else {
            stderr.trim().to_string()
        }))
    }
}

pub fn run_git_allow_fail(cwd: &Path, args: &[&str]) -> (bool, String, String) {
    match capture_git(Some(cwd), args, MAX_GIT_OUTPUT_BYTES) {
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
    let _ = capture_git(None, &args, MAX_GIT_OUTPUT_BYTES)?;
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
