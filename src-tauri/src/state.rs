use crate::infrastructure::repo_watch::RepoWatcher;
use crate::infrastructure::sqlite::{self, Db};
use crate::AppResult;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct AppState {
    pub db: Mutex<Db>,
    pub current_repo: Mutex<Option<PathBuf>>,
    pub repo_watcher: RepoWatcher,
}

impl AppState {
    pub fn new() -> AppResult<Self> {
        let db = sqlite::open_and_migrate()?;
        Ok(Self {
            db: Mutex::new(db),
            current_repo: Mutex::new(None),
            repo_watcher: RepoWatcher::new(),
        })
    }

    pub fn set_current_repo(&self, path: Option<PathBuf>) {
        if let Ok(mut guard) = self.current_repo.lock() {
            *guard = path;
        }
    }
}
