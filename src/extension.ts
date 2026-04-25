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

// Debounce timers for persisting highlight updates caused by text edits.
let persistTimersByFileKey: Map<string, NodeJS.Timeout> = new Map();

// Toggle state and timers for selection stability
let highlightingActive = false;
let highlightDisplayEnabled = false;
let selectionStableTimer: NodeJS.Timeout | null = null;
let branchRefreshTimer: NodeJS.Timeout | null = null;
let branchPollTimer: NodeJS.Timeout | null = null;
let lastSelectionKey = '';

// Extension context for storing highlights
let extensionContext: vscode.ExtensionContext;
const HIGHLIGHT_STORAGE_PREFIX = 'highlights_';

// Helper functions for persistence
function getStorageKey(uri: string): string {
  return `${HIGHLIGHT_STORAGE_PREFIX}${uri}`;
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

type HighlightEntry = { color: string; range: vscode.Range };

type GitRepositoryLike = {
  state?: {
    onDidChange?: (listener: () => void) => vscode.Disposable;
  };
};

type GitApiLike = {
  repositories?: GitRepositoryLike[];
  onDidOpenRepository?: (listener: (repo: GitRepositoryLike) => void) => vscode.Disposable;
};

class HighlightDecorationProvider implements vscode.FileDecorationProvider {
  private readonly onDidChangeFileDecorationsEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();

  readonly onDidChangeFileDecorations = this.onDidChangeFileDecorationsEmitter.event;

  private highlightedFileUris = new Set<string>();
  private highlightedFolderUris = new Set<string>();
  private fileAncestorFolders = new Map<string, string[]>();
  private folderHighlightCounts = new Map<string, number>();
  private decorationsEnabled = true;

  private toCanonicalUriString(uri: vscode.Uri): string {
    if (uri.scheme !== 'file') {
      return uri.toString();
    }

    // Explorer can request folder decorations with slightly different URI forms
    // (for example with/without a trailing slash). Canonicalize to fsPath.
    return vscode.Uri.file(path.normalize(uri.fsPath)).toString();
  }

  private hasHighlightedDescendant(folderUri: vscode.Uri): boolean {
    if (folderUri.scheme !== 'file') {
      return false;
    }

    const folderPath = path.normalize(folderUri.fsPath);
    const folderPrefix = folderPath.endsWith(path.sep) ? folderPath : `${folderPath}${path.sep}`;

    for (const highlightedFileUriString of this.highlightedFileUris) {
      try {
        const highlightedUri = vscode.Uri.parse(highlightedFileUriString);
        if (highlightedUri.scheme !== 'file') {
          continue;
        }

        const highlightedFilePath = path.normalize(highlightedUri.fsPath);
        if (highlightedFilePath.startsWith(folderPrefix)) {
          return true;
        }
      } catch {
        // Ignore malformed URI entries.
      }
    }

    return false;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme !== 'file') {
      return;
    }

    if (!this.decorationsEnabled) {
      return;
    }

    const uriString = this.toCanonicalUriString(uri);
    if (this.highlightedFileUris.has(uriString)) {
      return new vscode.FileDecoration(
        'H',
        'This file contains highlights',
        new vscode.ThemeColor('charts.yellow')
      );
    }

    if (this.highlightedFolderUris.has(uriString) || this.hasHighlightedDescendant(uri)) {
      return new vscode.FileDecoration(
        'H',
        'This folder contains highlighted files',
        new vscode.ThemeColor('charts.yellow')
      );
    }

    return;
  }

  setDecorationsEnabled(enabled: boolean): void {
    if (this.decorationsEnabled === enabled) {
      return;
    }

    this.decorationsEnabled = enabled;
    this.emitChangedUriStrings(new Set<string>([
      ...this.highlightedFileUris,
      ...this.highlightedFolderUris
    ]));
  }

  async refreshFile(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== 'file') {
      return;
    }

    const branch = await getGitBranchName(uri);
    const fileKey = getFileBranchKey(uri.toString(), branch);
    const highlights = removeEmptyHighlights(fileHighlights.get(fileKey) ?? loadHighlights(uri.toString(), branch));
    this.setFileHighlightState(uri, highlights.length > 0);
  }

  async applyKnownHighlights(uri: vscode.Uri, branch: string, highlights: HighlightEntry[]): Promise<void> {
    if (uri.scheme !== 'file') {
      return;
    }

    const currentBranch = await getGitBranchName(uri);
    if (currentBranch !== branch) {
      await this.refreshFile(uri);
      return;
    }

    this.setFileHighlightState(uri, removeEmptyHighlights(highlights).length > 0);
  }

  async rebuildFromCurrentBranchState(): Promise<void> {
    const previousFiles = this.highlightedFileUris;
    const previousFolders = this.highlightedFolderUris;

    const nextFiles = await this.collectHighlightedFilesForCurrentBranch();
    const {
      folderUris: nextFolders,
      fileAncestorFolders: nextFileAncestors,
      folderHighlightCounts: nextFolderCounts
    } = this.buildFolderState(nextFiles);

    this.highlightedFileUris = nextFiles;
    this.highlightedFolderUris = nextFolders;
    this.fileAncestorFolders = nextFileAncestors;
    this.folderHighlightCounts = nextFolderCounts;

    const changedUriStrings = this.getChangedUriStrings(previousFiles, this.highlightedFileUris);
    for (const folderUri of this.getChangedUriStrings(previousFolders, this.highlightedFolderUris)) {
      changedUriStrings.add(folderUri);
    }

    this.emitChangedUriStrings(changedUriStrings);
  }

  dispose(): void {
    this.onDidChangeFileDecorationsEmitter.dispose();
  }

  private async collectHighlightedFilesForCurrentBranch(): Promise<Set<string>> {
    const highlightedUris = new Set<string>();
    const branchByUri = new Map<string, string>();
    const inMemoryOverrides = new Map<string, boolean>();

    const getCurrentBranchForUri = async (uriString: string): Promise<string | undefined> => {
      if (branchByUri.has(uriString)) {
        return branchByUri.get(uriString);
      }

      try {
        const uri = vscode.Uri.parse(uriString);
        if (uri.scheme !== 'file') {
          return undefined;
        }

        const branch = await getGitBranchName(uri);
        branchByUri.set(uriString, branch);
        return branch;
      } catch {
        return undefined;
      }
    };

    const storageKeys = extensionContext.globalState.keys().filter(key => key.startsWith(HIGHLIGHT_STORAGE_PREFIX));
    for (const key of storageKeys) {
      const uriString = key.slice(HIGHLIGHT_STORAGE_PREFIX.length);
      const branch = await getCurrentBranchForUri(uriString);
      if (!branch) {
        continue;
      }

      const stored = extensionContext.globalState.get<unknown>(key);
      if (Array.isArray(stored)) {
        if ((stored as SerializedHighlight[]).length > 0) {
          highlightedUris.add(uriString);
        }
        continue;
      }

      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        const branchStore = stored as BranchScopedHighlightStore;
        const branchHighlights = branchStore[branch];
        if (Array.isArray(branchHighlights) && branchHighlights.length > 0) {
          highlightedUris.add(uriString);
        }
      }
    }

    for (const [fileKey, highlights] of fileHighlights.entries()) {
      const separatorIndex = fileKey.indexOf('::');
      if (separatorIndex < 0) {
        continue;
      }

      const branchInKey = fileKey.slice(0, separatorIndex);
      const uriString = fileKey.slice(separatorIndex + 2);
      const currentBranch = await getCurrentBranchForUri(uriString);
      if (!currentBranch || currentBranch !== branchInKey) {
        continue;
      }

      inMemoryOverrides.set(uriString, removeEmptyHighlights(highlights).length > 0);
    }

    for (const [uriString, hasHighlights] of inMemoryOverrides.entries()) {
      if (hasHighlights) {
        highlightedUris.add(uriString);
      } else {
        highlightedUris.delete(uriString);
      }
    }

    return highlightedUris;
  }

  private buildFolderState(fileUris: Set<string>): {
    folderUris: Set<string>;
    fileAncestorFolders: Map<string, string[]>;
    folderHighlightCounts: Map<string, number>;
  } {
    const folderUris = new Set<string>();
    const fileAncestorFolders = new Map<string, string[]>();
    const folderHighlightCounts = new Map<string, number>();

    for (const fileUriString of fileUris) {
      let parsedUri: vscode.Uri;
      try {
        parsedUri = vscode.Uri.parse(fileUriString);
      } catch {
        continue;
      }

      const ancestors = this.getAncestorFolderUris(parsedUri);
      fileAncestorFolders.set(fileUriString, ancestors);

      for (const folderUriString of ancestors) {
        const nextCount = (folderHighlightCounts.get(folderUriString) ?? 0) + 1;
        folderHighlightCounts.set(folderUriString, nextCount);
        folderUris.add(folderUriString);
      }
    }

    return { folderUris, fileAncestorFolders, folderHighlightCounts };
  }

  private setFileHighlightState(uri: vscode.Uri, hasHighlights: boolean): void {
    const uriString = this.toCanonicalUriString(uri);
    const changedUriStrings = new Set<string>();

    if (hasHighlights) {
      this.addHighlightedFileUri(uriString, changedUriStrings);
    } else {
      this.removeHighlightedFileUri(uriString, changedUriStrings);
    }

    this.emitChangedUriStrings(changedUriStrings);
  }

  private addHighlightedFileUri(fileUriString: string, changedUriStrings: Set<string>): void {
    let canonicalFileUriString = fileUriString;
    try {
      canonicalFileUriString = this.toCanonicalUriString(vscode.Uri.parse(fileUriString));
    } catch {
      // Keep original URI key if parsing fails.
    }

    if (this.highlightedFileUris.has(canonicalFileUriString)) {
      return;
    }

    this.highlightedFileUris.add(canonicalFileUriString);
    changedUriStrings.add(canonicalFileUriString);

    let fileUri: vscode.Uri;
    try {
      fileUri = vscode.Uri.parse(canonicalFileUriString);
    } catch {
      return;
    }

    const ancestors = this.getAncestorFolderUris(fileUri);
    this.fileAncestorFolders.set(canonicalFileUriString, ancestors);

    for (const folderUriString of ancestors) {
      const previousCount = this.folderHighlightCounts.get(folderUriString) ?? 0;
      const nextCount = previousCount + 1;
      this.folderHighlightCounts.set(folderUriString, nextCount);

      if (previousCount === 0) {
        this.highlightedFolderUris.add(folderUriString);
        changedUriStrings.add(folderUriString);
      }
    }
  }

  private removeHighlightedFileUri(fileUriString: string, changedUriStrings: Set<string>): void {
    let canonicalFileUriString = fileUriString;
    try {
      canonicalFileUriString = this.toCanonicalUriString(vscode.Uri.parse(fileUriString));
    } catch {
      // Keep original URI key if parsing fails.
    }

    if (!this.highlightedFileUris.delete(canonicalFileUriString)) {
      return;
    }

    changedUriStrings.add(canonicalFileUriString);

    const ancestors = this.fileAncestorFolders.get(canonicalFileUriString) ?? [];
    this.fileAncestorFolders.delete(canonicalFileUriString);

    for (const folderUriString of ancestors) {
      const previousCount = this.folderHighlightCounts.get(folderUriString) ?? 0;
      if (previousCount <= 1) {
        this.folderHighlightCounts.delete(folderUriString);
        if (this.highlightedFolderUris.delete(folderUriString)) {
          changedUriStrings.add(folderUriString);
        }
      } else {
        this.folderHighlightCounts.set(folderUriString, previousCount - 1);
      }
    }
  }

  private getAncestorFolderUris(fileUri: vscode.Uri): string[] {
    const ancestors: string[] = [];
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);

    let currentPath = path.dirname(fileUri.fsPath);
    const workspaceRootPath = workspaceFolder?.uri.fsPath;

    while (true) {
      ancestors.push(this.toCanonicalUriString(vscode.Uri.file(currentPath)));

      if (workspaceRootPath && path.normalize(currentPath) === path.normalize(workspaceRootPath)) {
        break;
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        break;
      }

      currentPath = parentPath;
    }

    return ancestors;
  }

  private getChangedUriStrings(previous: Set<string>, next: Set<string>): Set<string> {
    const changed = new Set<string>();

    for (const uriString of previous) {
      if (!next.has(uriString)) {
        changed.add(uriString);
      }
    }

    for (const uriString of next) {
      if (!previous.has(uriString)) {
        changed.add(uriString);
      }
    }

    return changed;
  }

  private emitChangedUriStrings(changedUriStrings: Set<string>): void {
    if (changedUriStrings.size === 0) {
      return;
    }

    const changedUris = Array.from(changedUriStrings).map(uriString => vscode.Uri.parse(uriString));
    this.onDidChangeFileDecorationsEmitter.fire(changedUris);
  }
}

