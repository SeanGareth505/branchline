export const COMMIT_LOG_INITIAL = 200;
export const COMMIT_LOG_WARM = 1000;
export const COMMIT_LOG_MAX = 5000;

export function shouldKeepExistingCommitLog(
  current: { sha: string; refs: string[] }[],
  incoming: { sha: string; refs: string[] }[],
  requestedLimit: number,
): boolean {
  if (incoming.length < requestedLimit) return false;
  if (current.length <= incoming.length) return false;
  for (let i = 0; i < incoming.length; i++) {
    if (current[i].sha !== incoming[i].sha) return false;
    if (current[i].refs.join(',') !== incoming[i].refs.join(',')) return false;
  }
  return true;
}
