import type { RepoStatus } from '../../core/models';

export type BranchSyncKind = 'publish' | 'ahead' | 'behind' | 'diverged' | 'synced';

export interface BranchSyncInfo {
  kind: BranchSyncKind;
  label: string | null;
  short: string;
  /** Status text for non-clickable chips */
  statusTooltip: string;
  /** Action text for clickable sync controls */
  tooltip: string;
  icon: 'lucideRefreshCw' | 'lucideCloudUpload';
  upstreamShort: string | null;
}

export function shortUpstream(upstream: string): string {
  const parts = upstream.split('/');
  if (parts.length <= 2) return upstream;
  return parts.slice(1).join('/');
}

export function describeBranchSync(
  status: Pick<RepoStatus, 'branch' | 'upstream' | 'ahead' | 'behind' | 'isDetached'> | null,
  options?: { hasRemotes?: boolean },
): BranchSyncInfo | null {
  if (!status || status.isDetached) return null;

  const hasRemotes = options?.hasRemotes ?? true;
  if (!status.upstream) {
    if (!hasRemotes) return null;
    return {
      kind: 'publish',
      label: null,
      short: 'publish',
      statusTooltip: `Local branch '${status.branch}' is not on a remote yet`,
      tooltip: `Publish branch '${status.branch}' to remote`,
      icon: 'lucideCloudUpload',
      upstreamShort: null,
    };
  }

  const up = shortUpstream(status.upstream);
  const { ahead, behind } = status;

  if (ahead > 0 && behind > 0) {
    return {
      kind: 'diverged',
      label: `${behind}↓ ${ahead}↑`,
      short: `${behind}↓ ${ahead}↑`,
      statusTooltip: `Diverged from ${up} · ${behind} behind, ${ahead} ahead`,
      tooltip: `Diverged from ${up} · ${behind} behind, ${ahead} ahead · Click to pull, then push`,
      icon: 'lucideRefreshCw',
      upstreamShort: up,
    };
  }

  if (ahead > 0) {
    return {
      kind: 'ahead',
      label: `${ahead}↑`,
      short: `${ahead}↑`,
      statusTooltip: `${ahead} commit${ahead === 1 ? '' : 's'} ahead of ${up}`,
      tooltip: `${ahead} commit${ahead === 1 ? '' : 's'} ahead of ${up} · Click to push`,
      icon: 'lucideRefreshCw',
      upstreamShort: up,
    };
  }

  if (behind > 0) {
    return {
      kind: 'behind',
      label: `${behind}↓`,
      short: `${behind}↓`,
      statusTooltip: `${behind} commit${behind === 1 ? '' : 's'} behind ${up}`,
      tooltip: `${behind} commit${behind === 1 ? '' : 's'} behind ${up} · Click to pull`,
      icon: 'lucideRefreshCw',
      upstreamShort: up,
    };
  }

  return {
    kind: 'synced',
    label: null,
    short: 'synced',
    statusTooltip: `In sync with ${up}`,
    tooltip: `In sync with ${up} · Click to sync`,
    icon: 'lucideRefreshCw',
    upstreamShort: up,
  };
}
