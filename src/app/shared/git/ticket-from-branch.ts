import type { TicketCase, TicketFromBranchSettings } from '../../core/models';

export const DEFAULT_TICKET_FROM_BRANCH: TicketFromBranchSettings = {
  enabled: true,
  matchTicketKey: true,
  useSegment: false,
  segmentIndex: -1,
  customPattern: '',
  ticketCase: 'preserve',
  putInScope: true,
};

const TICKET_KEY = /\b([A-Za-z][A-Za-z0-9]+-\d+)\b/;

export function branchSegments(branch: string): string[] {
  return stripRefPrefix(branch)
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function customPatternError(pattern: string): string | null {
  const raw = pattern.trim();
  if (!raw) return null;
  try {
    new RegExp(raw, 'i');
    return null;
  } catch {
    return 'Invalid regular expression';
  }
}

export function extractTicketFromBranch(
  branch: string,
  settings: TicketFromBranchSettings,
): string | null {
  if (!settings.enabled) return null;
  const name = stripRefPrefix(branch);
  if (!name) return null;

  let raw: string | null = null;
  if (settings.customPattern.trim()) {
    raw = matchCustomPattern(name, settings.customPattern);
  }
  if (!raw && settings.matchTicketKey) {
    raw = name.match(TICKET_KEY)?.[1] ?? null;
  }
  if (!raw && settings.useSegment) {
    const segs = branchSegments(name);
    if (!segs.length) return null;
    const idx = settings.segmentIndex < 0 ? segs.length - 1 : settings.segmentIndex;
    raw = segs[idx] ?? null;
  }

  return applyTicketCase(raw, settings.ticketCase);
}

export function branchNameWithTicket(branch: string, key: string): string {
  const ticket = key.trim();
  const name = stripRefPrefix(branch);
  if (!ticket) return name;
  if (!name) return ticket;
  if (name.toLowerCase().includes(ticket.toLowerCase())) return name;
  const segs = branchSegments(name);
  const last = segs[segs.length - 1] ?? name;
  const leaf = `${ticket}-${last}`.replace(/-+/g, '-');
  if (segs.length <= 1) return leaf;
  segs[segs.length - 1] = leaf;
  return segs.join('/');
}

const GENERIC_BRANCH_SLUG =
  /^(feat|feature|features|fix|fixes|bugfix|hotfix|chore|docs|doc|refactor|perf|test|tests|ci|build|release|releases|main|master|develop|development|dev|wip|spike)$/i;

export function extractBranchSlug(branch: string, ticket?: string | null): string | null {
  const segs = branchSegments(branch);
  if (!segs.length) return null;
  const last = segs[segs.length - 1];
  const keyMatch = last.match(TICKET_KEY);
  let slug = last;
  if (keyMatch && keyMatch.index != null) {
    slug = last.slice(keyMatch.index + keyMatch[0].length).replace(/^[-_]+/, '');
  } else if (ticket?.trim()) {
    const escaped = ticket.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    slug = last.replace(new RegExp(`^${escaped}[-_]*`, 'i'), '');
  }
  slug = slug.replace(/^[-_]+|[-_]+$/g, '');
  if (!slug) return null;
  if (ticket && slug.toLowerCase() === ticket.trim().toLowerCase()) return null;
  const onlyTicket = slug.match(TICKET_KEY);
  if (onlyTicket && onlyTicket[0].length === slug.length) return null;
  if (slug === last && GENERIC_BRANCH_SLUG.test(slug)) return null;
  return slug;
}

export function extractBranchTopic(branch: string, ticket?: string | null): string | null {
  const slug = extractBranchSlug(branch, ticket);
  if (!slug) return null;
  return humanizeBranchSlug(slug);
}

function humanizeBranchSlug(slug: string): string | null {
  const words = slug
    .split(/[-_]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!words.length) return null;
  return words
    .map((word, index) => {
      if (/^[A-Z0-9]{2,}$/.test(word)) return word;
      const lower = word.toLowerCase();
      if (index === 0) return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
      return lower;
    })
    .join(' ');
}

export function normalizeTicketFromBranch(raw: unknown): TicketFromBranchSettings {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const ticketCase = normalizeTicketCase(record['ticketCase']);
  const segmentIndex = Number.parseInt(String(record['segmentIndex'] ?? '-1'), 10);
  return {
    enabled: bool(record['enabled'], DEFAULT_TICKET_FROM_BRANCH.enabled),
    matchTicketKey: bool(record['matchTicketKey'], DEFAULT_TICKET_FROM_BRANCH.matchTicketKey),
    useSegment: bool(record['useSegment'], DEFAULT_TICKET_FROM_BRANCH.useSegment),
    segmentIndex: Number.isFinite(segmentIndex) ? segmentIndex : -1,
    customPattern:
      typeof record['customPattern'] === 'string' ? record['customPattern'] : '',
    ticketCase,
    putInScope: bool(record['putInScope'], DEFAULT_TICKET_FROM_BRANCH.putInScope),
  };
}

function stripRefPrefix(branch: string): string {
  return branch
    .trim()
    .replace(/^refs\/heads\//i, '')
    .replace(/^heads\//i, '');
}

function matchCustomPattern(branch: string, pattern: string): string | null {
  if (customPatternError(pattern)) return null;
  try {
    const match = branch.match(new RegExp(pattern.trim(), 'i'));
    if (!match) return null;
    const captured = (match[1] ?? match[0] ?? '').trim();
    return captured || null;
  } catch {
    return null;
  }
}

function applyTicketCase(value: string | null, mode: TicketCase): string | null {
  if (!value) return null;
  if (mode === 'upper') return value.toUpperCase();
  if (mode === 'lower') return value.toLowerCase();
  return value;
}

function normalizeTicketCase(raw: unknown): TicketCase {
  if (raw === 'upper' || raw === 'lower' || raw === 'preserve') return raw;
  return DEFAULT_TICKET_FROM_BRANCH.ticketCase;
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}
