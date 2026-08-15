import { commitWebUrl, compareWebUrl, fileWebUrl } from './repo-links';

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
});
