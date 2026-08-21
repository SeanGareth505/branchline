import { sharedRepoPrefix } from './pr-copy';

describe('sharedRepoPrefix', () => {
  it('returns a shared org prefix so menus can show short names', () => {
    expect(sharedRepoPrefix(['dischem-web', 'dischem-soft'])).toBe('dischem-');
    expect(sharedRepoPrefix(['MyOrg/web', 'MyOrg/soft'])).toBe('MyOrg/');
  });

  it('returns empty when names are already short or unique', () => {
    expect(sharedRepoPrefix(['web', 'soft'])).toBe('');
    expect(sharedRepoPrefix(['dischem-web'])).toBe('');
    expect(sharedRepoPrefix([])).toBe('');
  });
});
