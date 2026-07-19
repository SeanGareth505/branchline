import { parseRemoteRef } from './remote-ref';

const MAINLINE_NAMES = new Set(['main', 'master', 'develop', 'dev', 'release', 'trunk']);

export function branchLeafName(ref: string): string {
  const remote = parseRemoteRef(ref);
  if (remote) return remote.branch;
  return ref.replace(/^refs\/heads\//, '').replace(/^heads\//, '');
}

export function isMainlineBranch(ref: string): boolean {
  const name = branchLeafName(ref).trim().toLowerCase();
  if (!name) return false;
  if (MAINLINE_NAMES.has(name)) return true;
  return name.startsWith('release/');
}
