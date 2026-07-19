export function isCheckoutBlockedByLocalChanges(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('would be overwritten by checkout') &&
    (lower.includes('local changes') || lower.includes('untracked'))
  );
}

export function checkoutBlockedNeedsUntracked(message: string): boolean {
  return message.toLowerCase().includes('untracked');
}

export function parseCheckoutBlockedPaths(message: string): string[] {
  const paths: string[] = [];
  let inList = false;
  for (const line of message.split(/\r?\n/)) {
    if (/would be overwritten by checkout/i.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    if (/please (commit|move|remove)/i.test(line) || /^aborting\b/i.test(line.trim())) {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed || /^error:/i.test(trimmed) || /^git error:/i.test(trimmed)) continue;
    paths.push(trimmed);
  }
  return paths;
}

export function summarizeCheckoutBlockedPaths(paths: string[], limit = 4): string {
  if (!paths.length) return '';
  if (paths.length <= limit) return paths.join(', ');
  const shown = paths.slice(0, limit - 1);
  return `${shown.join(', ')}, and ${paths.length - shown.length} more`;
}

/** Paths Git would refuse to overwrite when checking out `target` with local changes kept. */
export function computeCheckoutOverwritePaths(input: {
  changedBetweenHeadAndTarget: string[];
  dirtyTrackedPaths: string[];
  untrackedPaths: string[];
  pathsPresentInTarget: string[];
}): { files: string[]; includeUntracked: boolean } {
  const changed = new Set(input.changedBetweenHeadAndTarget.map(normalizePath));
  const inTarget = new Set(input.pathsPresentInTarget.map(normalizePath));
  const files: string[] = [];
  const seen = new Set<string>();

  for (const path of input.dirtyTrackedPaths) {
    const p = normalizePath(path);
    if (!p || seen.has(p) || !changed.has(p)) continue;
    seen.add(p);
    files.push(p);
  }

  let includeUntracked = false;
  for (const path of input.untrackedPaths) {
    const p = normalizePath(path);
    if (!p || seen.has(p) || !inTarget.has(p)) continue;
    seen.add(p);
    files.push(p);
    includeUntracked = true;
  }

  files.sort((a, b) => a.localeCompare(b));
  return { files, includeUntracked };
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/');
}
