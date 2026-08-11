use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(600);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoFsChanged {
    path: String,
    /// Always "meta" — we only watch .git. Worktree refreshes are polled/focus-driven.
    scope: String,
}

struct WatchInner {
    stop: Arc<AtomicBool>,
}

pub struct RepoWatcher {
    inner: Mutex<Option<WatchInner>>,
}

impl RepoWatcher {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    pub fn watch(&self, app: AppHandle, path: PathBuf) {
        self.stop_current();
        let stop = Arc::new(AtomicBool::new(false));
        {
            if let Ok(mut guard) = self.inner.lock() {
                *guard = Some(WatchInner {
                    stop: Arc::clone(&stop),
                });
            }
        }

        let repo_root = path;
        thread::spawn(move || {
            use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};

            let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
            let mut watcher = match RecommendedWatcher::new(
                move |res| {
                    let _ = tx.send(res);
                },
                Config::default(),
            ) {
                Ok(w) => w,
                Err(err) => {
                    log::warn!("repo watcher failed to start: {err}");
                    return;
                }
            };

            let Some(git_dir) = resolve_git_dir(&repo_root) else {
                log::warn!(
                    "repo watcher: could not resolve .git for {}",
                    repo_root.display()
                );
                return;
            };

            if let Err(err) = watcher.watch(&git_dir, RecursiveMode::NonRecursive) {
                log::warn!(
                    "repo watcher could not watch {}: {err}",
                    git_dir.display()
                );
                return;
            }

            let refs_dir = git_dir.join("refs");
            if refs_dir.is_dir() {
                if let Err(err) = watcher.watch(&refs_dir, RecursiveMode::Recursive) {
                    log::warn!(
                        "repo watcher could not watch {}: {err}",
                        refs_dir.display()
                    );
                }
            }

            let mut last_emit = Instant::now()
                .checked_sub(DEBOUNCE)
                .unwrap_or_else(Instant::now);
            let mut pending = false;

            while !stop.load(Ordering::Relaxed) {
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(Ok(event)) => {
                        if should_ignore_git_event(&git_dir, &event.kind, &event.paths) {
                            continue;
                        }
                        pending = true;
                    }
                    Ok(Err(err)) => {
                        log::debug!("repo watcher event error: {err}");
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }

                if pending && last_emit.elapsed() >= DEBOUNCE {
                    pending = false;
                    last_emit = Instant::now();
                    let payload = RepoFsChanged {
                        path: repo_root.to_string_lossy().to_string(),
                        scope: "meta".into(),
                    };
                    let _ = app.emit("repo-fs-changed", payload);
                }
            }
        });
    }

    pub fn stop_current(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(current) = guard.take() {
                current.stop.store(true, Ordering::Relaxed);
            }
        }
    }
}

fn resolve_git_dir(repo_root: &Path) -> Option<PathBuf> {
    let marker = repo_root.join(".git");
    if marker.is_dir() {
        return Some(marker);
    }
    if marker.is_file() {
        let contents = std::fs::read_to_string(&marker).ok()?;
        for line in contents.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("gitdir:") {
                let raw = rest.trim();
                let path = PathBuf::from(raw);
                if path.is_absolute() {
                    return Some(path);
                }
                return Some(repo_root.join(path));
            }
        }
    }
    None
}

fn should_ignore_git_event(git_dir: &Path, kind: &notify::EventKind, paths: &[PathBuf]) -> bool {
    match kind {
        notify::EventKind::Access(_) | notify::EventKind::Other => return true,
        _ => {}
    }
    if paths.is_empty() {
        return false;
    }
    paths.iter().all(|p| should_ignore_git_path(git_dir, p))
}

fn should_ignore_git_path(git_dir: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(git_dir) else {
        return true;
    };
    let mut parts = rel.components().filter_map(|c| match c {
        std::path::Component::Normal(s) => Some(s.to_string_lossy().to_lowercase()),
        _ => None,
    });

    match parts.next().as_deref() {
        None => false,
        Some("index") | Some("head") | Some("packed-refs") | Some("commondir")
        | Some("fetch_head") | Some("orig_head") | Some("merge_head") | Some("rebase_head")
        | Some("cherry_pick_head") | Some("revert_head") | Some("sequencer")
        | Some("rebase-merge") | Some("rebase-apply") | Some("auto_merge") | Some("refs") => false,
        Some("objects") | Some("lfs") | Some("logs") | Some("hooks") | Some("info")
        | Some("modules") | Some("worktrees") | Some("tmp") | Some("filter-repo") => true,
        Some(_) => true,
    }
}
