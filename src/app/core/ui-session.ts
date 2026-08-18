import type { UiSession } from './models';

export function sessionRepoPaths(session: UiSession | undefined): string[] {
  return (session?.openRepoPaths ?? []).filter(
    (path): path is string => typeof path === 'string' && !!path.trim(),
  );
}

export function mergeUiSession(base: UiSession, overlay: UiSession): UiSession {
  const merged: UiSession = { ...base, ...overlay };
  const overlayPaths = sessionRepoPaths(overlay);
  const basePaths = sessionRepoPaths(base);
  if (!overlayPaths.length && basePaths.length) {
    merged.openRepoPaths = [...basePaths];
    const active = typeof merged.activeRepoPath === 'string' ? merged.activeRepoPath.trim() : '';
    if (!active) merged.activeRepoPath = base.activeRepoPath ?? null;
    merged.activeRepoPathByAccount = {
      ...(base.activeRepoPathByAccount ?? {}),
      ...(overlay.activeRepoPathByAccount ?? {}),
    };
    if (!Object.keys(merged.repoWebUrls ?? {}).length && Object.keys(base.repoWebUrls ?? {}).length) {
      merged.repoWebUrls = { ...(base.repoWebUrls ?? {}) };
    }
  }
  return merged;
}
