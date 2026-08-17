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

export interface BaseUpdateRef {
  ref: string;
  label: string;
}

export function resolveBaseUpdateRef(
  current: string,
  localNames: string[],
  remoteNames: string[],
  preferred: string[] = [],
): BaseUpdateRef | null {
  const currentLeaf = branchLeafName(current).trim();
  if (!currentLeaf || isMainlineBranch(currentLeaf)) return null;

  const locals = new Set(localNames.map((name) => name.trim()).filter(Boolean));
  const remotes = remoteNames.map((name) => name.trim()).filter(Boolean);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const name of [...preferred, 'develop', 'main', 'master', 'trunk']) {
    const leaf = branchLeafName(name).trim();
    if (!leaf) continue;
    const key = leaf.toLowerCase();
    if (seen.has(key) || key === currentLeaf.toLowerCase()) continue;
    seen.add(key);
    candidates.push(leaf);
  }

  for (const leaf of candidates) {
    const remote = remotes.find((name) => branchLeafName(name).toLowerCase() === leaf.toLowerCase());
    if (remote) return { ref: remote, label: leaf };
    const local = [...locals].find((name) => name.toLowerCase() === leaf.toLowerCase());
    if (local) return { ref: local, label: leaf };
  }
  return null;
}
