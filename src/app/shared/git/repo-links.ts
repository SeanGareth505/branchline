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

export function githubSsoUrl(url: string): string | null {
  const org = githubOrgFromRemote(url);
  if (!org) return null;
  return `https://github.com/orgs/${org}/sso`;
}
