export interface WorkflowPatternContext {
  branch: string;
  jira: string;
  type?: string;
  summary?: string;
  user?: string;
  prefix?: string;
  now?: Date;
}

export const BRANCH_PLACEHOLDER_TOKENS = [
  { token: '{date}', hint: 'Today YYYY-MM-DD' },
  { token: '{datetime}', hint: 'YYYY-MM-DD-HHmm' },
  { token: '{time}', hint: 'HHmm' },
  { token: '{yyyy}', hint: 'Year' },
  { token: '{mm}', hint: 'Month' },
  { token: '{dd}', hint: 'Day' },
  { token: '{jira}', hint: 'Active Jira key' },
  { token: '{name}', hint: 'Current branch' },
  { token: '{prefix}', hint: 'Default branch prefix' },
  { token: '{type}', hint: 'feat' },
  { token: '{user}', hint: 'Git user slug' },
] as const;

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

export function resolveWorkflowPattern(pattern: string, ctx: WorkflowPatternContext): string {
  const now = ctx.now ?? new Date();
  const yyyy = String(now.getFullYear());
  const mm = pad2(now.getMonth() + 1);
  const dd = pad2(now.getDate());
  const hh = pad2(now.getHours());
  const mi = pad2(now.getMinutes());
  const date = `${yyyy}-${mm}-${dd}`;
  const datetime = `${date}-${hh}${mi}`;
  const time = `${hh}${mi}`;

  return pattern
    .replaceAll('{datetime}', datetime)
    .replaceAll('{date}', date)
    .replaceAll('{time}', time)
    .replaceAll('{yyyy}', yyyy)
    .replaceAll('{mm}', mm)
    .replaceAll('{dd}', dd)
    .replaceAll('{jira}', ctx.jira || 'ticket')
    .replaceAll('{name}', ctx.branch || 'branch')
    .replaceAll('{prefix}', ctx.prefix || 'feature')
    .replaceAll('{type}', ctx.type || 'feat')
    .replaceAll('{summary}', ctx.summary || 'summary')
    .replaceAll('{user}', ctx.user || 'user')
    .split('\n')[0]
    .trim();
}

export function sanitizeBranchName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/\\/g, '-')
    .replace(/[~^:?*\[\]@{}"'<>|]/g, '-')
    .replace(/\.\.+/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/-+/g, '-')
    .replace(/-\//g, '/')
    .replace(/\/-/g, '/');
}

export function slugifyUser(name: string | null | undefined): string {
  if (!name?.trim()) return 'user';
  return (
    name
      .trim()
      .toLowerCase()
      .split(/[\s@]+/)[0]
      ?.replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'user'
  );
}
