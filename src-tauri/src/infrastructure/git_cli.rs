use crate::{AppError, AppResult};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

pub fn git_bin() -> AppResult<String> {
    which::which("git")
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|_| AppError::msg("Git executable not found on PATH"))
}

pub fn run_git(cwd: &Path, args: &[&str]) -> AppResult<String> {
    let bin = git_bin()?;
    let output = Command::new(&bin)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| AppError::git(format!("Failed to run git: {e}")))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim_end().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let message = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("git {:?} failed", args)
        };
        Err(AppError::git(message))
    }
}

pub fn run_git_with_stdin(cwd: &Path, args: &[&str], stdin_data: &str) -> AppResult<String> {
    use std::io::Write;
    use std::process::Stdio;

    let bin = git_bin()?;
    let mut child = Command::new(&bin)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::git(format!("Failed to spawn git: {e}")))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(stdin_data.as_bytes())
            .map_err(|e| AppError::git(format!("Failed to write patch to git: {e}")))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| AppError::git(format!("Failed to run git: {e}")))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim_end().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let message = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("git {:?} failed", args)
        };
        Err(AppError::git(message))
    }
}

pub fn run_git_global(args: &[&str]) -> AppResult<String> {
    let bin = git_bin()?;
    let output = Command::new(&bin)
        .args(args)
        .output()
        .map_err(|e| AppError::git(format!("Failed to run git: {e}")))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim_end().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(AppError::git(if stderr.is_empty() {
            format!("git {:?} failed", args)
        } else {
            stderr
        }))
    }
}

pub fn run_git_allow_fail(cwd: &Path, args: &[&str]) -> (bool, String, String) {
    let Ok(bin) = git_bin() else {
        return (false, String::new(), "Git not found".into());
    };
    match Command::new(&bin).args(args).current_dir(cwd).output() {
        Ok(output) => (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).to_string(),
            String::from_utf8_lossy(&output.stderr).to_string(),
        ),
        Err(e) => (false, String::new(), e.to_string()),
    }
}

pub fn version() -> AppResult<String> {
    let out = run_git_global(&["--version"])?;
    Ok(out)
}

pub fn config_get(key: &str) -> AppResult<Option<String>> {
    let bin = git_bin()?;
    let output = Command::new(&bin)
        .args(["config", "--global", "--get", key])
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

pub fn config_set(key: &str, value: &str) -> AppResult<()> {
    run_git_global(&["config", "--global", key, value])?;
    Ok(())
}

pub fn ensure_repo(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::msg(format!("Path does not exist: {}", path.display())));
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
                    return Err(AppError::msg(format!(
                        "Invalid pathspec: {p}"
                    )));
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
