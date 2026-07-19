import type { RunGitOutput } from '../../core/models';

export type GitToolKind = 'diff' | 'merge';

export async function runConfiguredGitTool(options: {
  kind: GitToolKind;
  repoPath: string;
  toolName: string;
  paths?: string[];
  runGitCommand: (path: string, args: string[]) => Promise<RunGitOutput>;
}): Promise<RunGitOutput> {
  const configured = options.toolName.trim();
  const paths = options.paths?.filter(Boolean) ?? [];
  const toolArg = options.kind === 'diff' ? 'difftool' : 'mergetool';
  const configKey = options.kind === 'diff' ? 'diff.tool' : 'merge.tool';
  const base = configured
    ? ['-c', `${configKey}=${configured}`, toolArg, '--no-prompt']
    : [toolArg, '--no-prompt'];
  return options.runGitCommand(options.repoPath, [...base, ...paths]);
}
