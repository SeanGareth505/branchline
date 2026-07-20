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
