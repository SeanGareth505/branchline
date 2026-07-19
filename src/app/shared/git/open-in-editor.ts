import { openPath } from '@tauri-apps/plugin-opener';
import type { DetectedEditors, PreferredEditor } from '../../core/models';

export type IdeEditor = 'cursor' | 'vscode';

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

function schemeUrl(scheme: IdeEditor, absPath: string): string {
  return `${scheme}://file${asAbsoluteUriPath(absPath)}`;
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

export function ideCliCommand(
  editor: IdeEditor,
  detected?: DetectedEditors | null,
): string | null {
  if (editor === 'cursor') {
    return detected?.cursorPath?.trim() || (detected?.cursor ? 'cursor' : null);
  }
  return detected?.vscodePath?.trim() || (detected?.vscode ? 'code' : null);
}

async function openWithIde(
  editor: IdeEditor,
  absPath: string,
  options: OpenInEditorOptions,
): Promise<void> {
  const cli = ideCliCommand(editor, options.detected);
  if (cli && options.openWithCommand) {
    try {
      await options.openWithCommand(cli, absPath);
      return;
    } catch {
      // Fall through to URL scheme / system open.
    }
  }
  try {
    await options.openExternalUrl(schemeUrl(editor, absPath));
  } catch {
    await openPath(absPath);
  }
}

export async function openInPreferredEditor(
  absPath: string,
  options: OpenInEditorOptions,
): Promise<void> {
  const resolved = resolvePreferredEditor(options.preferred, options.detected);
  switch (resolved) {
    case 'cursor':
      await openWithIde('cursor', absPath, options);
      return;
    case 'vscode':
      await openWithIde('vscode', absPath, options);
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

export async function openInSpecificEditor(
  absPath: string,
  editor: IdeEditor | 'preferred' | 'system',
  options: OpenInEditorOptions,
): Promise<void> {
  if (editor === 'preferred') {
    await openInPreferredEditor(absPath, options);
    return;
  }
  if (editor === 'system') {
    await openPath(absPath);
    return;
  }
  await openWithIde(editor, absPath, options);
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

export function mergeToolPreset(editor: IdeEditor): {
  mergeTool: string;
  cmd: string;
  trustExitCode: string;
} {
  if (editor === 'cursor') {
    return {
      mergeTool: 'cursor',
      cmd: 'cursor --wait --merge "$LOCAL" "$REMOTE" "$BASE" "$MERGED"',
      trustExitCode: 'true',
    };
  }
  return {
    mergeTool: 'vscode',
    cmd: 'code --wait --merge "$LOCAL" "$REMOTE" "$BASE" "$MERGED"',
    trustExitCode: 'true',
  };
}
