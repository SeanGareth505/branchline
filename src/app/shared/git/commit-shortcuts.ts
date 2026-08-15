import type { CommitShortcutId } from '../../core/models';

export const COMMIT_SHORTCUT_IDS: readonly CommitShortcutId[] = [
  'type',
  'scope',
  'topic',
  'fixes',
];

export function isCommitShortcutId(value: unknown): value is CommitShortcutId {
  return value === 'type' || value === 'scope' || value === 'topic' || value === 'fixes';
}

export function normalizeCommitShortcutSequence(raw: unknown): CommitShortcutId[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<CommitShortcutId>();
  const out: CommitShortcutId[] = [];
  for (const item of raw) {
    if (!isCommitShortcutId(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function recordCommitShortcut(
  sequence: readonly CommitShortcutId[],
  id: CommitShortcutId,
): CommitShortcutId[] {
  if (sequence.includes(id)) return [...sequence];
  return [...sequence, id];
}

export function orderByCommitShortcutSequence<T extends { id: CommitShortcutId }>(
  items: readonly T[],
  sequence: readonly CommitShortcutId[],
): T[] {
  const rank = new Map(sequence.map((id, index) => [id, index]));
  return [...items].sort((a, b) => {
    const ai = rank.get(a.id);
    const bi = rank.get(b.id);
    if (ai == null && bi == null) return 0;
    if (ai == null) return 1;
    if (bi == null) return -1;
    return ai - bi;
  });
}
