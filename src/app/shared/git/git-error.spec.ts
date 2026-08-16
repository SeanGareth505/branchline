import {
  extractRemoteUrlFromGitError,
  humanizeGitError,
  isRemoteAccessError,
} from './git-error';

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
    const https = humanizeGitError(notFound);
    expect(https.toLowerCase()).toContain('https');
    expect(https.toLowerCase()).toContain('github cli');
    expect(https.toLowerCase()).toContain('remotes');
    const ssh = humanizeGitError(
      "ERROR: Repository not found.\nfatal: Could not read from remote repository.\nPlease make sure you have the correct access rights\nand the repository exists.\nfatal: Could not read from remote repository.",
    );
    expect(ssh.toLowerCase()).toContain('https');
    expect(ssh.toLowerCase()).toContain('ssh');
  });

  it('points SSH key failures at switching to HTTPS', () => {
    const message = humanizeGitError(
      'git@github.com: Permission denied (publickey).',
    );
    expect(message.toLowerCase()).toContain('https');
    expect(isRemoteAccessError('git@github.com: Permission denied (publickey).')).toBe(true);
  });

  it('explains rejected pushes without dropping the cause', () => {
    const message = humanizeGitError(
      '! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs',
    );
    expect(message.toLowerCase()).toContain('pull');
  });

  it('explains husky missing npm instead of dumping PATH noise', () => {
    const message = humanizeGitError(
      'Git error: .husky/pre-commit: line 1: npm: command not found\nhusky - pre-commit script failed (code 127)',
    );
    expect(message.toLowerCase()).toContain('npm');
    expect(message.toLowerCase()).toContain('restart');
    expect(message).not.toContain('line 1');
  });

  it('explains a failing husky check without the raw hook dump', () => {
    const message = humanizeGitError('husky - pre-commit script failed (code 1)');
    expect(message.toLowerCase()).toContain('hook');
    expect(message.toLowerCase()).toContain('retry');
  });
});
