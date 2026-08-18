export type WindowControlSide = 'macos' | 'windows' | 'other';

export function detectWindowControlSide(
  platform = typeof navigator === 'undefined' ? '' : navigator.platform,
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): WindowControlSide {
  const hay = `${platform} ${userAgent}`;
  if (/Mac|iPhone|iPad|iPod/i.test(hay)) return 'macos';
  if (/Win/i.test(hay)) return 'windows';
  return 'other';
}

export function applyWindowControlSide(
  side: WindowControlSide = detectWindowControlSide(),
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): WindowControlSide {
  if (root) root.setAttribute('data-window-controls', side);
  return side;
}