function isUriInWorkspaceFolder(uri: vscode.Uri, folder: vscode.WorkspaceFolder): boolean {
  const folderPath = folder.uri.path.endsWith('/') ? folder.uri.path : `${folder.uri.path}/`;
  return uri.path === folder.uri.path || uri.path.startsWith(folderPath);
}

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

function getInsertedEndPosition(start: vscode.Position, insertedText: string): vscode.Position {
  if (insertedText.length === 0) {
    return start;
  }

  const lines = insertedText.split('\n');
  if (lines.length === 1) {
    return new vscode.Position(start.line, start.character + lines[0].length);
  }

  return new vscode.Position(start.line + lines.length - 1, lines[lines.length - 1].length);
}

function shiftPositionAfterChange(
  position: vscode.Position,
  oldEnd: vscode.Position,
  newEnd: vscode.Position
): vscode.Position {
  const lineDelta = newEnd.line - oldEnd.line;
  if (lineDelta === 0) {
    if (position.line !== oldEnd.line) {
      return position;
    }

    return new vscode.Position(position.line, position.character + (newEnd.character - oldEnd.character));
  }

  if (position.line === oldEnd.line) {
    return new vscode.Position(position.line + lineDelta, newEnd.character + (position.character - oldEnd.character));
  }

  return new vscode.Position(position.line + lineDelta, position.character);
}

