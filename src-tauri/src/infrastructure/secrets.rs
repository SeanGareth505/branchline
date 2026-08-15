use keyring::Entry;

const SERVICE: &str = "app.branchline.git";

fn account(connection_id: &str) -> String {
    format!("connection:{connection_id}")
}

fn entry_for(connection_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &account(connection_id)).map_err(|e| e.to_string())
}

fn is_missing(err: &keyring::Error) -> bool {
    matches!(err, keyring::Error::NoEntry)
        || {
            let msg = err.to_string().to_lowercase();
            msg.contains("no entry")
                || msg.contains("not found")
                || msg.contains("no password")
                || msg.contains("item not found")
        }
}

pub fn get_connection_token(connection_id: &str) -> Result<Option<String>, String> {
    let id = connection_id.trim();
    if id.is_empty() {
        return Ok(None);
    }
    let entry = entry_for(id)?;
    match entry.get_password() {
        Ok(password) => {
            let trimmed = password.trim().to_string();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed))
            }
        }
        Err(err) if is_missing(&err) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

pub fn set_connection_token(connection_id: &str, token: &str) -> Result<(), String> {
    let id = connection_id.trim();
    let token = token.trim();
    if id.is_empty() {
        return Err("Connection id is required".into());
    }
    if token.is_empty() {
        return delete_connection_token(id);
    }
    let entry = entry_for(id)?;
    entry.set_password(token).map_err(|e| e.to_string())
}

pub fn delete_connection_token(connection_id: &str) -> Result<(), String> {
    let id = connection_id.trim();
    if id.is_empty() {
        return Ok(());
    }
    let entry = match entry_for(id) {
        Ok(entry) => entry,
        Err(_) => return Ok(()),
    };
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(err) if is_missing(&err) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}
