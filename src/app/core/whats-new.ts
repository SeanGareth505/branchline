export function normalizeAppVersion(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/^v/i, '');
}

export function shouldShowWhatsNew(options: {
  currentVersion: string;
  lastSeenVersion: string | null;
  pendingVersion: string | null;
}): boolean {
  const current = normalizeAppVersion(options.currentVersion);
  if (!current) return false;
  const pending = normalizeAppVersion(options.pendingVersion);
  if (pending && pending === current) return true;
  const seen = normalizeAppVersion(options.lastSeenVersion);
  if (!seen) return false;
  return seen !== current;
}

export function extractWhatsNewBody(raw: string): string {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  const withoutInstall = text.split(/^## Install\b/m)[0]?.trim() ?? '';
  if (!withoutInstall) return '';
  const placeholder =
    /^## What's new[^\n]*\n+\s*Changes since the previous release are listed on this GitHub tag\.?\s*$/i;
  if (placeholder.test(withoutInstall)) return '';
  return withoutInstall;
}

export function githubReleaseTagUrl(version: string): string {
  const tag = normalizeAppVersion(version);
  return tag ? `https://github.com/SeanGareth505/branchline/releases/tag/v${tag}` : '';
}