function rebaseRangeForContentChange(range: vscode.Range, change: vscode.TextDocumentContentChangeEvent): vscode.Range | null {
  const changeStart = change.range.start;
  const changeOldEnd = change.range.end;
  const changeNewEnd = getInsertedEndPosition(changeStart, change.text);
  const isPureInsertion = change.rangeLength === 0;

  if (isPureInsertion) {
    if (changeStart.isBeforeOrEqual(range.start)) {
      return new vscode.Range(
        shiftPositionAfterChange(range.start, changeOldEnd, changeNewEnd),
        shiftPositionAfterChange(range.end, changeOldEnd, changeNewEnd)
      );
    }

    if (changeStart.isAfter(range.start) && changeStart.isBefore(range.end)) {
      return new vscode.Range(range.start, shiftPositionAfterChange(range.end, changeOldEnd, changeNewEnd));
    }

    return range;
  }

  // No overlap with replaced/deleted segment.
  if (range.end.isBeforeOrEqual(changeStart)) {
    return range;
  }
  if (range.start.isAfterOrEqual(changeOldEnd)) {
    return new vscode.Range(
      shiftPositionAfterChange(range.start, changeOldEnd, changeNewEnd),
      shiftPositionAfterChange(range.end, changeOldEnd, changeNewEnd)
    );
  }

  const newStart = range.start.isBefore(changeStart)
    ? range.start
    : (range.start.isAfter(changeOldEnd)
      ? shiftPositionAfterChange(range.start, changeOldEnd, changeNewEnd)
      : changeStart);

  const newEnd = range.end.isAfter(changeOldEnd)
    ? shiftPositionAfterChange(range.end, changeOldEnd, changeNewEnd)
    : changeNewEnd;

  if (newStart.isAfterOrEqual(newEnd)) {
    return null;
  }

  return new vscode.Range(newStart, newEnd);
}

