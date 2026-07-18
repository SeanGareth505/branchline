import type { CommitTypeOption } from './models';

export const DEFAULT_COMMIT_TYPES: CommitTypeOption[] = [
  { id: 'feat', label: 'feat', description: 'New feature' },
  { id: 'fix', label: 'fix', description: 'Bug fix' },
  { id: 'docs', label: 'docs', description: 'Documentation' },
  { id: 'refactor', label: 'refactor', description: 'Code change without behavior change' },
  { id: 'perf', label: 'perf', description: 'Performance improvement' },
  { id: 'test', label: 'test', description: 'Tests' },
  { id: 'build', label: 'build', description: 'Build system or dependencies' },
  { id: 'ci', label: 'ci', description: 'CI configuration' },
  { id: 'chore', label: 'chore', description: 'Maintenance' },
  { id: 'revert', label: 'revert', description: 'Revert a previous commit' },
];

export function normalizeCommitTypeId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export function normalizeCommitTypes(raw: unknown): CommitTypeOption[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return DEFAULT_COMMIT_TYPES.map((t) => ({ ...t }));
  }

  const seen = new Set<string>();
  const out: CommitTypeOption[] = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = normalizeCommitTypeId(String(record['id'] ?? ''));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = String(record['label'] ?? id).trim() || id;
    const description =
      typeof record['description'] === 'string' ? record['description'].trim() : '';
    out.push({ id, label, description });
  }

  return out.length ? out : DEFAULT_COMMIT_TYPES.map((t) => ({ ...t }));
}

export function commitTypePrefixPattern(types: CommitTypeOption[]): RegExp {
  const ids = types.map((t) => escapeRegex(t.id)).filter(Boolean);
  const alt = ids.length ? ids.join('|') : '[a-z][a-z0-9-]*';
  return new RegExp(`^(${alt}):\\s*`, 'i');
}

export function parseConventionalSubject(
  subject: string,
  types: CommitTypeOption[],
): { type: string; summary: string } | null {
  const ids = types.map((t) => escapeRegex(t.id)).filter(Boolean);
  const alt = ids.length ? ids.join('|') : '[a-z][a-z0-9-]*';
  const match = subject.match(new RegExp(`^(${alt}):\\s*(.*)$`, 'i'));
  if (!match) return null;
  return { type: match[1].toLowerCase(), summary: match[2] ?? '' };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
