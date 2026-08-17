import { resolveBaseUpdateRef } from './mainline-branch';

describe('resolveBaseUpdateRef', () => {
  it('prefers the remote-tracking develop branch for a feature branch', () => {
    expect(
      resolveBaseUpdateRef(
        'feature/foo',
        ['feature/foo', 'develop', 'main'],
        ['origin/develop', 'origin/main'],
        ['develop', 'main'],
      ),
    ).toEqual({ ref: 'origin/develop', label: 'develop' });
  });

  it('falls back to local main when no remote mainline exists', () => {
    expect(resolveBaseUpdateRef('sotf-123', ['sotf-123', 'main'], [], ['develop', 'main'])).toEqual({
      ref: 'main',
      label: 'main',
    });
  });

  it('skips mainline branches', () => {
    expect(
      resolveBaseUpdateRef('main', ['main'], ['origin/main'], ['develop', 'main']),
    ).toBeNull();
    expect(
      resolveBaseUpdateRef('develop', ['develop', 'main'], ['origin/develop', 'origin/main'], [
        'develop',
        'main',
      ]),
    ).toBeNull();
  });

  it('skips a missing preferred develop and uses main', () => {
    expect(
      resolveBaseUpdateRef('feat/x', ['feat/x'], ['origin/main'], ['develop', 'main']),
    ).toEqual({ ref: 'origin/main', label: 'main' });
  });
});
