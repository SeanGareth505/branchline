import {
  COMMIT_LOG_INITIAL,
  shouldKeepExistingCommitLog,
} from './commit-log-window';

describe('shouldKeepExistingCommitLog', () => {
  const sha = (n: number, refs: string[] = []) => ({ sha: `c${n}`, refs });

  it('keeps a longer list when a full first window matches the prefix', () => {
    const current = [sha(1, ['HEAD']), sha(2), sha(3)];
    const incoming = [sha(1, ['HEAD']), sha(2)];
    expect(shouldKeepExistingCommitLog(current, incoming, COMMIT_LOG_INITIAL)).toBe(false);
    expect(shouldKeepExistingCommitLog(current, incoming, 2)).toBe(true);
  });

  it('replaces when git returned a complete shorter history', () => {
    const current = [sha(1), sha(2), sha(3)];
    const incoming = [sha(1), sha(2)];
    expect(shouldKeepExistingCommitLog(current, incoming, 200)).toBe(false);
  });

  it('replaces when the prefix no longer matches', () => {
    const current = [sha(1), sha(2), sha(3)];
    const incoming = [sha(9), sha(2)];
    expect(shouldKeepExistingCommitLog(current, incoming, 2)).toBe(false);
  });
});
