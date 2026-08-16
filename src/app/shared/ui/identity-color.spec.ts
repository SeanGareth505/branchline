import { assignIdentityColors, identityColor, identityIndex, repoIdentityKey } from './identity-color';

describe('identityColor', () => {
  it('returns a stable index for the same key', () => {
    expect(identityIndex('branchline')).toBe(identityIndex('branchline'));
  });

  it('maps different repo names to different swatches', () => {
    expect(identityColor('branchline')).toMatch(/^var\(--swatch-\d+\)$/);
    expect(identityColor('acme-store')).not.toBe(identityColor('branchline'));
  });

  it('uses the repo name rather than a shared parent path', () => {
    expect(repoIdentityKey('branchline', '/Users/demo/Projects/branchline')).toBe('branchline');
    expect(repoIdentityKey('acme-store', '/Users/demo/Projects/acme-store')).toBe('acme-store');
  });

  it('assigns unique colors when preferred swatches collide', () => {
    const colors = assignIdentityColors(['feature', 'test', 'feature']);
    expect(colors.get('feature')).not.toBe(colors.get('test'));
    expect(colors.size).toBe(2);
  });
});
