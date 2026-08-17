import { remoteRepoSlug } from './repo-links';

export const ALL_REPO_ACCOUNTS = '*';

export interface RepoAccountOption {
  key: string;
  label: string;
  cli: boolean;
  active: boolean;
}

export function hostOwnerFromSlug(fullName: string): string {
  const slug = fullName.trim().replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!slug) return '';
  const idx = slug.lastIndexOf('/');
  return idx > 0 ? slug.slice(0, idx) : slug;
}

export function hostOwnerFromWebUrl(url: string): string {
  return hostOwnerFromSlug(remoteRepoSlug(url) || '');
}

export function repoAccountKeyForOwner(
  owner: string,
  accounts: RepoAccountOption[],
  mappings: Record<string, { login: string }>,
): string | null {
  const o = owner.trim().toLowerCase();
  if (!o) return null;
  const mapped = mappings[o]?.login.trim().toLowerCase() ?? '';
  if (mapped && accounts.some((account) => account.key === mapped)) return mapped;
  if (accounts.some((account) => account.key === o)) return o;
  return null;
}

export function repoAccountMatchesOwner(
  accountKey: string,
  owner: string,
  mappings: Record<string, { login: string }>,
  apiUsername = '',
): boolean {
  const account = accountKey.trim().toLowerCase();
  if (!account || account === ALL_REPO_ACCOUNTS) return true;
  const o = owner.trim().toLowerCase();
  if (!o) return true;
  if (o === account) return true;
  const mapped = mappings[o]?.login.trim().toLowerCase() ?? '';
  if (mapped === account) return true;
  if (mapped) return false;
  const api = apiUsername.trim().toLowerCase();
  return !!api && api === account;
}

export function collectWorkspaceAccounts(input: {
  cliAccounts: { login: string; active: boolean }[];
  connectionUsernames: string[];
  owners: string[];
}): RepoAccountOption[] {
  const all = collectRepoAccounts(input);
  const named = new Set(
    [...input.cliAccounts.map((account) => account.login), ...input.connectionUsernames]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const primary = all.filter((account) => named.has(account.key));
  return primary.length ? primary : all;
}

export function collectRepoAccounts(input: {
  cliAccounts: { login: string; active: boolean }[];
  connectionUsernames: string[];
  owners: string[];
}): RepoAccountOption[] {
  const map = new Map<string, RepoAccountOption>();
  const add = (label: string, patch?: Partial<Pick<RepoAccountOption, 'cli' | 'active'>>): void => {
    const trimmed = label.trim();
    const key = trimmed.toLowerCase();
    if (!key) return;
    const prev = map.get(key);
    map.set(key, {
      key,
      label: prev?.label || trimmed,
      cli: !!(prev?.cli || patch?.cli),
      active: !!(prev?.active || patch?.active),
    });
  };
  for (const account of input.cliAccounts) {
    add(account.login, { cli: true, active: account.active });
  }
  for (const username of input.connectionUsernames) add(username);
  for (const owner of input.owners) add(owner);
  return [...map.values()].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.cli !== b.cli) return a.cli ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

export function resolveSelectedRepoAccount(
  saved: string,
  accounts: RepoAccountOption[],
  fallbacks: string[],
): string {
  const value = saved.trim().toLowerCase();
  if (value === ALL_REPO_ACCOUNTS) return ALL_REPO_ACCOUNTS;
  if (value && accounts.some((account) => account.key === value)) return value;
  for (const fallback of fallbacks) {
    const key = fallback.trim().toLowerCase();
    if (key && accounts.some((account) => account.key === key)) return key;
  }
  return accounts[0]?.key ?? ALL_REPO_ACCOUNTS;
}
