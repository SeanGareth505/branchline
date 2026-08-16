import { ChangelogService } from './changelog.service';
import type { CommitInfo, TagInfo } from '../../core/models';

function commit(partial: Partial<CommitInfo> & Pick<CommitInfo, 'sha' | 'subject'>): CommitInfo {
  return {
    shortSha: partial.sha.slice(0, 7),
    message: partial.subject,
    author: 'Sean',
    email: 'sean@example.com',
    timestamp: 1,
    parents: [],
    refs: [],
    laneHint: 0,
    isRelativeToHead: true,
    ...partial,
  };
}

describe('ChangelogService github release notes', () => {
  const changelog = new ChangelogService();

  it('picks the tag before the current release', () => {
    const commits: CommitInfo[] = [
      commit({ sha: 'aaa1111', subject: 'feat: newest' }),
      commit({ sha: 'bbb2222', subject: 'fix: older' }),
      commit({ sha: 'ccc3333', subject: 'chore: oldest' }),
    ];
    const tags: TagInfo[] = [
      { name: 'v0.2.0', sha: 'aaa1111', shortSha: 'aaa1111' },
      { name: 'v0.1.0', sha: 'ccc3333', shortSha: 'ccc3333' },
    ];
    expect(changelog.previousReleaseTag(tags, commits, 'v0.2.0')?.name).toBe('v0.1.0');
    expect(changelog.previousReleaseTag(tags, commits, 'v0.3.0')?.name).toBe('v0.2.0');
    expect(changelog.previousReleaseTag(tags, commits, null)?.name).toBe('v0.2.0');
  });

  it('builds GitHub-style notes from conventional commits', () => {
    const commits: CommitInfo[] = [
      commit({ sha: 'deadbeef123', subject: 'feat: add notes editor' }),
      commit({ sha: 'cafebabe456', subject: 'fix: crash on save' }),
      commit({ sha: 'merge000111', subject: 'Merge branch main' }),
      commit({ sha: 'chore999000', subject: 'chore: bump version' }),
    ];
    const body = changelog.githubReleaseBody(commits, '0.8.0', 'v0.7.15', 'v0.8.0');
    expect(body).toContain("## What's new in 0.8.0");
    expect(body).toContain('### Added');
    expect(body).toContain('Add notes editor — Sean');
    expect(body).toContain('### Fixed');
    expect(body).toContain('Crash on save — Sean');
    expect(body).toContain('**Full changelog:** `v0.7.15` → `v0.8.0`');
    expect(body).not.toContain('Merge branch main');
    expect(body).not.toContain('bump version');
    expect(body).not.toContain('## [0.8.0]');
  });
});
