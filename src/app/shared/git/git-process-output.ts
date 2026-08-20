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
