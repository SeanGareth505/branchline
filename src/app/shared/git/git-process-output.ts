export function appendGitProcessOutput(existing: string, chunk: string): string {
  if (!chunk) return existing;
  const normalized = chunk.replace(/\r\n/g, '\n');
  let text = existing;
  let i = 0;
  while (i < normalized.length) {
    const cr = normalized.indexOf('\r', i);
    const nl = normalized.indexOf('\n', i);
    if (cr >= 0 && (nl < 0 || cr < nl)) {
      text += normalized.slice(i, cr);
      const lastNl = text.lastIndexOf('\n');
      text = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
      i = cr + 1;
      continue;
    }
    if (nl >= 0) {
      text += normalized.slice(i, nl + 1);
      i = nl + 1;
      continue;
    }
    text += normalized.slice(i);
    break;
  }
  return text;
}

export function quoteGitArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function previewCommitMessage(message: string, maxLen = 120): string {
  const normalized = message.replace(/\r\n/g, '\n').trimEnd();
  const firstLine = normalized.split('\n')[0] ?? '';
  if (!normalized.includes('\n') && firstLine.length <= maxLen) return firstLine;
  const clipped =
    firstLine.length > maxLen ? `${firstLine.slice(0, Math.max(1, maxLen - 1))}…` : firstLine;
  return `${clipped}…`;
}

export function formatCommitGitCommand(opts: {
  amend?: boolean;
  skipHooks?: boolean;
  message: string;
}): string {
  const parts = ['git', 'commit'];
  if (opts.amend) parts.push('--amend');
  parts.push('--allow-empty');
  if (opts.skipHooks) parts.push('--no-verify');
  parts.push('-m', quoteGitArg(previewCommitMessage(opts.message)));
  return parts.join(' ');
}

export function gitProcessTitle(
  kind: 'fetch' | 'pull' | 'push' | 'merge' | 'rebase' | 'check' | 'commit',
): string {
  switch (kind) {
    case 'fetch':
      return 'Fetch';
    case 'pull':
      return 'Pull';
    case 'push':
      return 'Push';
    case 'merge':
      return 'Merge';
    case 'rebase':
      return 'Rebase';
    case 'check':
      return 'Repository checks';
    case 'commit':
      return 'Commit';
  }
}
