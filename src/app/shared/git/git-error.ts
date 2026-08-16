import { remoteProtocol } from './repo-links';

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

function inferredProtocol(message: string): 'ssh' | 'https' | 'other' {
  const url = extractRemoteUrlFromGitError(message);
  if (url) return remoteProtocol(url);
  if (
    /permission denied \(publickey\)/i.test(message) ||
    /could not read from remote repository/i.test(message) ||
    /^ERROR:\s*repository not found/im.test(message)
  ) {
    return 'ssh';
  }
  if (/unable to access ['"]https?:\/\//i.test(message) || /https:\/\/github\.com/i.test(message)) {
    return 'https';
  }
  return 'other';
}

export function humanizeGitError(message: string): string {
  const m = message.replace(/^(Git error:\s*)+/i, '').trim();
  if (!m) return 'Something went wrong';
  if (/^A Git hook /i.test(m)) return m;

  if (
    /npm: command not found|npx: command not found|node: command not found|npm is not recognized|npx is not recognized|node is not recognized/i.test(
      m,
    ) ||
    (/husky/i.test(m) && /code 127/i.test(m))
  ) {
    return 'A Git hook could not find Node.js (npm). Restart Branchline so it can see Homebrew or nvm, then retry.';
  }

  if (/husky - .+ script failed/i.test(m) || /hook declined to/i.test(m)) {
    return 'A Git hook blocked this commit. Fix the failing check, then retry.';
  }

  if (/failed to fetch|networkerror|net::err_|econnrefused|enotfound|timed out|timeout/i.test(m)) {
    return 'Network unavailable — Branchline will keep working with local Git. Try again when you are online.';
  }

  if (/ssl certificate problem|certificate verify failed/i.test(m)) {
    return 'HTTPS rejected the server certificate. Check the remote URL, or switch this repo to SSH.';
  }

  if (/host key verification failed/i.test(m)) {
    return 'SSH does not trust this host yet. Connect once in Terminal, or switch this repo to HTTPS.';
  }

  if (/index\.lock|unable to create '.*\.lock'/i.test(m)) {
    return 'Git is locked by another process. Wait for it to finish, then try again.';
  }

  if (/your local changes to the following files would be overwritten/i.test(m)) {
    return 'Local changes would be overwritten. Commit or stash them, then retry.';
  }

  if (/please commit your changes or stash them/i.test(m)) {
    return 'Uncommitted changes are blocking this. Commit or stash, then retry.';
  }

  if (/\bCONFLICT\b|fix conflicts and then|unmerged paths/i.test(m)) {
    return 'This stopped on merge conflicts. Resolve them in Changes, then continue.';
  }

  if (/failed to push some refs|non-fast-forward|fetch first|updates were rejected/i.test(m)) {
    return 'Push was rejected because the remote has commits you do not. Pull first, or force-push with lease if you meant to overwrite.';
  }

  if (/403|401|unauthorized|bad credentials|invalid username or token/i.test(m) && !isRemoteAccessError(m)) {
    return `${m} — check your GitHub or host connection in Settings.`;
  }

  if (/repository not found/i.test(m)) {
    const protocol = inferredProtocol(m);
    if (protocol === 'https') {
      return 'GitHub hid this private HTTPS repo as “not found”. Git used a saved login (often GitHub CLI) and did not ask for a password. Switch the HTTPS account in Remotes to the user that can open this repo in the browser.';
    }
    if (protocol === 'ssh') {
      return 'SSH reached GitHub, but this repo was hidden. This org may block SSH. Switch this repo to HTTPS in Remotes, then pick the GitHub CLI account that can open it in the browser.';
    }
    return 'GitHub hid this private repo as “not found”. In Remotes, pick the GitHub account that can open it in the browser, and switch the repo to HTTPS if SSH keeps failing.';
  }

  if (/permission denied \(publickey\)/i.test(m)) {
    return 'SSH rejected this key. Switch this repo to HTTPS in Remotes, or add the matching public key on GitHub.';
  }

  if (/authentication failed|invalid username or token|bad credentials|the requested url returned error:\s*40[13]/i.test(m)) {
    return 'Git rejected this login. Switch the HTTPS account in Remotes, or update the saved GitHub CLI token.';
  }

  if (/could not read from remote repository/i.test(m)) {
    return 'Could not read the remote. In Remotes, confirm the URL, then switch GitHub account or HTTPS/SSH.';
  }

  if (/fatal: unable to access/i.test(m)) {
    return 'Git could not reach that URL. Check the remote, then switch this repo to HTTPS or SSH in Remotes.';
  }

  return m;
}
