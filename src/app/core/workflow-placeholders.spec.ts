import { sanitizeBranchName } from './workflow-placeholders';

describe('sanitizeBranchName', () => {
  it('turns spaces into hyphens like Git Extensions', () => {
    expect(sanitizeBranchName('sotf-123 test')).toBe('sotf-123-test');
    expect(sanitizeBranchName('sotf-123  test')).toBe('sotf-123-test');
  });

  it('keeps a trailing hyphen while the next word is typed', () => {
    expect(sanitizeBranchName('sotf-123 ')).toBe('sotf-123-');
  });

  it('strips leading spaces instead of making a leading hyphen', () => {
    expect(sanitizeBranchName(' sotf-123 test')).toBe('sotf-123-test');
  });

  it('replaces git-illegal characters and keeps slashes', () => {
    expect(sanitizeBranchName('sotf/feature/fix: broken?')).toBe('sotf/feature/fix-broken-');
    expect(sanitizeBranchName('foo\\bar')).toBe('foo-bar');
  });
});
