import {
  ALL_REPO_ACCOUNTS,
  collectRepoAccounts,
  hostOwnerFromSlug,
  hostOwnerFromWebUrl,
  repoAccountMatchesOwner,
  resolveSelectedRepoAccount,
} from './repo-accounts';

describe('repo accounts', () => {
  it('reads the owner from a host slug or web URL', () => {
    expect(hostOwnerFromSlug('SeanGareth505/branchline')).toBe('SeanGareth505');
    expect(hostOwnerFromSlug('acme/platform/api')).toBe('acme/platform');
    expect(hostOwnerFromWebUrl('https://github.com/demo/navigo.git')).toBe('demo');
    expect(hostOwnerFromWebUrl('git@github.com:teammate/lumora.git')).toBe('teammate');
  });

  it('matches personal repos, mapped orgs, and unmapped locals', () => {
    const mappings = { acme: { login: 'work' } };
    expect(repoAccountMatchesOwner('demo', 'demo', mappings, 'demo')).toBe(true);
    expect(repoAccountMatchesOwner('work', 'acme', mappings, 'demo')).toBe(true);
    expect(repoAccountMatchesOwner('demo', 'acme', mappings, 'demo')).toBe(false);
    expect(repoAccountMatchesOwner('demo', 'other-org', mappings, 'demo')).toBe(true);
    expect(repoAccountMatchesOwner('work', 'other-org', mappings, 'demo')).toBe(false);
    expect(repoAccountMatchesOwner('demo', '', mappings, 'demo')).toBe(true);
    expect(repoAccountMatchesOwner(ALL_REPO_ACCOUNTS, 'acme', mappings, 'demo')).toBe(true);
  });

  it('collects CLI logins first and unique owners', () => {
    const accounts = collectRepoAccounts({
      cliAccounts: [
        { login: 'teammate', active: false },
        { login: 'demo', active: true },
      ],
      connectionUsernames: ['demo'],
      owners: ['demo', 'acme'],
    });
    expect(accounts.map((account) => account.key)).toEqual(['demo', 'teammate', 'acme']);
    expect(accounts[0].active).toBe(true);
    expect(accounts[0].cli).toBe(true);
  });

  it('defaults to the active login unless All was chosen', () => {
    const accounts = collectRepoAccounts({
      cliAccounts: [
        { login: 'demo', active: true },
        { login: 'teammate', active: false },
      ],
      connectionUsernames: [],
      owners: ['acme'],
    });
    expect(resolveSelectedRepoAccount('', accounts, ['demo'])).toBe('demo');
    expect(resolveSelectedRepoAccount(ALL_REPO_ACCOUNTS, accounts, ['demo'])).toBe(
      ALL_REPO_ACCOUNTS,
    );
    expect(resolveSelectedRepoAccount('teammate', accounts, ['demo'])).toBe('teammate');
  });
});
