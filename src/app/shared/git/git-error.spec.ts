import {
  extractRemoteUrlFromGitError,
  humanizeGitError,
  isRemoteAccessError,
} from './git-error';
import { githubSsoUrl, normalizeRemoteUrl, remoteProtocol, toSshRemoteUrl } from './repo-links';

describe('git remote errors', () => {
  const notFound =
    "Git error: remote: Repository not found. fatal: repository 'https://github.com/Dis-Chem/dischem-sap-commerce/' not found";

  it('extracts the remote URL from a GitHub not-found error', () => {
    expect(extractRemoteUrlFromGitError(notFound)).toBe(
      'https://github.com/Dis-Chem/dischem-sap-commerce/',
    );
  });

  it('treats repository-not-found as a remote access error', () => {
    expect(isRemoteAccessError(notFound)).toBe(true);
    expect(isRemoteAccessError('Git executable not found on PATH')).toBe(false);
  });

  it('explains GitHub hiding private repos as not found', () => {
    const text = humanizeGitError(notFound);
    expect(text).toContain('https://github.com/Dis-Chem/dischem-sap-commerce/');
    expect(text.toLowerCase()).toContain('credentials');
    expect(text.toLowerCase()).toContain('sso');
  });

  it('converts HTTPS remotes to SSH', () => {
    expect(toSshRemoteUrl('https://github.com/Dis-Chem/dischem-sap-commerce/')).toBe(
      'git@github.com:Dis-Chem/dischem-sap-commerce.git',
    );
    expect(remoteProtocol('https://github.com/org/repo.git')).toBe('https');
    expect(remoteProtocol('git@github.com:org/repo.git')).toBe('ssh');
  });

  it('matches trailing-slash and .git URLs', () => {
    expect(normalizeRemoteUrl('https://github.com/Dis-Chem/dischem-sap-commerce/')).toBe(
      normalizeRemoteUrl('https://github.com/Dis-Chem/dischem-sap-commerce.git'),
    );
  });

  it('builds an org SSO URL', () => {
    expect(githubSsoUrl('https://github.com/Dis-Chem/dischem-sap-commerce/')).toBe(
      'https://github.com/orgs/Dis-Chem/sso',
    );
  });
});
