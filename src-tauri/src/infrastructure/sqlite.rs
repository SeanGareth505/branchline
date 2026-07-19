use crate::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub type Db = Connection;

pub fn app_data_dir() -> AppResult<PathBuf> {
    let base =
        dirs::data_dir().ok_or_else(|| AppError::msg("Could not resolve app data directory"))?;
    let dir = base.join("branchline");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn open_and_migrate() -> AppResult<Db> {
    let dir = app_data_dir()?;
    let path = dir.join("branchline.db");
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS recent_repos (
            path TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            last_opened_at TEXT NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0,
            is_last INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS onboarding (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            completed INTEGER NOT NULL DEFAULT 0,
            skipped INTEGER NOT NULL DEFAULT 0,
            checklist_json TEXT NOT NULL DEFAULT '{}'
        );
        INSERT OR IGNORE INTO onboarding (id, completed, skipped, checklist_json)
            VALUES (1, 0, 0, '{}');
        CREATE TABLE IF NOT EXISTS undo_journal (
            id TEXT PRIMARY KEY NOT NULL,
            repo_path TEXT NOT NULL,
            action TEXT NOT NULL,
            label TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            restored INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS layouts (
            key TEXT PRIMARY KEY NOT NULL,
            layout_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS branch_locks (
            repo_path TEXT NOT NULL,
            branch_name TEXT NOT NULL,
            reason TEXT,
            locked_at TEXT NOT NULL,
            PRIMARY KEY (repo_path, branch_name)
        );
        ",
    )?;
    Ok(conn)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchLockRow {
    pub repo_path: String,
    pub branch_name: String,
    pub reason: Option<String>,
    pub locked_at: String,
}

pub fn list_branch_locks(conn: &Connection, repo_path: &str) -> AppResult<Vec<BranchLockRow>> {
    let mut stmt = conn.prepare(
        "SELECT repo_path, branch_name, reason, locked_at
         FROM branch_locks
         WHERE repo_path = ?1
         ORDER BY branch_name ASC",
    )?;
    let rows = stmt
        .query_map(params![repo_path], |row| {
            Ok(BranchLockRow {
                repo_path: row.get(0)?,
                branch_name: row.get(1)?,
                reason: row.get(2)?,
                locked_at: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get_branch_lock(
    conn: &Connection,
    repo_path: &str,
    branch_name: &str,
) -> AppResult<Option<BranchLockRow>> {
    let mut stmt = conn.prepare(
        "SELECT repo_path, branch_name, reason, locked_at
         FROM branch_locks
         WHERE repo_path = ?1 AND branch_name = ?2",
    )?;
    let mut rows = stmt.query(params![repo_path, branch_name])?;
    if let Some(row) = rows.next()? {
        Ok(Some(BranchLockRow {
            repo_path: row.get(0)?,
            branch_name: row.get(1)?,
            reason: row.get(2)?,
            locked_at: row.get(3)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn is_branch_locked(conn: &Connection, repo_path: &str, branch_name: &str) -> AppResult<bool> {
    Ok(get_branch_lock(conn, repo_path, branch_name)?.is_some())
}

pub fn lock_branch(
    conn: &Connection,
    repo_path: &str,
    branch_name: &str,
    reason: Option<&str>,
    locked_at: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO branch_locks (repo_path, branch_name, reason, locked_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(repo_path, branch_name) DO UPDATE SET
           reason = excluded.reason,
           locked_at = excluded.locked_at",
        params![repo_path, branch_name, reason, locked_at],
    )?;
    Ok(())
}

pub fn unlock_branch(conn: &Connection, repo_path: &str, branch_name: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM branch_locks WHERE repo_path = ?1 AND branch_name = ?2",
        params![repo_path, branch_name],
    )?;
    Ok(())
}

pub fn lock_block_message(branch_name: &str, reason: Option<&str>) -> String {
    match reason.filter(|r| !r.trim().is_empty()) {
        Some(reason) => format!("Branch '{branch_name}' is locked: {reason}"),
        None => format!(
            "Branch '{branch_name}' is locked. Unlock it before pushing, force-pushing, renaming, or deleting."
        ),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRepoRow {
    pub path: String,
    pub name: String,
    pub last_opened_at: String,
    pub pinned: bool,
    pub is_last: bool,
}

pub fn list_recent_repos(conn: &Connection) -> AppResult<Vec<RecentRepoRow>> {
    let mut stmt = conn.prepare(
        "SELECT path, name, last_opened_at, pinned, is_last
         FROM recent_repos
         ORDER BY pinned DESC, last_opened_at DESC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(RecentRepoRow {
                path: row.get(0)?,
                name: row.get(1)?,
                last_opened_at: row.get(2)?,
                pinned: row.get::<_, i64>(3)? != 0,
                is_last: row.get::<_, i64>(4)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn upsert_recent_repo(
    conn: &Connection,
    path: &str,
    name: &str,
    opened_at: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO recent_repos (path, name, last_opened_at, pinned, is_last)
         VALUES (?1, ?2, ?3, 0, 0)
         ON CONFLICT(path) DO UPDATE SET
           name = excluded.name,
           last_opened_at = excluded.last_opened_at",
        params![path, name, opened_at],
    )?;
    Ok(())
}

pub fn remove_recent_repo(conn: &Connection, path: &str) -> AppResult<()> {
    conn.execute("DELETE FROM recent_repos WHERE path = ?1", params![path])?;
    Ok(())
}

pub fn pin_repo(conn: &Connection, path: &str, pinned: bool) -> AppResult<()> {
    conn.execute(
        "UPDATE recent_repos SET pinned = ?1 WHERE path = ?2",
        params![if pinned { 1 } else { 0 }, path],
    )?;
    Ok(())
}

pub fn set_last_repo(conn: &Connection, path: &str) -> AppResult<()> {
    conn.execute("UPDATE recent_repos SET is_last = 0", [])?;
    conn.execute(
        "UPDATE recent_repos SET is_last = 1 WHERE path = ?1",
        params![path],
    )?;
    Ok(())
}

pub fn get_setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingState {
    pub completed: bool,
    pub skipped: bool,
    pub checklist_json: String,
}

pub fn get_onboarding(conn: &Connection) -> AppResult<OnboardingState> {
    conn.query_row(
        "SELECT completed, skipped, checklist_json FROM onboarding WHERE id = 1",
        [],
        |row| {
            Ok(OnboardingState {
                completed: row.get::<_, i64>(0)? != 0,
                skipped: row.get::<_, i64>(1)? != 0,
                checklist_json: row.get(2)?,
            })
        },
    )
    .map_err(AppError::from)
}

pub fn set_onboarding_complete(conn: &Connection, completed: bool, skipped: bool) -> AppResult<()> {
    conn.execute(
        "UPDATE onboarding SET completed = ?1, skipped = ?2 WHERE id = 1",
        params![if completed { 1 } else { 0 }, if skipped { 1 } else { 0 }],
    )?;
    Ok(())
}

pub fn set_onboarding_checklist(conn: &Connection, checklist_json: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE onboarding SET checklist_json = ?1 WHERE id = 1",
        params![checklist_json],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoJournalRow {
    pub id: String,
    pub repo_path: String,
    pub action: String,
    pub label: String,
    pub payload_json: String,
    pub created_at: String,
    pub restored: bool,
}

pub fn insert_undo_entry(conn: &Connection, entry: &UndoJournalRow) -> AppResult<()> {
    conn.execute(
        "INSERT INTO undo_journal (id, repo_path, action, label, payload_json, created_at, restored)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            entry.id,
            entry.repo_path,
            entry.action,
            entry.label,
            entry.payload_json,
            entry.created_at,
            if entry.restored { 1 } else { 0 }
        ],
    )?;
    Ok(())
}

pub fn list_undo_entries(
    conn: &Connection,
    repo_path: Option<&str>,
    limit: i64,
) -> AppResult<Vec<UndoJournalRow>> {
    if let Some(path) = repo_path {
        let mut stmt = conn.prepare(
            "SELECT id, repo_path, action, label, payload_json, created_at, restored
             FROM undo_journal WHERE repo_path = ?1
             ORDER BY created_at DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![path, limit], map_undo_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, repo_path, action, label, payload_json, created_at, restored
             FROM undo_journal
             ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit], map_undo_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

fn map_undo_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<UndoJournalRow> {
    Ok(UndoJournalRow {
        id: row.get(0)?,
        repo_path: row.get(1)?,
        action: row.get(2)?,
        label: row.get(3)?,
        payload_json: row.get(4)?,
        created_at: row.get(5)?,
        restored: row.get::<_, i64>(6)? != 0,
    })
}

pub fn mark_undo_restored(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE undo_journal SET restored = 1 WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn latest_undo_entry(conn: &Connection, repo_path: &str) -> AppResult<Option<UndoJournalRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, repo_path, action, label, payload_json, created_at, restored
         FROM undo_journal
         WHERE repo_path = ?1 AND restored = 0
         ORDER BY created_at DESC LIMIT 1",
    )?;
    let mut rows = stmt.query(params![repo_path])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_undo_row(row)?))
    } else {
        Ok(None)
    }
}
