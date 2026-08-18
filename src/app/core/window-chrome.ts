import { getCurrentWindow } from '@tauri-apps/api/window';

const INTERACTIVE_TITLEBAR =
  'button, a, input, select, textarea, label, [contenteditable="true"]';

const NO_DRAG_TITLEBAR = '.chrome-left, .chrome-views, .chrome-right, .chrome-tools';

export function isInteractiveTitlebarTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(INTERACTIVE_TITLEBAR);
}

export function isNoDragTitlebarTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(NO_DRAG_TITLEBAR);
}

export async function toggleWindowMaximize(): Promise<void> {
  try {
    await getCurrentWindow().toggleMaximize();
  } catch {
    // browser preview
  }
}

export function handleTitlebarMouseDown(event: MouseEvent): void {
  if (event.button !== 0) return;
  if (isInteractiveTitlebarTarget(event.target)) return;

  const win = getCurrentWindow();
  if (event.detail >= 2) {
    event.preventDefault();
    void win.toggleMaximize().catch(() => undefined);
    return;
  }

  if (isNoDragTitlebarTarget(event.target)) return;
  void win.startDragging().catch(() => undefined);
}
