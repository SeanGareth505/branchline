const CREATE_MODE = /\bcreate mode \d{6}\b/i;
const DELETE_MODE = /\bdelete mode \d{6}\b/i;
const FILES_CHANGED = /\d+ files? changed\b/i;
const ALREADY_UP_TO_DATE = /already up[- ]to[- ]date/i;
const BRANCH_UP_TO_DATE = /\bis up to date\.?$/i;

export function isAlreadyUpToDateMessage(raw: string): boolean {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text) return false;
  return ALREADY_UP_TO_DATE.test(text) || BRANCH_UP_TO_DATE.test(text);
}

export function alreadyUpToDateLabel(source?: string | null): string {
  const name = source?.trim();
  return name ? `Already up to date with ${name}` : 'Already up to date';
}

export function summarizeGitToastMessage(raw: string, maxChars = 220): string {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text) return '';

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (!lines.length) return '';

  const verbose =
    lines.some((line) => CREATE_MODE.test(line) || DELETE_MODE.test(line)) ||
    lines.some((line) => FILES_CHANGED.test(line)) ||
    text.length > maxChars ||
    lines.length > 3;

  if (!verbose) {
    return lines.join(' · ');
  }

  const already = lines.find((line) => ALREADY_UP_TO_DATE.test(line) || BRANCH_UP_TO_DATE.test(line));
  const filesChanged = [...lines].reverse().find((line) => FILES_CHANGED.test(line));
  const fastForward = lines.some((line) => /^fast-forward$/i.test(line));
  let created = 0;
  let deleted = 0;
  for (const line of lines) {
    if (CREATE_MODE.test(line)) created += 1;
    else if (DELETE_MODE.test(line)) deleted += 1;
  }

  if (filesChanged) {
    return fastForward ? `Fast-forward · ${filesChanged}` : filesChanged;
  }

  if (created || deleted) {
    const parts: string[] = [];
    if (created) parts.push(`${created} added`);
    if (deleted) parts.push(`${deleted} deleted`);
    const prefix = fastForward ? 'Fast-forward' : 'Updated';
    return `${prefix} · ${parts.join(', ')}`;
  }

  if (already) return already.replace(/\.$/, '');

  const extra = lines.length - 1;
  let head = lines[0];
  if (head.length > maxChars) {
    head = `${head.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
  }
  if (extra <= 0) return head;
  return `${head} · ${extra} more line${extra === 1 ? '' : 's'}`;
}
