export function parseRemoteRef(ref: string): { remote: string; branch: string } | null {
  const name = ref.replace(/^refs\/remotes\//, '').replace(/^remotes\//, '');
  const slash = name.indexOf('/');
  if (slash <= 0) return null;
  const remote = name.slice(0, slash);
  const branch = name.slice(slash + 1);
  if (!remote || !branch) return null;
  return { remote, branch };
}
