const IDENTITY_SWATCH_COUNT = 12;

export function identityIndex(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % IDENTITY_SWATCH_COUNT;
}

export function identityColor(key: string): string {
  return `var(--swatch-${identityIndex(key) + 1})`;
}

export function repoIdentityKey(name?: string | null, path?: string | null): string {
  const n = name?.trim();
  if (n) return n.toLowerCase();
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return (base || normalized).toLowerCase();
}

export function assignIdentityColors(keys: string[]): Map<string, string> {
  const used = new Set<number>();
  const map = new Map<string, string>();
  for (const key of keys) {
    if (map.has(key)) continue;
    let index = identityIndex(key);
    if (used.has(index)) {
      for (let offset = 1; offset < IDENTITY_SWATCH_COUNT; offset++) {
        const next = (index + offset) % IDENTITY_SWATCH_COUNT;
        if (!used.has(next)) {
          index = next;
          break;
        }
      }
    }
    used.add(index);
    map.set(key, `var(--swatch-${index + 1})`);
  }
  return map;
}
