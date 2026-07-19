export const BRANCHLINE_GITHUB_OAUTH_CLIENT_ID = 'Ov23li49RN1LFZ3qV2yd';

export function resolveGithubOAuthClientId(settingsOverride = ''): string {
  const fromSettings = settingsOverride.trim();
  if (fromSettings) return fromSettings;
  return BRANCHLINE_GITHUB_OAUTH_CLIENT_ID.trim();
}

export function hasGithubOAuthClientId(settingsOverride = ''): boolean {
  return !!resolveGithubOAuthClientId(settingsOverride);
}
