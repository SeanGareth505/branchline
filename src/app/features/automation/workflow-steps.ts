import type { WorkflowStep, WorkflowStepConfig, WorkflowStepJson } from '../../core/models';

export interface WorkflowStepDef {
  id: string;
  label: string;
  hint: string;
  interactive?: boolean;
  configurable?: boolean;
}

export const WORKFLOW_STEP_CATALOG: WorkflowStepDef[] = [
  {
    id: 'checkoutBranch',
    label: 'Switch branch',
    hint: 'Check out a fixed branch, or pick one when running',
    interactive: true,
    configurable: true,
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
    hint: 'Create from a name pattern automatically, or prompt when unset',
    interactive: true,
    configurable: true,
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
    hint: 'Stash with an optional fixed message, or prompt when running',
    interactive: true,
    configurable: true,
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

export function asWorkflowStep(step: WorkflowStepJson): WorkflowStep {
  if (typeof step === 'string') return { id: step };
  return {
    id: step.id,
    config: step.config ? { ...step.config } : undefined,
  };
}

export function stepIdOf(step: WorkflowStepJson): string {
  return typeof step === 'string' ? step : step.id;
}

export function compactStepConfig(config: WorkflowStepConfig | undefined): WorkflowStepConfig | undefined {
  if (!config) return undefined;
  const next: WorkflowStepConfig = {};
  if (config.namePattern?.trim()) next.namePattern = config.namePattern.trim();
  if (config.startPoint?.trim()) next.startPoint = config.startPoint.trim();
  if (config.checkout === false) next.checkout = false;
  if (config.branch?.trim()) next.branch = config.branch.trim();
  if (config.stashMessage !== undefined) next.stashMessage = config.stashMessage;
  if (config.skipPrompt) next.skipPrompt = true;
  return Object.keys(next).length > 0 ? next : undefined;
}

export function serializeWorkflowSteps(steps: WorkflowStep[]): WorkflowStepJson[] {
  return steps.map((step) => {
    const config = compactStepConfig(step.config);
    return config ? { id: step.id, config } : step.id;
  });
}

export function stepSummary(step: WorkflowStepJson): string {
  const normalized = asWorkflowStep(step);
  const label = stepLabel(normalized.id);
  const cfg = normalized.config;
  if (!cfg) return label;
  if (normalized.id === 'createBranch' && cfg.namePattern?.trim()) {
    return `${label} · ${cfg.namePattern.trim()}`;
  }
  if (normalized.id === 'checkoutBranch' && cfg.branch?.trim()) {
    return `${label} · ${cfg.branch.trim()}`;
  }
  if (normalized.id === 'stash' && cfg.skipPrompt) {
    const msg = cfg.stashMessage?.trim();
    return msg ? `${label} · ${msg}` : `${label} · auto`;
  }
  return label;
}

export function createBranchIsAutomatic(config?: WorkflowStepConfig): boolean {
  return !!config?.namePattern?.trim();
}
