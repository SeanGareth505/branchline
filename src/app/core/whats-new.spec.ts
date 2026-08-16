import {
  extractWhatsNewBody,
  githubReleaseTagUrl,
  normalizeAppVersion,
  shouldShowWhatsNew,
} from './whats-new';

describe('whats-new', () => {
  it('normalizes version prefixes', () => {
    expect(normalizeAppVersion('v0.7.40')).toBe('0.7.40');
    expect(normalizeAppVersion(' 0.7.40 ')).toBe('0.7.40');
  });

  it('shows notes after an in-app update restart', () => {
    expect(
      shouldShowWhatsNew({
        currentVersion: '0.7.40',
        lastSeenVersion: '0.7.39',
        pendingVersion: '0.7.40',
      }),
    ).toBe(true);
  });

  it('shows notes when the installed version changed without pending notes', () => {
    expect(
      shouldShowWhatsNew({
        currentVersion: '0.7.40',
        lastSeenVersion: '0.7.38',
        pendingVersion: null,
      }),
    ).toBe(true);
  });

  it('does not show on first launch with no last seen version', () => {
    expect(
      shouldShowWhatsNew({
        currentVersion: '0.7.40',
        lastSeenVersion: null,
        pendingVersion: null,
      }),
    ).toBe(false);
  });

  it('does not show again for the same version', () => {
    expect(
      shouldShowWhatsNew({
        currentVersion: '0.7.40',
        lastSeenVersion: 'v0.7.40',
        pendingVersion: null,
      }),
    ).toBe(false);
  });

  it('ignores stale pending notes from a skipped version', () => {
    expect(
      shouldShowWhatsNew({
        currentVersion: '0.7.41',
        lastSeenVersion: '0.7.41',
        pendingVersion: '0.7.40',
      }),
    ).toBe(false);
  });

  it('strips the install section from GitHub release notes', () => {
    const body = extractWhatsNewBody(
      `## What's Changed\n* Restore ReleasePage.configured\n\n## Install\n\nDrag to Applications`,
    );
    expect(body).toContain("What's Changed");
    expect(body).not.toContain('## Install');
  });

  it('drops the generic placeholder notes', () => {
    expect(
      extractWhatsNewBody(
        "## What's new\n\nChanges since the previous release are listed on this GitHub tag.\n\n## Install\n\nHi",
      ),
    ).toBe('');
  });

  it('builds a GitHub tag URL', () => {
    expect(githubReleaseTagUrl('0.7.40')).toBe(
      'https://github.com/SeanGareth505/branchline/releases/tag/v0.7.40',
    );
  });
});
