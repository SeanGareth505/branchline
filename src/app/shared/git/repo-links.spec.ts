import {
  branchWebUrl,
  commitWebUrl,
  compareWebUrl,
  fileWebUrl,
  githubSshKeysUrl,
  normalizeRemoteUrl,
  primaryGithubOwner,
  remoteProtocol,
  remoteRepoSlug,
  tagWebUrl,
  toHttpsRemoteUrl,
  toSshRemoteUrl,
} from './repo-links';

describe('repo web links', () => {
  it('builds a GitHub commit URL', () => {
    expect(commitWebUrl('https://github.com/example/navigo.git', 'abc1234')).toBe(
      'https://github.com/example/navigo/commit/abc1234',
    );
    expect(commitWebUrl('git@github.com:example/navigo.git', 'abc1234')).toBe(
      'https://github.com/example/navigo/commit/abc1234',
    );
  });

  it('builds a GitLab commit URL', () => {
    expect(commitWebUrl('https://gitlab.com/group/proj.git', 'abc1234')).toBe(
      'https://gitlab.com/group/proj/-/commit/abc1234',
    );
    expect(commitWebUrl('git@gitlab.com:group/proj.git', 'abc1234')).toBe(
      'https://gitlab.com/group/proj/-/commit/abc1234',
    );
  });

  it('builds GitHub and GitLab branch and tag URLs', () => {
    expect(branchWebUrl('https://github.com/example/navigo.git', 'feature/foo')).toBe(
      'https://github.com/example/navigo/tree/feature/foo',
    );
    expect(branchWebUrl('git@gitlab.com:group/proj.git', 'feature/foo')).toBe(
      'https://gitlab.com/group/proj/-/tree/feature/foo',
    );
    expect(tagWebUrl('https://github.com/example/navigo.git', 'v1.0.0')).toBe(
      'https://github.com/example/navigo/releases/tag/v1.0.0',
    );
    expect(tagWebUrl('https://gitlab.com/group/proj.git', 'v1.0.0')).toBe(
      'https://gitlab.com/group/proj/-/tags/v1.0.0',
    );
  });

  it('builds GitHub and GitLab compare and file URLs', () => {
    expect(compareWebUrl('https://github.com/example/navigo.git', 'abc', 'def')).toBe(
      'https://github.com/example/navigo/compare/abc...def',
    );
    expect(compareWebUrl('https://gitlab.com/group/proj.git', 'abc', 'def')).toBe(
      'https://gitlab.com/group/proj/-/compare/abc...def',
    );
    expect(fileWebUrl('https://github.com/example/navigo.git', 'abc1234', 'src/app.ts')).toBe(
      'https://github.com/example/navigo/blob/abc1234/src/app.ts',
    );
    expect(fileWebUrl('https://gitlab.com/group/proj.git', 'abc1234', 'src/app.ts')).toBe(
      'https://gitlab.com/group/proj/-/blob/abc1234/src/app.ts',
    );
  });

  it('converts HTTPS remotes to SSH', () => {
    expect(toSshRemoteUrl('https://github.com/Dis-Chem/dischem-sap-commerce/')).toBe(
      'git@github.com:Dis-Chem/dischem-sap-commerce.git',
    );
    expect(toHttpsRemoteUrl('git@github.com:Dis-Chem/dischem-web.git')).toBe(
      'https://github.com/Dis-Chem/dischem-web.git',
    );
    expect(remoteProtocol('https://github.com/org/repo.git')).toBe('https');
    expect(remoteProtocol('git@github.com:org/repo.git')).toBe('ssh');
  });

  it('matches trailing-slash and .git URLs', () => {
    expect(normalizeRemoteUrl('https://github.com/Dis-Chem/dischem-sap-commerce/')).toBe(
      normalizeRemoteUrl('https://github.com/Dis-Chem/dischem-sap-commerce.git'),
    );
  });

  it('builds SSH key settings URL', () => {
    expect(githubSshKeysUrl('git@github.com:Dis-Chem/dischem-web.git')).toBe(
      'https://github.com/settings/keys',
    );
  });

  it('reads the org/repo slug from SSH remotes', () => {
    expect(remoteRepoSlug('git@github.com:Dis-Chem/dischem-sap-commerce.git')).toBe(
      'Dis-Chem/dischem-sap-commerce',
    );
    expect(
      primaryGithubOwner([
        { name: 'origin', fetchUrl: 'https://github.com/Dis-Chem/dischem-web.git' },
      ]),
    ).toBe('dis-chem');
  });
});
