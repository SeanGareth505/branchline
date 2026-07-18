use crate::infrastructure::sqlite::{self, Db};
use crate::AppResult;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct AppState {
    pub db: Mutex<Db>,
    pub current_repo: Mutex<Option<PathBuf>>,
}

impl AppState {
    pub fn new() -> AppResult<Self> {
        let db = sqlite::open_and_migrate()?;
        Ok(Self {
            db: Mutex::new(db),
            current_repo: Mutex::new(None),
        })
    }

    pub fn set_current_repo(&self, path: Option<PathBuf>) {
        if let Ok(mut guard) = self.current_repo.lock() {
            *guard = path;
        }
    }
}
