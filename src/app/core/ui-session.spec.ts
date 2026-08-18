import { mergeUiSession, sessionRepoPaths } from './ui-session';

describe('ui session', () => {
  it('keeps saved open repos when a later write has an empty tab list', () => {
    const merged = mergeUiSession(
      {
        openRepoPaths: ['/Users/me/branchline', '/Users/me/other'],
        activeRepoPath: '/Users/me/branchline',
        repoWebUrls: { '/Users/me/branchline': 'https://github.com/me/branchline' },
      },
      {
        openRepoPaths: [],
        activeRepoPath: null,
        repoWebUrls: {},
        view: 'settings',
      },
    );
    expect(sessionRepoPaths(merged)).toEqual(['/Users/me/branchline', '/Users/me/other']);
    expect(merged.activeRepoPath).toBe('/Users/me/branchline');
    expect(merged.view).toBe('settings');
    expect(merged.repoWebUrls?.['/Users/me/branchline']).toBe('https://github.com/me/branchline');
  });

  it('keeps a newer non-empty tab list', () => {
    const merged = mergeUiSession(
      { openRepoPaths: ['/Users/me/branchline'] },
      { openRepoPaths: ['/Users/me/other'] },
    );
    expect(sessionRepoPaths(merged)).toEqual(['/Users/me/other']);
  });
});
