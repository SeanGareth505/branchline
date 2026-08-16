import type { KeyboardShortcuts } from '../../core/models';

export type ShortcutId = keyof KeyboardShortcuts;

export const DEFAULT_SHORTCUTS: KeyboardShortcuts = {
  palette: 'Mod+K',
  commit: 'Mod+Shift+C',
  fetch: 'Mod+Shift+F',
  search: 'Mod+P',
  undo: 'Mod+Z',
  refresh: 'F5',
};

const MOD_TOKENS = new Set(['Mod', 'Meta', 'Ctrl', 'Control', 'Cmd', 'Command']);
const ALT_TOKENS = new Set(['Alt', 'Option']);
const ALL_MODS = new Set(['Mod', 'Meta', 'Ctrl', 'Control', 'Cmd', 'Command', 'Shift', 'Alt', 'Option']);

export function resolveShortcuts(raw?: Partial<KeyboardShortcuts> | null): KeyboardShortcuts {
  return { ...DEFAULT_SHORTCUTS, ...raw };
}

export function isModifierOnly(event: KeyboardEvent): boolean {
  return event.key === 'Meta' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift' || event.key === 'OS';
}

function eventKeyName(event: KeyboardEvent): string {
  if (event.key === ' ') return 'Space';
  if (event.key.length === 1) return event.key.toUpperCase();
  return event.key;
}

export function normalizeShortcut(event: KeyboardEvent): string {
  if (isModifierOnly(event)) return '';
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('Mod');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(eventKeyName(event));
  return parts.join('+');
}

export function shortcutMatches(event: KeyboardEvent, accel: string | undefined | null): boolean {
  if (!accel) return false;
  const parts = accel.split('+').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return false;

  const wantKey = parts.filter((part) => !ALL_MODS.has(part)).join('+');
  if (!wantKey) return false;

  const wantMod = parts.some((part) => MOD_TOKENS.has(part));
  const wantShift = parts.includes('Shift');
  const wantAlt = parts.some((part) => ALT_TOKENS.has(part));
  const hasMod = event.metaKey || event.ctrlKey;

  if (wantMod !== hasMod) return false;
  if (wantShift !== event.shiftKey) return false;
  if (wantAlt !== event.altKey) return false;

  const actual = eventKeyName(event);
  return actual === wantKey || actual.toLowerCase() === wantKey.toLowerCase();
}

export function formatShortcut(accel: string): string {
  return accel
    .replace(/Mod\+/g, '⌘')
    .replace(/Meta\+/g, '⌘')
    .replace(/Cmd\+/g, '⌘')
    .replace(/Command\+/g, '⌘')
    .replace(/Control\+/g, 'Ctrl+')
    .replace(/Ctrl\+/g, 'Ctrl+')
    .replace(/Shift\+/g, '⇧')
    .replace(/Option\+/g, '⌥')
    .replace(/Alt\+/g, '⌥');
}
