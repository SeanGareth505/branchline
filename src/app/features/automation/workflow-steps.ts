export interface WorkflowStepDef {
  id: string;
  label: string;
  hint: string;
  interactive?: boolean;
}

export const WORKFLOW_STEP_CATALOG: WorkflowStepDef[] = [
  {
    id: 'checkoutBranch',
    label: 'Switch branch',
    hint: 'Pick a local branch and check it out',
    interactive: true,
  },
  {
    id: 'fetch',
    label: 'Fetch remotes',
    hint: 'Update remote-tracking branches',
  },
  {
    id: 'pull',
    label: 'Pull',
    hint: 'Fetch and merge from upstream',
  },
  {
    id: 'pullRebase',
    label: 'Pull with rebase',
    hint: 'Fetch and rebase onto upstream',
  },
  {
    id: 'push',
    label: 'Push',
    hint: 'Push the current branch upstream',
  },
  {
    id: 'createBranch',
    label: 'Create branch',
    hint: 'Choose a base, then name the new branch',
    interactive: true,
  },
  {
    id: 'openCommit',
    label: 'Commit',
    hint: 'Open commit and wait until you finish',
    interactive: true,
  },
  {
    id: 'stash',
    label: 'Stash changes',
    hint: 'Optionally name a stash, then park uncommitted work',
    interactive: true,
  },
  {
    id: 'refresh',
    label: 'Refresh',
    hint: 'Reload status, commits, and refs',
  },
];

export function stepLabel(id: string): string {
  return WORKFLOW_STEP_CATALOG.find((s) => s.id === id)?.label ?? id;
}

export function stepDef(id: string): WorkflowStepDef | undefined {
  return WORKFLOW_STEP_CATALOG.find((s) => s.id === id);
}
