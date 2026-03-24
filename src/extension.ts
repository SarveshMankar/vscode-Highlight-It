import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Current selected color for highlighting (default is red)
let currentColor = 'rgba(255, 0, 0, 0.5)';

// Map to store decoration types by color
let decorationStyles: Map<string, vscode.TextEditorDecorationType> = new Map();

// Map to store highlights by file URI, each with its associated color and range
let fileHighlights: Map<string, { color: string; range: vscode.Range }[]> = new Map();

// Map to track if a blank line was added by the extension for each file
let blankLineAddedByExtension: Map<string, boolean> = new Map();

// Toggle state and timers for selection stability
let highlightingActive = false;
let selectionStableTimer: NodeJS.Timeout | null = null;
let branchRefreshTimer: NodeJS.Timeout | null = null;
let branchPollTimer: NodeJS.Timeout | null = null;
let lastSelectionKey = '';

// Extension context for storing highlights
let extensionContext: vscode.ExtensionContext;

// Helper functions for persistence
function getStorageKey(uri: string): string {
  return `highlights_${uri}`;
}

function getFileBranchKey(uri: string, branch: string): string {
  return `${branch}::${uri}`;
}

type SerializedHighlight = {
  color: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
};

type BranchScopedHighlightStore = Record<string, SerializedHighlight[]>;

type GitRepositoryLike = {
  state?: {
    onDidChange?: (listener: () => void) => vscode.Disposable;
  };
};

type GitApiLike = {
  repositories?: GitRepositoryLike[];
  onDidOpenRepository?: (listener: (repo: GitRepositoryLike) => void) => vscode.Disposable;
};

function serializeHighlights(highlights: { color: string; range: vscode.Range }[]): SerializedHighlight[] {
  return highlights.map(h => ({
    color: h.color,
    range: {
      start: { line: h.range.start.line, character: h.range.start.character },
      end: { line: h.range.end.line, character: h.range.end.character }
    }
  }));
}

function deserializeHighlights(data: SerializedHighlight[]): { color: string; range: vscode.Range }[] {
  return data.map(h => ({
    color: h.color,
    range: new vscode.Range(
      new vscode.Position(h.range.start.line, h.range.start.character),
      new vscode.Position(h.range.end.line, h.range.end.character)
    )
  }));
}

function clearEditorDecorations(editor: vscode.TextEditor): void {
  decorationStyles.forEach(style => editor.setDecorations(style, []));
}

async function saveHighlights(
  uri: string,
  branch: string,
  highlights: { color: string; range: vscode.Range }[]
): Promise<void> {
  const storageKey = getStorageKey(uri);
  const stored = extensionContext.globalState.get<unknown>(storageKey, {});

  // Backward compatibility with pre-branch storage format.
  const branchStore: BranchScopedHighlightStore = Array.isArray(stored) ? {} : (stored as BranchScopedHighlightStore);
  branchStore[branch] = serializeHighlights(highlights);
  await extensionContext.globalState.update(storageKey, branchStore);
}

function loadHighlights(uri: string, branch: string): { color: string; range: vscode.Range }[] {
  const storageKey = getStorageKey(uri);
  const stored = extensionContext.globalState.get<unknown>(storageKey);

  // Backward compatibility with pre-branch storage format.
  if (stored && Array.isArray(stored)) {
    return deserializeHighlights(stored as SerializedHighlight[]);
  }

  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const branchStore = stored as BranchScopedHighlightStore;
    const branchHighlights = branchStore[branch];
    if (Array.isArray(branchHighlights)) {
      return deserializeHighlights(branchHighlights);
    }
  }

  return [];
}

