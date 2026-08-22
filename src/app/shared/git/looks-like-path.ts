export function looksLikeFilesystemPath(value: string): boolean {
  const q = value.trim();
  if (!q) return false;
  if (q.startsWith('~')) return true;
  if (q.startsWith('/') || q.startsWith('\\')) return true;
  if (/^[A-Za-z]:[\\/]/.test(q)) return true;
  return q.includes('/') || q.includes('\\');
}
