export function rawErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err.trim();
  if (err instanceof Error) return err.message.trim();
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message).trim();
  }
  return String(err ?? '').trim();
}

export function extractRemoteUrlFromGitError(message: string): string | null {
  const quoted = message.match(
    /repository ['"]([^'"]+)['"](?:\.git)?(?:\/)?['"]?\s+not found/i,
  );
  if (quoted?.[1]) return quoted[1].trim();

  const repoLine = message.match(
    /(?:fatal:\s+)?repository ['"]([^'"]+)['"]/i,
  );
  if (repoLine?.[1] && /not found/i.test(message)) return repoLine[1].trim();

  const unable = message.match(/unable to access ['"]([^'"]+)['"]/i);
  if (unable?.[1]) return unable[1].trim();

  const couldNot = message.match(/could not read from ['"]([^'"]+)['"]/i);
  if (couldNot?.[1]) return couldNot[1].trim();

  return null;
}

export function isRemoteAccessError(message: string): boolean {
  const m = message.trim();
  if (!m) return false;
  if (/command not found|executable not found|path not found/i.test(m)) return false;
  return (
    /repository not found/i.test(m) ||
    /could not read from remote repository/i.test(m) ||
    /permission denied \(publickey\)/i.test(m) ||
    /authentication failed/i.test(m) ||
    /the requested url returned error:\s*40[13]/i.test(m) ||
    /fatal: unable to access/i.test(m) ||
    /could not access repository/i.test(m)
  );
}

export function humanizeGitError(message: string): string {
  const m = message.trim();
  if (!m) return 'Something went wrong';

  if (/failed to fetch|networkerror|net::err_|econnrefused|enotfound|timed out|timeout/i.test(m)) {
    return 'Network unavailable — Branchline will keep working with local Git. Try again when you are online.';
  }
  if (/403|401|unauthorized|bad credentials/i.test(m) && !isRemoteAccessError(m)) {
    return `${m} — check your GitHub or host connection in Settings.`;
  }

  if (/repository not found/i.test(m)) {
    const url = extractRemoteUrlFromGitError(m);
    const target = url ? ` ${url}` : ' the remote';
    return `Git said${target} was not found. If you can open that repo in a browser, this is usually an SSH key, Git credentials, or org SSO — GitHub hides private repos as “not found”.`;
  }

  if (/permission denied \(publickey\)/i.test(m)) {
    return 'SSH rejected this key. Add your public key on the host, or switch the remote to HTTPS.';
  }

  if (/could not read from remote repository/i.test(m)) {
    return 'Could not read the remote. Check the URL, SSH keys, and that your account can access this repository.';
  }

  if (/authentication failed/i.test(m)) {
    return 'Git authentication failed. Update credentials in the helper, or switch the remote to SSH.';
  }

  return m;
}
