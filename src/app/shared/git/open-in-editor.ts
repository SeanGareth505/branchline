import { openPath } from '@tauri-apps/plugin-opener';
import type { PreferredEditor } from '../../core/models';

export interface DetectedEditors {
  cursor: boolean;
  vscode: boolean;
}

export interface OpenInEditorOptions {
  preferred: PreferredEditor;
  editorCommand: string;
  detected?: DetectedEditors | null;
  openExternalUrl: (url: string) => Promise<void>;
  openWithCommand?: (command: string, path: string) => Promise<void>;
}

function asAbsoluteUriPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function schemeUrl(scheme: 'cursor' | 'vscode', absPath: string): string {
  return `${scheme}://file${asAbsoluteUriPath(absPath)}`;
}

async function openWithScheme(
  scheme: 'cursor' | 'vscode',
  absPath: string,
  openExternalUrl: (url: string) => Promise<void>,
): Promise<void> {
  await openExternalUrl(schemeUrl(scheme, absPath));
}

export function resolvePreferredEditor(
  preferred: PreferredEditor,
  detected?: DetectedEditors | null,
): PreferredEditor {
  if (preferred !== 'auto') return preferred;
  if (detected?.cursor) return 'cursor';
  if (detected?.vscode) return 'vscode';
  return 'system';
}

export function preferredEditorLabel(
  preferred: PreferredEditor,
  detected?: DetectedEditors | null,
): string {
  const resolved = resolvePreferredEditor(preferred, detected);
  switch (resolved) {
    case 'cursor':
      return 'Cursor';
    case 'vscode':
      return 'VS Code';
    case 'command':
      return 'editor command';
    case 'system':
      return 'system default';
    default:
      return 'editor';
  }
}

export async function openInPreferredEditor(
  absPath: string,
  options: OpenInEditorOptions,
): Promise<void> {
  const resolved = resolvePreferredEditor(options.preferred, options.detected);
  switch (resolved) {
    case 'cursor':
      await openWithScheme('cursor', absPath, options.openExternalUrl);
      return;
    case 'vscode':
      await openWithScheme('vscode', absPath, options.openExternalUrl);
      return;
    case 'command': {
      const command = options.editorCommand.trim();
      if (!command) {
        await openPath(absPath);
        return;
      }
      if (options.openWithCommand) {
        await options.openWithCommand(command, absPath);
        return;
      }
      await openPath(absPath);
      return;
    }
    case 'system':
    default:
      await openPath(absPath);
  }
}

export async function openPathsInPreferredEditor(
  absPaths: string[],
  options: OpenInEditorOptions,
): Promise<{ opened: number; firstPath: string | null }> {
  if (!absPaths.length) return { opened: 0, firstPath: null };
  for (const path of absPaths) {
    await openInPreferredEditor(path, options);
  }
  return { opened: absPaths.length, firstPath: absPaths[0] ?? null };
}
