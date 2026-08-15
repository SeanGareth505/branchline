import { normalizeShortcut, shortcutMatches } from './shortcuts';

function keyEvent(init: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): KeyboardEvent {
  return {
    key: init.key,
    metaKey: !!init.metaKey,
    ctrlKey: !!init.ctrlKey,
    shiftKey: !!init.shiftKey,
    altKey: !!init.altKey,
  } as KeyboardEvent;
}

describe('shortcutMatches', () => {
  it('matches Mod+K with meta or ctrl', () => {
    expect(shortcutMatches(keyEvent({ key: 'k', metaKey: true }), 'Mod+K')).toBe(true);
    expect(shortcutMatches(keyEvent({ key: 'k', ctrlKey: true }), 'Mod+K')).toBe(true);
    expect(shortcutMatches(keyEvent({ key: 'k' }), 'Mod+K')).toBe(false);
    expect(shortcutMatches(keyEvent({ key: 'k', metaKey: true, shiftKey: true }), 'Mod+K')).toBe(
      false,
    );
  });

  it('matches Mod+Shift+C', () => {
    expect(
      shortcutMatches(keyEvent({ key: 'c', metaKey: true, shiftKey: true }), 'Mod+Shift+C'),
    ).toBe(true);
    expect(shortcutMatches(keyEvent({ key: 'c', metaKey: true }), 'Mod+Shift+C')).toBe(false);
  });

  it('matches F5 without modifiers', () => {
    expect(shortcutMatches(keyEvent({ key: 'F5' }), 'F5')).toBe(true);
    expect(shortcutMatches(keyEvent({ key: 'F5', metaKey: true }), 'F5')).toBe(false);
    expect(shortcutMatches(keyEvent({ key: 'F5', shiftKey: true }), 'F5')).toBe(false);
  });
});

describe('normalizeShortcut', () => {
  it('normalizes modifier chords and function keys', () => {
    expect(normalizeShortcut(keyEvent({ key: 'k', metaKey: true }))).toBe('Mod+K');
    expect(normalizeShortcut(keyEvent({ key: 'c', ctrlKey: true, shiftKey: true }))).toBe(
      'Mod+Shift+C',
    );
    expect(normalizeShortcut(keyEvent({ key: 'F5' }))).toBe('F5');
    expect(normalizeShortcut(keyEvent({ key: 'Shift' }))).toBe('');
  });
});
