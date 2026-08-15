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
