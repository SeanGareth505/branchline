import { appendGitProcessOutput, gitProcessTitle } from './git-process-output';

describe('appendGitProcessOutput', () => {
  it('appends plain chunks', () => {
    expect(appendGitProcessOutput('git push\n', 'done\n')).toBe('git push\ndone\n');
  });

  it('treats carriage return as overwrite of the current line', () => {
    expect(appendGitProcessOutput('', 'Counting objects: 10%\rCounting objects: 100%\n')).toBe(
      'Counting objects: 100%\n',
    );
  });

  it('keeps previous lines when overwriting', () => {
    expect(appendGitProcessOutput('git push\n', 'Writing: 50%\rWriting: 100%\n')).toBe(
      'git push\nWriting: 100%\n',
    );
  });
});

describe('gitProcessTitle', () => {
  it('labels remote operations', () => {
    expect(gitProcessTitle('push')).toBe('Push');
    expect(gitProcessTitle('fetch')).toBe('Fetch');
  });

  it('labels checks and commit workflows', () => {
    expect(gitProcessTitle('check')).toBe('Repository checks');
    expect(gitProcessTitle('commit')).toBe('Commit');
  });
});
