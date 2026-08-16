import type { CommitTypeOption } from './models';

export const DEFAULT_COMMIT_TYPES: CommitTypeOption[] = [
  { id: 'feat', label: 'feat', description: 'New feature' },
  { id: 'fix', label: 'fix', description: 'Bug fix' },
  { id: 'docs', label: 'docs', description: 'Documentation' },
  { id: 'style', label: 'style', description: 'Formatting only' },
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

export interface ParsedConventionalSubject {
  type: string;
  scope: string;
  breaking: boolean;
  summary: string;
}

export function commitTypePrefixPattern(types: CommitTypeOption[]): RegExp {
  const ids = types.map((t) => escapeRegex(t.id)).filter(Boolean);
  const alt = ids.length ? ids.join('|') : '[a-z][a-z0-9-]*';
  return new RegExp(`^(${alt})(?:\\([^)]*\\))?(!)?:\\s*`, 'i');
}

export function parseConventionalSubject(
  subject: string,
  types: CommitTypeOption[],
): ParsedConventionalSubject | null {
  const ids = types.map((t) => escapeRegex(t.id)).filter(Boolean);
  const alt = ids.length ? ids.join('|') : '[a-z][a-z0-9-]*';
  const match = subject
    .trim()
    .match(new RegExp(`^(${alt})(?:\\(([^)]*)\\))?(!)?:\\s*(.*)$`, 'i'));
  if (!match) return null;
  return {
    type: match[1].toLowerCase(),
    scope: (match[2] ?? '').trim(),
    breaking: !!match[3],
    summary: match[4] ?? '',
  };
}

export function formatConventionalHead(input: {
  type: string;
  scope?: string;
  breaking?: boolean;
  subject: string;
}): string {
  const type = input.type.trim();
  const subject = input.subject.replace(/\s+/g, ' ').trim();
  if (!type) return subject;
  const scope = (input.scope ?? '').trim();
  const wrapped = scope ? `(${scope})` : '';
  const bang = input.breaking ? '!' : '';
  return subject ? `${type}${wrapped}${bang}: ${subject}` : `${type}${wrapped}${bang}:`;
}

export interface ConventionalLintIssue {
  level: 'error' | 'warning';
  rule: string;
  message: string;
}

export const CONVENTIONAL_HEADER_MAX = 100;

export function mergeCommitTypes(
  primary: CommitTypeOption[],
  extra: CommitTypeOption[],
): CommitTypeOption[] {
  const seen = new Set(primary.map((t) => t.id));
  const out = primary.map((t) => ({ ...t }));
  for (const type of extra) {
    if (seen.has(type.id)) continue;
    seen.add(type.id);
    out.push({ ...type });
  }
  return out;
}

export function lintConventionalMessage(
  message: string,
  opts: { requireType: boolean; types: CommitTypeOption[] },
): ConventionalLintIssue[] {
  const issues: ConventionalLintIssue[] = [];
  const trimmed = message.replace(/\s+$/, '');
  const nl = trimmed.indexOf('\n');
  const header = (nl < 0 ? trimmed : trimmed.slice(0, nl)).trimEnd();
  const rest = nl < 0 ? '' : trimmed.slice(nl + 1);
  const types = opts.types;
  const parsed = parseConventionalSubject(header, types) ?? parseConventionalSubject(header, []);

  if (opts.requireType && !parsed) {
    issues.push({
      level: 'error',
      rule: 'type-empty',
      message: 'Use a type like feat: or fix:',
    });
  }

  if (parsed) {
    const allowed = new Set(types.map((t) => t.id));
    if (allowed.size && !allowed.has(parsed.type)) {
      issues.push({
        level: 'error',
        rule: 'type-enum',
        message: `Type must be one of ${types.map((t) => t.id).join(', ')}`,
      });
    }
    if (!parsed.summary.trim()) {
      issues.push({
        level: 'error',
        rule: 'subject-empty',
        message: `Add a summary after ${parsed.type}:`,
      });
    } else {
      if (parsed.summary.endsWith('.')) {
        issues.push({
          level: 'error',
          rule: 'subject-full-stop',
          message: 'Do not end the summary with a period',
        });
      }
      if (/^[A-Z]/.test(parsed.summary)) {
        issues.push({
          level: 'error',
          rule: 'subject-case',
          message: `Use lowercase: ${parsed.summary[0].toLowerCase()}${parsed.summary.slice(1)}`,
        });
      }
    }
  }

  if (header.length > CONVENTIONAL_HEADER_MAX) {
    issues.push({
      level: 'error',
      rule: 'header-max-length',
      message: `First line is ${header.length} characters (max ${CONVENTIONAL_HEADER_MAX})`,
    });
  }

  if (rest.length) {
    if (!rest.startsWith('\n')) {
      issues.push({
        level: 'warning',
        rule: 'body-leading-blank',
        message: 'Leave a blank line before the body',
      });
    }
    for (const line of rest.split('\n')) {
      if (line.length > CONVENTIONAL_HEADER_MAX) {
        issues.push({
          level: 'error',
          rule: 'body-max-line-length',
          message: `Body line exceeds ${CONVENTIONAL_HEADER_MAX} characters`,
        });
        break;
      }
    }
  }

  return issues;
}

export function suggestCommitType(input: {
  branch: string;
  files: { path: string; status?: string }[];
}): string | null {
  const branch = input.branch.replace(/\\/g, '/').toLowerCase();
  const fromBranch = branch.match(
    /(?:^|\/)(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\/|$)/,
  );
  if (fromBranch) return fromBranch[1];

  const files = input.files.filter((f) => f.path.trim());
  if (!files.length) return null;

  const paths = files.map((f) => f.path.replace(/\\/g, '/').toLowerCase());
  const every = (re: RegExp) => paths.every((p) => re.test(p));

  if (every(/(\/|^)(test|tests|spec|e2e|__tests__)(\/|$)|(\.spec|\.test)\.[^/]+$/)) return 'test';
  if (every(/\.(md|mdx|rst|txt)$|(^|\/)docs\//)) return 'docs';
  if (every(/(^|\/)\.github\/|(^|\/)\.gitlab-ci|gitlab-ci\.yml$|(^|\/)\.circleci\//)) return 'ci';
  if (every(/\.(css|scss|sass|less)$|(^|\/)\.prettierrc|(^|\/)prettier\.config/)) return 'style';
  if (
    every(
      /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|cargo\.toml|cargo\.lock|dockerfile|angular\.json|vite\.config|webpack\.config)/,
    )
  ) {
    return 'build';
  }

  const added = files.some((f) => f.status === 'added' || f.status === 'untracked');
  return added ? 'feat' : 'fix';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
