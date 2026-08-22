import { looksLikeFilesystemPath } from './looks-like-path';

describe('looksLikeFilesystemPath', () => {
  it('accepts unix, windows, and home paths', () => {
    expect(looksLikeFilesystemPath('/home/sean/code/app')).toBeTrue();
    expect(looksLikeFilesystemPath('~/Projects/app')).toBeTrue();
    expect(looksLikeFilesystemPath('C:\\Users\\sean\\app')).toBeTrue();
    expect(looksLikeFilesystemPath('branchline')).toBeFalse();
  });
});
