import {
  DEFAULT_TICKET_FROM_BRANCH,
  branchSegments,
  customPatternError,
  extractBranchTopic,
  extractTicketFromBranch,
  normalizeTicketFromBranch,
} from './ticket-from-branch';

describe('ticket from branch', () => {
  const settings = { ...DEFAULT_TICKET_FROM_BRANCH };

  it('extracts a lowercase ticket key from nested branch folders', () => {
    expect(extractTicketFromBranch('sotf/feature/sotf-123', settings)).toBe('sotf-123');
  });

  it('extracts a Jira-style key from a mixed branch name', () => {
    expect(extractTicketFromBranch('feature/SOTF-42-login', settings)).toBe('SOTF-42');
  });

  it('uses the chosen path segment when ticket-key matching is off', () => {
    expect(
      extractTicketFromBranch('sotf/feature/add-login', {
        ...settings,
        matchTicketKey: false,
        useSegment: true,
        segmentIndex: 0,
      }),
    ).toBe('sotf');
  });

  it('uses the last path segment when the index is -1', () => {
    expect(
      extractTicketFromBranch('sotf/feature/sotf-123', {
        ...settings,
        matchTicketKey: false,
        useSegment: true,
        segmentIndex: -1,
      }),
    ).toBe('sotf-123');
  });

  it('prefers a custom capture group over ticket-key matching', () => {
    expect(
      extractTicketFromBranch('release/2024/sotf-99-final', {
        ...settings,
        customPattern: 'sotf-(\\d+)',
      }),
    ).toBe('99');
  });

  it('applies ticket case after extraction', () => {
    expect(
      extractTicketFromBranch('sotf/feature/sotf-123', {
        ...settings,
        ticketCase: 'upper',
      }),
    ).toBe('SOTF-123');
  });

  it('returns null when disabled or nothing matches', () => {
    expect(extractTicketFromBranch('sotf/feature/sotf-123', { ...settings, enabled: false })).toBe(
      null,
    );
    expect(
      extractTicketFromBranch('feature/add-login', {
        ...settings,
        matchTicketKey: false,
        useSegment: false,
      }),
    ).toBe(null);
  });

  it('splits branch folders and reports invalid custom patterns', () => {
    expect(branchSegments('refs/heads/sotf/feature/sotf-123')).toEqual([
      'sotf',
      'feature',
      'sotf-123',
    ]);
    expect(customPatternError('(unclosed')).toContain('Invalid');
    expect(customPatternError('sotf-(\\d+)')).toBeNull();
  });

  it('fills defaults for missing settings', () => {
    const normalized = normalizeTicketFromBranch({ matchTicketKey: false, segmentIndex: '2' });
    expect(normalized.enabled).toBe(true);
    expect(normalized.matchTicketKey).toBe(false);
    expect(normalized.segmentIndex).toBe(2);
    expect(normalized.putInScope).toBe(true);
  });

  it('turns the rest of the branch slug after the ticket into a topic', () => {
    expect(extractBranchTopic('sotf/feature/sotf-123-test', 'sotf-123')).toBe('Test');
    expect(extractBranchTopic('feature/SOTF-42-login', 'SOTF-42')).toBe('Login');
    expect(extractBranchTopic('sotf/feature/sotf-1695-create-the-interface', 'sotf-1695')).toBe(
      'Create the interface',
    );
    expect(extractBranchTopic('sotf/feature/sotf-123', 'sotf-123')).toBeNull();
    expect(extractBranchTopic('feature/add-login')).toBe('Add login');
  });
});
