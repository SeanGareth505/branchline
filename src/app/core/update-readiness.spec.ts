import { isUpdaterManifestReady } from './update-readiness';

describe('isUpdaterManifestReady', () => {
  it('accepts manifests whose platform downloads are public release URLs', () => {
    expect(
      isUpdaterManifestReady({
        platforms: {
          'darwin-aarch64': {
            url: 'https://github.com/SeanGareth505/branchline/releases/download/v0.8.22/Branchline.app.tar.gz',
          },
          'windows-x86_64': {
            url: 'https://github.com/SeanGareth505/branchline/releases/download/v0.8.22/Branchline.exe',
          },
        },
      }),
    ).toBeTrue();
  });

  it('rejects manifests while any platform still uses a GitHub API asset URL', () => {
    expect(
      isUpdaterManifestReady({
        platforms: {
          'darwin-aarch64': {
            url: 'https://github.com/SeanGareth505/branchline/releases/download/v0.8.22/Branchline.app.tar.gz',
          },
          'windows-x86_64': {
            url: 'https://api.github.com/repos/SeanGareth505/branchline/releases/assets/123',
          },
        },
      }),
    ).toBeFalse();
  });

  it('rejects manifests without platform downloads', () => {
    expect(isUpdaterManifestReady({ platforms: {} })).toBeFalse();
  });
});
