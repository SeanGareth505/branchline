const PUBLIC_RELEASE_PREFIX =
  'https://github.com/SeanGareth505/branchline/releases/download/';

export function isUpdaterManifestReady(rawJson: Record<string, unknown>): boolean {
  const platforms = rawJson['platforms'];
  if (!isRecord(platforms)) return false;

  const urls = Object.values(platforms)
    .filter(isRecord)
    .map((platform) => platform['url'])
    .filter((url): url is string => typeof url === 'string' && url.length > 0);

  return urls.length > 0 && urls.every((url) => url.startsWith(PUBLIC_RELEASE_PREFIX));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
