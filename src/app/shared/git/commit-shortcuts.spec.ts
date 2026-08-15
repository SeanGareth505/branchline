import {
  normalizeCommitShortcutSequence,
  orderByCommitShortcutSequence,
  recordCommitShortcut,
} from './commit-shortcuts';

describe('commit shortcut sequence', () => {
  it('keeps first-seen valid ids and drops junk', () => {
    expect(
      normalizeCommitShortcutSequence(['topic', 'type', 'topic', 'nope', 'fixes', 'scope']),
    ).toEqual(['topic', 'type', 'fixes', 'scope']);
    expect(normalizeCommitShortcutSequence(null)).toEqual([]);
  });

  it('records a shortcut once, in click order', () => {
    let sequence = recordCommitShortcut([], 'type');
    sequence = recordCommitShortcut(sequence, 'scope');
    sequence = recordCommitShortcut(sequence, 'topic');
    sequence = recordCommitShortcut(sequence, 'type');
    expect(sequence).toEqual(['type', 'scope', 'topic']);
  });

  it('orders chips by the remembered sequence and leaves unused last', () => {
    const chips = [{ id: 'fixes' as const }, { id: 'topic' as const }, { id: 'scope' as const }];
    expect(orderByCommitShortcutSequence(chips, ['topic', 'fixes']).map((c) => c.id)).toEqual([
      'topic',
      'fixes',
      'scope',
    ]);
  });
});
