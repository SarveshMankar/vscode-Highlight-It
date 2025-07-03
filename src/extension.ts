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

      const uri = editor.document.uri.toString();
      const ranges = fileHighlights.get(uri) || [];
      editor.setDecorations(decorationType, ranges);
    }

    vscode.window.showInformationMessage('Highlighting mode started. Select text to toggle highlights.');
  });

  // Clears current file's highlights only
  const clearCommand = vscode.commands.registerCommand('extension.clearHighlights', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && decorationType) {
      const uri = editor.document.uri.toString();
      fileHighlights.set(uri, []);
      editor.setDecorations(decorationType, []);
      vscode.window.showInformationMessage('Cleared highlights for current file (still in highlight mode).');
    }
  });

  // Stops all highlighting and clears all files
  const stopCommand = vscode.commands.registerCommand('extension.stopHighlighting', () => {
    highlightingActive = false;
    fileHighlights.clear();

    if (decorationType) {
      vscode.window.visibleTextEditors.forEach(editor => {
        editor.setDecorations(decorationType!, []);
      });
    }

    vscode.window.showInformationMessage('Stopped highlight mode and cleared all highlights.');
  });

  // Selection logic
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
      let highlights = fileHighlights.get(uri) || [];

      selections.forEach(sel => {
        const newRange = new vscode.Range(sel.start, sel.end);
        let updated: vscode.Range[] = [];

        for (const existing of highlights) {
          const intersection = existing.intersection(newRange);

          // Keep if existing is fully inside the new one
          if (newRange.contains(existing.start) && newRange.contains(existing.end)) {
            updated.push(existing);
          }
          // Remove overlapping part only
          else if (intersection) {
            if (existing.start.isBefore(intersection.start)) {
              updated.push(new vscode.Range(existing.start, intersection.start));
            }
            if (existing.end.isAfter(intersection.end)) {
              updated.push(new vscode.Range(intersection.end, existing.end));
            }
          }
          // No overlap → keep
          else {
            updated.push(existing);
          }
        }

        const alreadyCovered = highlights.some(h => h.contains(newRange));
        if (!alreadyCovered) {
          updated.push(newRange);
        }

        highlights = updated;
      });

      fileHighlights.set(uri, highlights);
      editor.setDecorations(decorationType, highlights);

      vscode.window.showInformationMessage('Toggled highlight(s).');
    }, 300);
  });

  // Reapply highlights on editor switch
  const editorChangeListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor && decorationType) {
      const uri = editor.document.uri.toString();
      const ranges = fileHighlights.get(uri) || [];
      editor.setDecorations(decorationType, ranges);
    }
  });

  context.subscriptions.push(startCommand, clearCommand, stopCommand, selectionListener, editorChangeListener);
}

export function deactivate() {
  if (decorationType) decorationType.dispose();
  if (selectionStableTimer) clearTimeout(selectionStableTimer);
}
