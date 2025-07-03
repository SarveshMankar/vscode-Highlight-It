import * as vscode from 'vscode';

let decorationType: vscode.TextEditorDecorationType;
let fileHighlights: Map<string, vscode.Range[]> = new Map();
let highlightingActive = false;
let selectionStableTimer: NodeJS.Timeout | null = null;
let lastSelectionKey = '';

export function activate(context: vscode.ExtensionContext) {
  vscode.window.showInformationMessage('Highlight extension ready.');

  decorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 0, 0, 0.4)',
    border: '1px solid darkred',
    borderRadius: '3px'
  });

  // Start highlighting mode
  const startCommand = vscode.commands.registerCommand('extension.highlightSelection', async () => {
    highlightingActive = true;
    const editor = vscode.window.activeTextEditor;

    if (editor) {
      const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
      if (!lastLine.isEmptyOrWhitespace) {
        await editor.edit(editBuilder => {
          editBuilder.insert(new vscode.Position(editor.document.lineCount, 0), '\n');
        });
        vscode.window.showInformationMessage('Blank line added at end of file.');
      }

      // Reapply highlights for this file
      const uri = editor.document.uri.toString();
      const ranges = fileHighlights.get(uri) || [];
      editor.setDecorations(decorationType, ranges);
    }

    vscode.window.showInformationMessage('Highlighting mode started. Select text to highlight.');
  });

  // Clear highlights for current file
  const clearCommand = vscode.commands.registerCommand('extension.clearHighlights', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && decorationType) {
      const uri = editor.document.uri.toString();
      fileHighlights.set(uri, []);
      editor.setDecorations(decorationType, []);
      highlightingActive = false;
      vscode.window.showInformationMessage('Highlights cleared.');
    }
  });

  // Add highlights after mouse/touchpad release (debounced)
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

    selectionStableTimer = setTimeout(() => {
      const frozenRanges = selections.map(sel => {
        const start = new vscode.Position(sel.start.line, sel.start.character);
        const end = new vscode.Position(sel.end.line, sel.end.character);
        return new vscode.Range(start, end);
      });

      // Store per-file highlights
      const prev = fileHighlights.get(uri) || [];
      const updated = [...prev, ...frozenRanges];
      fileHighlights.set(uri, updated);
      editor.setDecorations(decorationType, updated);

      const selectedText = editor.document.getText(selections[0]);
      vscode.window.showInformationMessage(`Highlighted: ${selectedText}`);
    }, 300);
  });

  // Reapply highlights when switching editors
  const editorChangeListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor && decorationType) {
      const uri = editor.document.uri.toString();
      const ranges = fileHighlights.get(uri) || [];
      editor.setDecorations(decorationType, ranges);
    }
  });

  context.subscriptions.push(startCommand, clearCommand, selectionListener, editorChangeListener);
}

export function deactivate() {
  if (decorationType) decorationType.dispose();
  if (selectionStableTimer) clearTimeout(selectionStableTimer);
}
