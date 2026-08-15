import type { HostRepository } from '../../core/models';

export function parseRemoteWebBase(
  remoteUrl: string,
): { host: string; webBase: string } | null {
  const raw = remoteUrl.trim();
  if (!raw) return null;

  let host = '';
  let path = '';

  const ssh = raw.match(/^git@([^:]+):(.+)$/i);
  if (ssh) {
    host = ssh[1].toLowerCase();
    path = ssh[2];
  } else {
    try {
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
      const url = new URL(withScheme);
      host = url.host.toLowerCase();
      path = url.pathname.replace(/^\/+/, '');
    } catch {
      return null;
    }
  }

  path = path.replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!host || !path) return null;
  return { host, webBase: `https://${host}/${path}` };
}

export function hostRepoWebUrl(repo: HostRepository): string | null {
  const direct = repo.htmlUrl?.trim();
  if (direct) return direct;
  return parseRemoteWebBase(repo.cloneUrl)?.webBase ?? null;
}

export function githubActionsUrl(webBase: string): string | null {
  if (!webBase.includes('github.com')) return null;
  return `${webBase}/actions`;
}

export function normalizeRemoteUrl(url: string): string {
  return url
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function remoteProtocol(url: string): 'ssh' | 'https' | 'other' {
  const raw = url.trim();
  if (/^git@/i.test(raw) || /^ssh:\/\//i.test(raw)) return 'ssh';
  if (/^https?:\/\//i.test(raw)) return 'https';
  return 'other';
}

export function toHttpsRemoteUrl(url: string): string | null {
  const parsed = parseRemoteWebBase(url);
  if (!parsed) return null;
  const path = parsed.webBase.replace(/^https:\/\/[^/]+\//i, '');
  if (!path) return null;
  return `https://${parsed.host}/${path}.git`;
}

export function toSshRemoteUrl(url: string): string | null {
  const parsed = parseRemoteWebBase(url);
  if (!parsed) return null;
  const path = parsed.webBase.replace(/^https:\/\/[^/]+\//i, '');
  if (!path) return null;
  return `git@${parsed.host}:${path}.git`;
}

export function githubOrgFromRemote(url: string): string | null {
  const parsed = parseRemoteWebBase(url);
  if (!parsed || !parsed.host.includes('github.com')) return null;
  const org = parsed.webBase.replace(/^https:\/\/github\.com\//i, '').split('/')[0];
  return org?.trim() || null;
}

export function primaryGithubOwner(remotes: { name: string; fetchUrl: string }[]): string {
  const origin = remotes.find((remote) => remote.name === 'origin');
  const github = remotes.find((remote) => /github\.com/i.test(remote.fetchUrl));
  const url = origin?.fetchUrl || github?.fetchUrl || '';
  return (githubOrgFromRemote(url) || '').toLowerCase();
}

export function githubSsoUrl(url: string): string | null {
  const org = githubOrgFromRemote(url);
  if (!org) return null;
  return `https://github.com/orgs/${org}/sso`;
}

export function githubSshKeysUrl(url: string): string | null {
  const parsed = parseRemoteWebBase(url);
  if (!parsed?.host.includes('github.com')) return null;
  return 'https://github.com/settings/keys';
}

export function remoteRepoSlug(url: string): string | null {
  const parsed = parseRemoteWebBase(url);
  if (!parsed) return null;
  const path = parsed.webBase.replace(/^https:\/\/[^/]+\//i, '');
  return path || null;
}

export function commitWebUrl(remoteUrl: string, sha: string): string | null {
  const parsed = parseRemoteWebBase(remoteUrl);
  const id = sha.trim();
  if (!parsed || !id) return null;
  if (isGitLabHost(parsed.host)) return `${parsed.webBase}/-/commit/${encodeURIComponent(id)}`;
  return `${parsed.webBase}/commit/${encodeURIComponent(id)}`;
}

export function compareWebUrl(remoteUrl: string, from: string, to: string): string | null {
  const parsed = parseRemoteWebBase(remoteUrl);
  const start = from.trim();
  const end = to.trim();
  if (!parsed || !start || !end) return null;
  if (isAzureHost(parsed.host)) return commitWebUrl(remoteUrl, end);
  const range = `${encodeURIComponent(start)}...${encodeURIComponent(end)}`;
  if (isGitLabHost(parsed.host)) return `${parsed.webBase}/-/compare/${range}`;
  return `${parsed.webBase}/compare/${range}`;
}

export function fileWebUrl(remoteUrl: string, sha: string, filePath: string): string | null {
  const parsed = parseRemoteWebBase(remoteUrl);
  const id = sha.trim();
  const file = filePath.replace(/^\/+/, '').trim();
  if (!parsed || !id || !file) return null;
  if (isAzureHost(parsed.host)) {
    return `${parsed.webBase}?path=${encodeURIComponent(file)}&version=GC${encodeURIComponent(id)}`;
  }
  const encoded = file
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  if (isGitLabHost(parsed.host)) {
    return `${parsed.webBase}/-/blob/${encodeURIComponent(id)}/${encoded}`;
  }
  return `${parsed.webBase}/blob/${encodeURIComponent(id)}/${encoded}`;
}

function isGitLabHost(host: string): boolean {
  return host.includes('gitlab');
}

function isAzureHost(host: string): boolean {
  return host.includes('dev.azure.com') || host.includes('visualstudio.com');
}