async function getGitBranchName(uri: vscode.Uri): Promise<string> {
  if (uri.scheme !== 'file') {
    return getNonGitContextKey(uri);
  }

  const startDir = path.dirname(uri.fsPath);
  const gitDir = await findGitDirectory(startDir);
  if (!gitDir) {
    return getNonGitContextKey(uri);
  }

  try {
    const headPath = path.join(gitDir, 'HEAD');
    const head = (await fs.readFile(headPath, 'utf8')).trim();
    if (head.startsWith('ref:')) {
      const ref = head.slice(5).trim();
      const prefix = 'refs/heads/';
      return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
    }

    // Detached HEAD fallback with short commit hash.
    return `detached-${head.slice(0, 7)}`;
  } catch {
    return getNonGitContextKey(uri);
  }
}

function getNonGitContextKey(uri: vscode.Uri): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (workspaceFolder) {
    // Keep highlights isolated per opened workspace folder when no git branch exists.
    return `workspace-${workspaceFolder.uri.toString()}`;
  }

  return `nogit-${uri.toString()}`;
}

async function findGitDirectory(startDir: string): Promise<string | undefined> {
  let currentDir = startDir;

  while (true) {
    const possibleGitPath = path.join(currentDir, '.git');

    try {
      const stat = await fs.stat(possibleGitPath);
      if (stat.isDirectory()) {
        return possibleGitPath;
      }

      if (stat.isFile()) {
        const raw = (await fs.readFile(possibleGitPath, 'utf8')).trim();
        const gitDirPrefix = 'gitdir:';
        if (raw.toLowerCase().startsWith(gitDirPrefix)) {
          const relativePath = raw.slice(gitDirPrefix.length).trim();
          return path.resolve(currentDir, relativePath);
        }
      }
    } catch {
      // Keep traversing up until root.
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return undefined;
}

async function getHighlightsForEditor(editor: vscode.TextEditor): Promise<{
  branch: string;
  fileKey: string;
  highlights: { color: string; range: vscode.Range }[];
}> {
  const uri = editor.document.uri.toString();
  const branch = await getGitBranchName(editor.document.uri);
  const fileKey = getFileBranchKey(uri, branch);

  let highlights = fileHighlights.get(fileKey);
  if (!highlights) {
    highlights = loadHighlights(uri, branch);
    fileHighlights.set(fileKey, highlights);
  }

  return { branch, fileKey, highlights };
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  // Returns or creates a decoration type for a given color
  function getDecorationType(color: string): vscode.TextEditorDecorationType {
    if (!decorationStyles.has(color)) {
      decorationStyles.set(color, vscode.window.createTextEditorDecorationType({
        backgroundColor: color,
        border: '1px dashed #888',
        isWholeLine: false,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        borderRadius: '3px',
        overviewRulerColor: color,
        overviewRulerLane: vscode.OverviewRulerLane.Full
      }));
    }
    return decorationStyles.get(color)!;
  }

  function applyHighlightsToEditor(editor: vscode.TextEditor, highlights: { color: string; range: vscode.Range }[]): void {
    clearEditorDecorations(editor);
    const colorsInUse = new Set(highlights.map(h => h.color));
    colorsInUse.forEach(color => {
      const ranges = highlights.filter(h => h.color === color).map(h => h.range);
      const style = getDecorationType(color);
      editor.setDecorations(style, ranges);
    });
  }

  async function refreshVisibleEditorsFromBranchState(): Promise<void> {
    if (!highlightingActive) {
      return;
    }

    for (const editor of vscode.window.visibleTextEditors) {
      const { highlights } = await getHighlightsForEditor(editor);
      applyHighlightsToEditor(editor, highlights);
    }
  }

  function scheduleBranchRefresh(delayMs = 120): void {
    if (branchRefreshTimer) {
      clearTimeout(branchRefreshTimer);
    }

    branchRefreshTimer = setTimeout(() => {
      void refreshVisibleEditorsFromBranchState();
      branchRefreshTimer = null;
    }, delayMs);
  }

  async function registerGitApiBranchListeners(): Promise<void> {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension) {
      return;
    }

    const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    const gitApi = exports?.getAPI?.(1) as GitApiLike | undefined;
    if (!gitApi) {
      return;
    }

    const registerRepoListener = (repo: GitRepositoryLike) => {
      if (repo.state?.onDidChange) {
        context.subscriptions.push(repo.state.onDidChange(() => scheduleBranchRefresh(0)));
      }
    };

    (gitApi.repositories || []).forEach(registerRepoListener);

    if (gitApi.onDidOpenRepository) {
      context.subscriptions.push(gitApi.onDidOpenRepository((repo: GitRepositoryLike) => {
        registerRepoListener(repo);
        scheduleBranchRefresh(0);
      }));
    }
  }

  // Command to start highlight mode
  const startCommand = vscode.commands.registerCommand('extension.startHighlighting', async () => {
    highlightingActive = true;
    const editor = vscode.window.activeTextEditor;

    if (editor) {
      const uri = editor.document.uri.toString();
      const { branch, fileKey, highlights } = await getHighlightsForEditor(editor);

      const lastLineIndex = editor.document.lineCount - 1;
      const lastLine = editor.document.lineAt(lastLineIndex);
      const touchesEOF = highlights.some(h =>
        h.range.end.line === lastLineIndex &&
        h.range.end.character === lastLine.text.length
      );


      // Add blank line at end if a highlight goes till the end and last line isn't blank
      if (touchesEOF) {
        const lastLine = editor.document.lineAt(lastLineIndex);
        if (!lastLine.isEmptyOrWhitespace) {
          await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(editor.document.lineCount, 0), '\n');
          });
          blankLineAddedByExtension.set(getFileBranchKey(uri, branch), true);
          // vscode.window.showInformationMessage('Blank line added at end of file.');
        }
      }

      fileHighlights.set(fileKey, highlights);
      applyHighlightsToEditor(editor, highlights);
    }

    vscode.window.showInformationMessage('Highlighting mode started. Select text to toggle highlights.');
  });

  // Command to set the highlight color
  const setColorCommand = vscode.commands.registerCommand('extension.setHighlightColor', async () => {
    const picked = await vscode.window.showQuickPick(
      ['Red', 'Yellow', 'Green', 'Blue', 'Pink', 'Orange'],
      { placeHolder: 'Pick a highlight color' }
    );

    if (picked) {
      const colorMap: any = {
        Red: 'rgba(255, 0, 0, 0.5)',
        Yellow: 'rgba(255, 255, 0, 0.5)',
        Green: 'rgba(0, 255, 0, 0.5)',
        Blue: 'rgba(0, 0, 255, 0.5)',
        Pink: 'rgba(255, 105, 180, 0.5)',
        Orange: 'rgba(255, 165, 0, 0.5)'
      };

      currentColor = colorMap[picked];
      getDecorationType(currentColor); // Ensure decoration type is created
      vscode.window.showInformationMessage(`Highlight color set to ${picked}`);
    }
  });

  // Command to clear highlights for the current file
  const clearCommand = vscode.commands.registerCommand('extension.clearHighlights', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const uri = editor.document.uri.toString();
      const branch = await getGitBranchName(editor.document.uri);
      const fileKey = getFileBranchKey(uri, branch);
      fileHighlights.set(fileKey, []);
      // Clear persisted highlights
      await saveHighlights(uri, branch, []);
      clearEditorDecorations(editor);

      const lastLineIndex = editor.document.lineCount - 1;
      const lastLine = editor.document.lineAt(lastLineIndex);
      const wasAddedByUs = blankLineAddedByExtension.get(fileKey);

      if (wasAddedByUs && lastLine.isEmptyOrWhitespace && lastLineIndex > 0) {
        await editor.edit(editBuilder => {
          const range = new vscode.Range(
            new vscode.Position(lastLineIndex - 1, editor.document.lineAt(lastLineIndex - 1).text.length),
            new vscode.Position(lastLineIndex, lastLine.text.length)
          );
          editBuilder.delete(range);
        });
        await editor.document.save();
        blankLineAddedByExtension.set(fileKey, false);
      }

      vscode.window.showInformationMessage('Cleared highlights for current file (still in highlight mode).');
    }
  });

  // Command to stop highlight mode while preserving saved highlights
  const stopCommand = vscode.commands.registerCommand('extension.stopHighlighting', async () => {
    highlightingActive = false;
    // Keep persisted highlights so starting again restores branch/file highlights.
    fileHighlights.clear();

    for (const editor of vscode.window.visibleTextEditors) {
      const uri = editor.document.uri.toString();
      clearEditorDecorations(editor);

      const branch = await getGitBranchName(editor.document.uri);
      const fileKey = getFileBranchKey(uri, branch);

      const lastLineIndex = editor.document.lineCount - 1;
      const lastLine = editor.document.lineAt(lastLineIndex);
      const wasAddedByUs = blankLineAddedByExtension.get(fileKey);

      if (wasAddedByUs && lastLine.isEmptyOrWhitespace && lastLineIndex > 0) {
        await editor.edit(editBuilder => {
          const range = new vscode.Range(
            new vscode.Position(lastLineIndex - 1, editor.document.lineAt(lastLineIndex - 1).text.length),
            new vscode.Position(lastLineIndex, lastLine.text.length)
          );
          editBuilder.delete(range);
        });
        await editor.document.save();
        blankLineAddedByExtension.set(fileKey, false);
      }
    }

    vscode.window.showInformationMessage('Highlighting mode stopped. Saved highlights are preserved for restart.');
  });

  // Listener that reacts when the user selects text in the editor
  const selectionListener = vscode.window.onDidChangeTextEditorSelection((e) => {
    if (!highlightingActive) return;

    const editor = e.textEditor;
    const uri = editor.document.uri.toString();
    const selections = e.selections.filter(sel => !sel.isEmpty);
    if (selections.length === 0) return;

    const selectionKey = selections.map(sel => `${sel.start.line},${sel.start.character}-${sel.end.line},${sel.end.character}`).join(';');
    if (selectionKey !== lastSelectionKey && selectionStableTimer) {
      clearTimeout(selectionStableTimer);
    }
    lastSelectionKey = selectionKey;

    selectionStableTimer = setTimeout(async () => {
      const branch = await getGitBranchName(editor.document.uri);
      const fileKey = getFileBranchKey(uri, branch);
      let highlights = fileHighlights.get(fileKey) || loadHighlights(uri, branch);

      selections.forEach(sel => {
        const newRange = new vscode.Range(sel.start, sel.end);
        let result: { color: string; range: vscode.Range }[] = [];

        let isExactMatch = false;

        // Check if selection is already highlighted
        for (const existing of highlights) {
          if (existing.range.isEqual(newRange)) {
            if (existing.color === currentColor) {
              isExactMatch = true;
              continue;
            }
          }

          const intersection = existing.range.intersection(newRange);

          if (!intersection) {
            result.push(existing);
          } else {
            // Partial overlap -> trim existing range
            if (existing.range.start.isBefore(intersection.start)) {
              result.push({ color: existing.color, range: new vscode.Range(existing.range.start, intersection.start) });
            }
            if (existing.range.end.isAfter(intersection.end)) {
              result.push({ color: existing.color, range: new vscode.Range(intersection.end, existing.range.end) });
            }
          }
        }

        if (!isExactMatch) {
          const alreadyFullyCovered = highlights.some(h => h.range.contains(newRange));
          if (!alreadyFullyCovered) {
            result.push({ color: currentColor, range: newRange });
          }
        }

        highlights = result;
      });

      fileHighlights.set(fileKey, highlights);

      // Save highlights to persistent storage
      await saveHighlights(uri, branch, highlights);

      // Add blank line only if a highlight goes till end of file
      const lastLineIndex = editor.document.lineCount - 1;
      const lastLine = editor.document.lineAt(lastLineIndex);
      const touchesEOF = highlights.some(h =>
        h.range.end.line === lastLineIndex &&
        h.range.end.character === lastLine.text.length
      );

      if (touchesEOF) {
        const lastLine = editor.document.lineAt(lastLineIndex);
        if (!lastLine.isEmptyOrWhitespace) {
          await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(editor.document.lineCount, 0), '\n');
          });
          blankLineAddedByExtension.set(fileKey, true);
          // vscode.window.showInformationMessage('Blank line added at end of file.');
        }
      }

      applyHighlightsToEditor(editor, highlights);
    }, 300);
  });

  // Listener to reapply highlights when switching between files
  const editorChangeListener = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    if (editor && highlightingActive) {
      const { highlights } = await getHighlightsForEditor(editor);
      applyHighlightsToEditor(editor, highlights);
    }
  });

  // Refresh highlights after branch checkout updates .git internals.
  const gitHeadWatchers = (vscode.workspace.workspaceFolders || []).map(folder => {
    const headWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/.git/HEAD'));
    const refsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/.git/refs/heads/**'));

    const onChange = () => scheduleBranchRefresh();

    const headCreateSub = headWatcher.onDidCreate(onChange);
    const headChangeSub = headWatcher.onDidChange(onChange);
    const headDeleteSub = headWatcher.onDidDelete(onChange);
    const refsCreateSub = refsWatcher.onDidCreate(onChange);
    const refsChangeSub = refsWatcher.onDidChange(onChange);
    const refsDeleteSub = refsWatcher.onDidDelete(onChange);

    return {
      headWatcher,
      refsWatcher,
      headCreateSub,
      headChangeSub,
      headDeleteSub,
      refsCreateSub,
      refsChangeSub,
      refsDeleteSub
    };
  });

  // Also refresh when VS Code regains focus after terminal git operations.
  const windowFocusListener = vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) {
      scheduleBranchRefresh(0);
    }
  });

  // Fallback for checkout paths that do not emit filesystem events in the workspace.
  branchPollTimer = setInterval(async () => {
    if (!highlightingActive) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const uri = editor.document.uri.toString();
    const currentBranch = await getGitBranchName(editor.document.uri);
    const hasCurrentBranchHighlights = fileHighlights.has(getFileBranchKey(uri, currentBranch));

    if (!hasCurrentBranchHighlights) {
      scheduleBranchRefresh(0);
    }
  }, 1200);

  void registerGitApiBranchListeners();

  // Refresh highlights if files change after a branch checkout.
  const documentChangeListener = vscode.workspace.onDidChangeTextDocument(async (event) => {
    if (!highlightingActive || !vscode.window.activeTextEditor) {
      return;
    }

    if (event.document.uri.toString() !== vscode.window.activeTextEditor.document.uri.toString()) {
      return;
    }

    const { highlights } = await getHighlightsForEditor(vscode.window.activeTextEditor);
    applyHighlightsToEditor(vscode.window.activeTextEditor, highlights);
  });

  // Register all commands and listeners
  context.subscriptions.push(
    startCommand,
    setColorCommand,
    clearCommand,
    stopCommand,
    selectionListener,
    editorChangeListener,
    documentChangeListener,
    windowFocusListener,
    ...gitHeadWatchers.flatMap(item => [
      item.headWatcher,
      item.refsWatcher,
      item.headCreateSub,
      item.headChangeSub,
      item.headDeleteSub,
      item.refsCreateSub,
      item.refsChangeSub,
      item.refsDeleteSub
    ])
  );
}

// Dispose decorations and timers on deactivation
export function deactivate() {
  decorationStyles.forEach(style => style.dispose());
  if (selectionStableTimer) clearTimeout(selectionStableTimer);
  if (branchRefreshTimer) clearTimeout(branchRefreshTimer);
  if (branchPollTimer) clearInterval(branchPollTimer);
}
