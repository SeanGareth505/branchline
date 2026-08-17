import {
  alreadyUpToDateLabel,
  isAlreadyUpToDateMessage,
  summarizeGitToastMessage,
} from './git-toast';

describe('summarizeGitToastMessage', () => {
  it('keeps short messages', () => {
    expect(summarizeGitToastMessage('Pulled from origin')).toBe('Pulled from origin');
    expect(summarizeGitToastMessage('Already up to date.')).toBe('Already up to date.');
  });

  it('summarizes hyphenated already-up-to-date lines', () => {
    expect(summarizeGitToastMessage('Already up-to-date.')).toBe('Already up-to-date.');
  });

  it('summarizes a fast-forward pull with a files-changed footer', () => {
    const raw = [
      'Updating a1b2c3d..b2c3d4e',
      'Fast-forward',
      ' src/app.ts | 12 ++++++------',
      ' 87 files changed, 1200 insertions(+), 40 deletions(-)',
      ' create mode 100644 src/a.ts',
      ' create mode 100644 src/b.ts',
    ].join('\n');
    expect(summarizeGitToastMessage(raw)).toBe(
      'Fast-forward · 87 files changed, 1200 insertions(+), 40 deletions(-)',
    );
  });

  it('counts create/delete mode lines when git omits a files-changed footer', () => {
    const raw = [
      'js-storefront/src/app/shared/widgets/dc-calendar/dc-calendar.ts create mode 100644',
      'js-storefront/src/app/shared/widgets/dc-chips/dc-chips.ts create mode 100644',
      'js-storefront/tsconfig.server.json delete mode 100644',
    ].join('\n');
    expect(summarizeGitToastMessage(raw)).toBe('Updated · 2 added, 1 deleted');
  });

  it('falls back to the first line plus a count for other long output', () => {
    const extra = Array.from({ length: 12 }, (_, i) => ` * [new branch]      feature/${i} -> origin/feature/${i}`);
    const raw = ['From github.com:org/repo', ...extra].join('\n');
    expect(summarizeGitToastMessage(raw)).toBe('From github.com:org/repo · 12 more lines');
  });
});

describe('already up to date helpers', () => {
  it('detects git already-up-to-date wording', () => {
    expect(isAlreadyUpToDateMessage('Already up to date.')).toBe(true);
    expect(isAlreadyUpToDateMessage('Already up-to-date')).toBe(true);
    expect(isAlreadyUpToDateMessage('Current branch feature/foo is up to date.')).toBe(true);
    expect(isAlreadyUpToDateMessage('Fast-forward')).toBe(false);
  });

  it('names the source branch in the toast', () => {
    expect(alreadyUpToDateLabel('origin/main')).toBe('Already up to date with origin/main');
    expect(alreadyUpToDateLabel('')).toBe('Already up to date');
  });
});
