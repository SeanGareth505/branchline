import type { WorkflowInfo, WorkflowStep } from '../../core/models';
import { shouldSkipFetch, shouldSkipRefresh, sortWorkflows } from './workflow-steps';

describe('workflow-steps helpers', () => {
  it('skips fetch when the next step already pulls', () => {
    const steps: WorkflowStep[] = [{ id: 'fetch' }, { id: 'pull' }];
    expect(shouldSkipFetch(steps, 0)).toBeTrue();
    expect(shouldSkipFetch([{ id: 'fetch' }, { id: 'pullRebase' }], 0)).toBeTrue();
    expect(shouldSkipFetch([{ id: 'fetch' }, { id: 'push' }], 0)).toBeFalse();
    expect(shouldSkipFetch([{ id: 'fetch' }], 0)).toBeFalse();
  });

  it('skips refresh when the previous step already reloaded the repo', () => {
    expect(shouldSkipRefresh([{ id: 'pull' }, { id: 'refresh' }], 1)).toBeTrue();
    expect(shouldSkipRefresh([{ id: 'stash' }, { id: 'refresh' }], 1)).toBeTrue();
    expect(shouldSkipRefresh([{ id: 'refresh' }], 0)).toBeFalse();
  });

  it('lists custom workflows before starters', () => {
    const list: WorkflowInfo[] = [
      { id: 'wf-a', name: 'A', description: '', steps: [], builtin: true, enabled: true },
      { id: 'wf-b', name: 'B', description: '', steps: [], builtin: false, enabled: true },
      { id: 'wf-c', name: 'C', description: '', steps: [], builtin: true, enabled: true },
    ];
    expect(sortWorkflows(list).map((w) => w.id)).toEqual(['wf-b', 'wf-a', 'wf-c']);
  });
});
