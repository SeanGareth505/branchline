import type { SafetyAnalysis } from '../../../core/models';
import { safetySimpleFooterActions } from './safety-dialog-actions';

function analysis(partial: Partial<SafetyAnalysis>): SafetyAnalysis {
  return {
    action: 'deleteBranch',
    title: "Delete branch 'feature/x'?",
    severity: 'warning',
    target: 'feature/x',
    consequence: '',
    advice: '',
    checks: [],
    recommendedLabel: 'Delete local branch',
    recommendedAction: 'delete',
    proceedLabel: 'Delete local branch',
    gitCommand: 'git branch -d feature/x',
    proceedGitCommand: 'git branch -D feature/x',
    confirmPrompt: '',
    requireTypedConfirm: false,
    blocked: false,
    canProceed: true,
    ...partial,
  };
}

describe('safetySimpleFooterActions', () => {
  it('lets a merged local branch be deleted with the recommended action', () => {
    const actions = safetySimpleFooterActions(
      analysis({
        recommendedLabel: 'Delete local branch',
        recommendedAction: 'delete',
        proceedLabel: 'Delete local branch',
        severity: 'warning',
      }),
    );
    expect(actions.showCancel).toBeTrue();
    expect(actions.recommendedLabel).toBe('Delete local branch');
    expect(actions.recommendedKeep).toBeFalse();
    expect(actions.recommendedKind).toBe('danger');
    expect(actions.proceedLabel).toBeNull();
  });

  it('keeps unmerged delete as an explicit proceed action, not the default', () => {
    const actions = safetySimpleFooterActions(
      analysis({
        title: "Delete branch 'ui-test/click-1'?",
        target: 'ui-test/click-1',
        severity: 'danger',
        recommendedLabel: 'Keep branch',
        recommendedAction: 'keep',
        proceedLabel: 'Delete unmerged (backup first)',
      }),
    );
    expect(actions.showCancel).toBeTrue();
    expect(actions.recommendedLabel).toBe('Keep branch');
    expect(actions.recommendedKeep).toBeTrue();
    expect(actions.recommendedKind).toBe('primary');
    expect(actions.proceedLabel).toBe('Delete unmerged (backup first)');
  });

  it('blocks the current branch to Close only', () => {
    const actions = safetySimpleFooterActions(
      analysis({
        severity: 'danger',
        recommendedLabel: 'Close',
        recommendedAction: 'keep',
        proceedLabel: 'Close',
        blocked: true,
        canProceed: false,
      }),
    );
    expect(actions.showCancel).toBeFalse();
    expect(actions.recommendedLabel).toBe('Close');
    expect(actions.recommendedKeep).toBeTrue();
    expect(actions.recommendedKind).toBe('primary');
    expect(actions.proceedLabel).toBeNull();
  });

  it('offers a single leftover-local delete when the remote is gone', () => {
    const actions = safetySimpleFooterActions(
      analysis({
        recommendedLabel: 'Delete leftover local branch',
        recommendedAction: 'delete_gone',
        proceedLabel: 'Delete leftover local branch',
        gitCommand: 'git branch -D feature/x',
      }),
    );
    expect(actions.showCancel).toBeTrue();
    expect(actions.recommendedLabel).toBe('Delete leftover local branch');
    expect(actions.recommendedKeep).toBeFalse();
    expect(actions.proceedLabel).toBeNull();
  });
});
