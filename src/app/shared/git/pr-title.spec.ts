import { defaultPrTitle, fallbackPrTitle, isMergeCommit } from './pr-title';

describe('pr title', () => {
  it('uses the only unique commit subject', () => {
    expect(
      defaultPrTitle(
        [{ subject: 'Add environment structure', parents: ['abc'] }],
        'sotf/feature/sotf-1766-setup-the-environments',
      ),
    ).toBe('Add environment structure');
  });

  it('skips merge commits when a single real commit remains', () => {
    expect(
      defaultPrTitle(
        [
          {
            subject:
              "Merge remote-tracking branch 'origin/develop' into sotf/feature/sotf-1766-setup-the-environments-to-the-new-environment-structure",
            parents: ['aaa', 'bbb'],
          },
          { subject: 'Add environment structure', parents: ['ccc'] },
        ],
        'sotf/feature/sotf-1766-setup-the-environments-to-the-new-environment-structure',
      ),
    ).toBe('Add environment structure');
  });

  it('humanizes the branch name when there are several unique commits', () => {
    expect(
      defaultPrTitle(
        [
          { subject: 'Tweak config', parents: ['a'] },
          { subject: 'Add environment structure', parents: ['b'] },
        ],
        'sotf/feature/sotf-1766-setup-the-environments-to-the-new-environment-structure',
      ),
    ).toBe('Setup the environments to the new environment structure');
  });

  it('humanizes the branch name when only merge commits are present', () => {
    expect(
      defaultPrTitle(
        [
          {
            subject: "Merge branch 'develop' into feature/login",
            parents: ['a', 'b'],
          },
        ],
        'sotf/feature/sotf-1766-setup-the-environments-to-the-new-environment-structure',
      ),
    ).toBe('Setup the environments to the new environment structure');
  });

  it('treats two-parent commits as merges even without a merge subject', () => {
    expect(isMergeCommit({ subject: 'Keep both sides', parents: ['a', 'b'] })).toBeTrue();
    expect(isMergeCommit({ subject: 'Keep both sides', parents: ['a'] })).toBeFalse();
  });

  it('falls back to a readable branch topic', () => {
    expect(
      fallbackPrTitle(
        'sotf/feature/sotf-1766-setup-the-environments-to-the-new-environment-structure',
      ),
    ).toBe('Setup the environments to the new environment structure');
  });
});
