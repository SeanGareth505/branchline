import { DEFAULT_COMMIT_TYPES, formatConventionalHead, lintConventionalMessage, parseConventionalSubject, suggestCommitType } from './commit-types';

describe('conventional commit subject', () => {
  it('parses type, scope, breaking marker, and summary', () => {
    expect(parseConventionalSubject('feat(api)!: add login', DEFAULT_COMMIT_TYPES)).toEqual({
      type: 'feat',
      scope: 'api',
      breaking: true,
      summary: 'add login',
    });
  });

  it('formats a conventional first line', () => {
    expect(
      formatConventionalHead({
        type: 'feat',
        scope: 'api',
        subject: 'add login',
      }),
    ).toBe('feat(api): add login');
    expect(formatConventionalHead({ type: 'fix', breaking: true, subject: 'crash' })).toBe(
      'fix!: crash',
    );
    expect(formatConventionalHead({ type: '', subject: 'wip' })).toBe('wip');
  });
});

describe('conventional lint and suggestions', () => {
  it('requires a type when asked, and allows any summary case', () => {
    expect(
      lintConventionalMessage('wip', { requireType: true, types: DEFAULT_COMMIT_TYPES }).map(
        (i) => i.rule,
      ),
    ).toContain('type-empty');
    expect(
      lintConventionalMessage('fix: Add login', { requireType: true, types: DEFAULT_COMMIT_TYPES }),
    ).toEqual([]);
    expect(
      lintConventionalMessage('fix: add login', { requireType: true, types: DEFAULT_COMMIT_TYPES }),
    ).toEqual([]);
  });

  it('suggests types from branch and files', () => {
    expect(suggestCommitType({ branch: 'fix/nav', files: [] })).toBe('fix');
    expect(
      suggestCommitType({
        branch: 'develop',
        files: [{ path: 'src/foo.spec.ts', status: 'modified' }],
      }),
    ).toBe('test');
    expect(
      suggestCommitType({
        branch: 'develop',
        files: [{ path: 'src/login.ts', status: 'untracked' }],
      }),
    ).toBe('feat');
  });
});
