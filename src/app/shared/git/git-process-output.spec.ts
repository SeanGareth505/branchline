import {
  appendGitProcessOutput,
  formatCommitGitCommand,
  gitProcessTitle,
  previewCommitMessage,
  quoteGitArg,
} from './git-process-output';

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

describe('formatCommitGitCommand', () => {
  it('shows the real amend message instead of a <message> placeholder', () => {
    const command = formatCommitGitCommand({
      amend: true,
      message: 'fix: keep the staged hunk',
    });
    expect(command).toBe("git commit --amend --allow-empty -m 'fix: keep the staged hunk'");
    expect(command).not.toContain('<message>');
  });

  it('includes --no-verify and quotes apostrophes in the preview', () => {
    const command = formatCommitGitCommand({
      skipHooks: true,
      message: "fix: don't drop HEAD",
    });
    expect(command).toBe(
      `git commit --allow-empty --no-verify -m ${quoteGitArg("fix: don't drop HEAD")}`,
    );
    expect(command).not.toContain('<message>');
  });

  it('previews only the first line of a multiline message', () => {
    expect(previewCommitMessage('Subject line\n\nBody paragraph')).toBe('Subject line…');
    expect(quoteGitArg("it's")).toBe(["'", 'it', "'\\''", 's', "'"].join(''));
  });
});
