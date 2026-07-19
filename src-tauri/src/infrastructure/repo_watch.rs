use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(450);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoFsChanged {
    path: String,
    /// "meta" when .git refs/HEAD/index changed; "worktree" for working-tree files only.
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

        let watch_root = path;
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

            if let Err(err) = watcher.watch(&watch_root, RecursiveMode::Recursive) {
                log::warn!("repo watcher could not watch {}: {err}", watch_root.display());
                return;
            }

            let mut last_emit = Instant::now()
                .checked_sub(DEBOUNCE)
                .unwrap_or_else(Instant::now);
            let mut pending_meta = false;
            let mut pending_worktree = false;

            while !stop.load(Ordering::Relaxed) {
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(Ok(event)) => {
                        if should_ignore_event(&watch_root, &event.kind, &event.paths) {
                            continue;
                        }
                        if event_is_meta(&watch_root, &event.paths) {
                            pending_meta = true;
                        } else {
                            pending_worktree = true;
                        }
                    }
                    Ok(Err(err)) => {
                        log::debug!("repo watcher event error: {err}");
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }

                if (pending_meta || pending_worktree) && last_emit.elapsed() >= DEBOUNCE {
                    let scope = if pending_meta { "meta" } else { "worktree" };
                    pending_meta = false;
                    pending_worktree = false;
                    last_emit = Instant::now();
                    let payload = RepoFsChanged {
                        path: watch_root.to_string_lossy().to_string(),
                        scope: scope.into(),
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

fn should_ignore_event(root: &Path, kind: &notify::EventKind, paths: &[PathBuf]) -> bool {
    match kind {
        notify::EventKind::Access(_) | notify::EventKind::Other => return true,
        _ => {}
    }
    if paths.is_empty() {
        return false;
    }
    paths.iter().all(|p| should_ignore_path(root, p))
}

fn event_is_meta(root: &Path, paths: &[PathBuf]) -> bool {
    if paths.is_empty() {
        return true;
    }
    paths.iter().any(|p| is_meta_path(root, p))
}

fn is_meta_path(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    let mut parts = rel.components().filter_map(|c| match c {
        std::path::Component::Normal(s) => Some(s.to_string_lossy().to_lowercase()),
        _ => None,
    });
    let Some(first) = parts.next() else {
        return false;
    };
    if first != ".git" {
        return false;
    }
    match parts.next().as_deref() {
        Some("index") | Some("head") | Some("refs") | Some("commondir") | Some("packed-refs") => {
            true
        }
        _ => false,
    }
}

fn should_ignore_path(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    let mut parts = rel.components().filter_map(|c| match c {
        std::path::Component::Normal(s) => Some(s.to_string_lossy().to_lowercase()),
        _ => None,
    });

    let Some(first) = parts.next() else {
        return false;
    };

    const NOISE_DIRS: &[&str] = &[
        "node_modules",
        "target",
        "dist",
        "build",
        ".angular",
        ".next",
        ".nuxt",
        ".turbo",
        ".cache",
        "coverage",
        "__pycache__",
        ".venv",
        "venv",
    ];
    if NOISE_DIRS.contains(&first.as_str()) {
        return true;
    }

    if first == ".git" {
        let second = parts.next();
        return match second.as_deref() {
            Some("objects") | Some("lfs") | Some("logs") | Some("hooks") | Some("info") => true,
            Some("index") | Some("head") | Some("refs") | Some("commondir") | Some("packed-refs") => {
                false
            }
            Some(_) => true,
            None => false,
        };
    }

    false
}
