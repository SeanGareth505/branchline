import { sanitizeBranchName } from './workflow-placeholders';

describe('sanitizeBranchName', () => {
  it('turns spaces into hyphens like Git Extensions', () => {
    expect(sanitizeBranchName('PROJ-123 test')).toBe('PROJ-123-test');
    expect(sanitizeBranchName('PROJ-123  test')).toBe('PROJ-123-test');
  });

  it('keeps a trailing hyphen while the next word is typed', () => {
    expect(sanitizeBranchName('PROJ-123 ')).toBe('PROJ-123-');
  });

  it('strips leading spaces instead of making a leading hyphen', () => {
    expect(sanitizeBranchName(' PROJ-123 test')).toBe('PROJ-123-test');
  });

  it('replaces git-illegal characters and keeps slashes', () => {
    expect(sanitizeBranchName('feature/fix: broken?')).toBe('feature/fix-broken-');
    expect(sanitizeBranchName('foo\\bar')).toBe('foo-bar');
  });
});
