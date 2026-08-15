import { DEFAULT_COMMIT_TYPES, formatConventionalHead, parseConventionalSubject } from './commit-types';

describe('conventional commit subject', () => {
  it('parses type, scope, breaking marker, and summary', () => {
    expect(parseConventionalSubject('feat(sotf-123)!: add login', DEFAULT_COMMIT_TYPES)).toEqual({
      type: 'feat',
      scope: 'sotf-123',
      breaking: true,
      summary: 'add login',
    });
  });

  it('formats a conventional first line', () => {
    expect(
      formatConventionalHead({
        type: 'feat',
        scope: 'sotf-123',
        subject: 'add login',
      }),
    ).toBe('feat(sotf-123): add login');
    expect(formatConventionalHead({ type: 'fix', breaking: true, subject: 'crash' })).toBe(
      'fix!: crash',
    );
    expect(formatConventionalHead({ type: '', subject: 'wip' })).toBe('wip');
  });
});