function rebaseHighlightsForDocumentChanges(
  highlights: HighlightEntry[],
  changes: readonly vscode.TextDocumentContentChangeEvent[]
): HighlightEntry[] {
  let rebased = highlights;

  for (const change of changes) {
    rebased = rebased
      .map(highlight => {
        const range = rebaseRangeForContentChange(highlight.range, change);
        return range ? { color: highlight.color, range } : null;
      })
      .filter((highlight): highlight is HighlightEntry => highlight !== null);
  }

  return rebased;
}

function areHighlightsEqual(a: HighlightEntry[], b: HighlightEntry[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i += 1) {
    if (a[i].color !== b[i].color || !a[i].range.isEqual(b[i].range)) {
      return false;
    }
  }

  return true;
}

function removeEmptyHighlights(highlights: HighlightEntry[]): HighlightEntry[] {
  return highlights.filter(h => !h.range.isEmpty);
}

function clearEditorDecorations(editor: vscode.TextEditor): void {
  decorationStyles.forEach(style => editor.setDecorations(style, []));
}

function cancelPendingPersistenceTimers(): void {
  persistTimersByFileKey.forEach(timer => clearTimeout(timer));
  persistTimersByFileKey.clear();
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
    highlights = removeEmptyHighlights(loadHighlights(uri, branch));
    fileHighlights.set(fileKey, highlights);
  }

  return { branch, fileKey, highlights };
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  const highlightDecorationProvider = new HighlightDecorationProvider();
  context.subscriptions.push(
    highlightDecorationProvider,
    vscode.window.registerFileDecorationProvider(highlightDecorationProvider)
  );
  void highlightDecorationProvider.rebuildFromCurrentBranchState();

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

  function schedulePersistHighlights(uri: string, branch: string, fileKey: string, highlights: HighlightEntry[]): void {
    const existingTimer = persistTimersByFileKey.get(fileKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      void saveHighlights(uri, branch, highlights);
      persistTimersByFileKey.delete(fileKey);
    }, 200);

    persistTimersByFileKey.set(fileKey, timer);
  }

  async function refreshVisibleEditorsFromBranchState(): Promise<void> {
    if (!highlightDisplayEnabled) {
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
      void (async () => {
        await highlightDecorationProvider.rebuildFromCurrentBranchState();
        await refreshVisibleEditorsFromBranchState();
      })();
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
    highlightDisplayEnabled = true;
    highlightDecorationProvider.setDecorationsEnabled(true);
    await highlightDecorationProvider.rebuildFromCurrentBranchState();
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
      await highlightDecorationProvider.applyKnownHighlights(editor.document.uri, branch, highlights);
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
      const colorMap: Record<string, string> = {
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
      await highlightDecorationProvider.applyKnownHighlights(editor.document.uri, branch, []);
      // Clear persisted highlights
      await saveHighlights(uri, branch, []);
      clearEditorDecorations(editor);
      await highlightDecorationProvider.rebuildFromCurrentBranchState();

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

  // Command to stop highlight mode without removing existing highlights
  const stopCommand = vscode.commands.registerCommand('extension.stopHighlighting', async () => {
    highlightingActive = false;
    highlightDisplayEnabled = true;

    vscode.window.showInformationMessage('Highlighting mode stopped. Existing highlights are preserved.');
  });

  // Command to stop highlight mode and clear active editor decorations only
  const stopAndClearCommand = vscode.commands.registerCommand('extension.stopAndClearHighlights', async () => {
    highlightingActive = false;
    highlightDisplayEnabled = false;

    // Clear in-memory highlights so next start reloads from persisted storage.
    fileHighlights.clear();
    highlightDecorationProvider.setDecorationsEnabled(false);

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

    vscode.window.showInformationMessage('Highlighting mode stopped and visible highlights were cleared. Run Start Highlighting to restore saved highlights.');
  });

  // Command to permanently delete highlights only for the current branch
  const clearAllHighlightsForCurrentBranch = async (): Promise<void> => {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      vscode.window.showWarningMessage('Open a file in the branch you want to clear permanently.');
      return;
    }

    const targetBranch = await getGitBranchName(activeEditor.document.uri);
    highlightingActive = false;
    highlightDisplayEnabled = true;
    lastSelectionKey = '';

    if (selectionStableTimer) {
      clearTimeout(selectionStableTimer);
      selectionStableTimer = null;
    }

    cancelPendingPersistenceTimers();

    const allKeys = extensionContext.globalState.keys();
    let changedFiles = 0;
    for (const key of allKeys) {
      if (key.startsWith(HIGHLIGHT_STORAGE_PREFIX)) {
        const stored = extensionContext.globalState.get<unknown>(key);

        // Legacy format (pre-branch) is treated as current-branch data.
        if (Array.isArray(stored)) {
          await extensionContext.globalState.update(key, {});
          changedFiles += 1;
          continue;
        }

        if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
          const branchStore = { ...(stored as BranchScopedHighlightStore) };
          if (targetBranch in branchStore) {
            delete branchStore[targetBranch];
            await extensionContext.globalState.update(key, branchStore);
            changedFiles += 1;
          }
        }
      }
    }

    for (const fileKey of Array.from(fileHighlights.keys())) {
      if (fileKey.startsWith(`${targetBranch}::`)) {
        fileHighlights.delete(fileKey);
      }
    }

    for (const fileKey of Array.from(blankLineAddedByExtension.keys())) {
      if (fileKey.startsWith(`${targetBranch}::`)) {
        blankLineAddedByExtension.delete(fileKey);
      }
    }

    await highlightDecorationProvider.rebuildFromCurrentBranchState();

    for (const editor of vscode.window.visibleTextEditors) {
      const branch = await getGitBranchName(editor.document.uri);
      if (branch !== targetBranch) {
        continue;
      }

      const uri = editor.document.uri.toString();
      clearEditorDecorations(editor);
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

    vscode.window.showInformationMessage(`Permanently deleted highlights for branch "${targetBranch}" in ${changedFiles} file(s).`);
  };

  const clearAllHighlightsPermanentlyCommand = vscode.commands.registerCommand('extension.clearAllHighlightsPermanently', async () => {
    await clearAllHighlightsForCurrentBranch();
  });

  const clearAllHighlightsForCurrentBranchCommand = vscode.commands.registerCommand('extension.clearAllHighlightsForCurrentBranch', async () => {
    await clearAllHighlightsForCurrentBranch();
  });

  // Command to reset highlight extension data for current folder across all branches
  const resetHighlightsForCurrentFolderCommand = vscode.commands.registerCommand('extension.resetHighlightsForCurrentFolder', async () => {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      vscode.window.showWarningMessage('Open a file in the folder you want to reset.');
      return;
    }

    const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
    if (!folder) {
      vscode.window.showWarningMessage('Active file is not inside a workspace folder.');
      return;
    }

    highlightingActive = false;
    highlightDisplayEnabled = true;

    const allKeys = extensionContext.globalState.keys();
    let clearedFiles = 0;
    for (const key of allKeys) {
      if (!key.startsWith(HIGHLIGHT_STORAGE_PREFIX)) {
        continue;
      }

      const uriString = key.slice(HIGHLIGHT_STORAGE_PREFIX.length);

      try {
        const fileUri = vscode.Uri.parse(uriString);
        if (!isUriInWorkspaceFolder(fileUri, folder)) {
          continue;
        }

        await extensionContext.globalState.update(key, undefined);
        clearedFiles += 1;
      } catch {
        // Ignore malformed keys and continue.
      }
    }

    for (const fileKey of Array.from(fileHighlights.keys())) {
      const separatorIndex = fileKey.indexOf('::');
      if (separatorIndex < 0) {
        continue;
      }

      const uriString = fileKey.slice(separatorIndex + 2);
      try {
        const fileUri = vscode.Uri.parse(uriString);
        if (isUriInWorkspaceFolder(fileUri, folder)) {
          fileHighlights.delete(fileKey);
        }
      } catch {
        // Ignore malformed in-memory keys and continue.
      }
    }
    await highlightDecorationProvider.rebuildFromCurrentBranchState();

    for (const editor of vscode.window.visibleTextEditors) {
      if (!isUriInWorkspaceFolder(editor.document.uri, folder)) {
        continue;
      }

      const uri = editor.document.uri.toString();
      const branch = await getGitBranchName(editor.document.uri);
      const fileKey = getFileBranchKey(uri, branch);

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
    }

    vscode.window.showInformationMessage(`Highlight-It reset complete for folder "${folder.name}". Cleared all saved highlights.`);
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
      if (!highlightingActive) {
        return;
      }

      const branch = await getGitBranchName(editor.document.uri);
      if (!highlightingActive) {
        return;
      }

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
      await highlightDecorationProvider.applyKnownHighlights(editor.document.uri, branch, highlights);

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
    if (editor && highlightDisplayEnabled) {
      const { highlights } = await getHighlightsForEditor(editor);
      applyHighlightsToEditor(editor, highlights);
    }
  });

  const openDocumentListener = vscode.workspace.onDidOpenTextDocument((document) => {
    void highlightDecorationProvider.refreshFile(document.uri);
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
    if (!highlightDisplayEnabled) {
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

  // Rebase highlight ranges so they move with edits and persist the updated positions.
  const documentChangeListener = vscode.workspace.onDidChangeTextDocument(async (event) => {
    if (event.contentChanges.length === 0) {
      return;
    }

    const eventVersion = event.document.version;
    const uri = event.document.uri.toString();
    const branch = await getGitBranchName(event.document.uri);

    const liveDocument = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri);
    if (liveDocument && liveDocument.version !== eventVersion) {
      // A newer edit was already applied while this async handler was waiting.
      return;
    }

    const fileKey = getFileBranchKey(uri, branch);

    let highlights = fileHighlights.get(fileKey);
    if (!highlights) {
      highlights = loadHighlights(uri, branch);
      if (highlights.length === 0) {
        return;
      }
    }

    const rebasedHighlights = removeEmptyHighlights(rebaseHighlightsForDocumentChanges(highlights, event.contentChanges));
    if (!areHighlightsEqual(highlights, rebasedHighlights)) {
      fileHighlights.set(fileKey, rebasedHighlights);
      await highlightDecorationProvider.applyKnownHighlights(event.document.uri, branch, rebasedHighlights);
      schedulePersistHighlights(uri, branch, fileKey, rebasedHighlights);
    }

    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uri) {
        applyHighlightsToEditor(editor, rebasedHighlights);
      }
    }
  });

  // Register all commands and listeners
  context.subscriptions.push(
    startCommand,
    setColorCommand,
    clearCommand,
    stopCommand,
    stopAndClearCommand,
    clearAllHighlightsPermanentlyCommand,
    clearAllHighlightsForCurrentBranchCommand,
    resetHighlightsForCurrentFolderCommand,
    selectionListener,
    editorChangeListener,
    openDocumentListener,
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
  persistTimersByFileKey.forEach(timer => clearTimeout(timer));
  persistTimersByFileKey.clear();
}
