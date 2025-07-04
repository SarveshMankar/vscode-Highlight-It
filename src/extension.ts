import * as vscode from 'vscode';

let decorationType: vscode.TextEditorDecorationType;
let currentColor = 'rgba(255, 0, 0, 0.7)'; // Default highlight color
let fileHighlights: Map<string, vscode.Range[]> = new Map();
let highlightingActive = false;
let selectionStableTimer: NodeJS.Timeout | null = null;
let lastSelectionKey = '';
/**
 * This extension allows users to highlight text selections in VS Code.
 * It supports toggling highlights, clearing highlights for the current file,
 * and stopping the highlight mode entirely.
 */

export function activate(context: vscode.ExtensionContext) {
  vscode.window.showInformationMessage('Highlight extension ready.');

  function createDecorationType(color: string): vscode.TextEditorDecorationType {
    return vscode.window.createTextEditorDecorationType({
      backgroundColor: color,
      border: '1px solid darkred',
      borderRadius: '3px'
    });
  }

  decorationType = createDecorationType(currentColor);

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

  const setColorCommand = vscode.commands.registerCommand('extension.setHighlightColor', async () => {
    const picked = await vscode.window.showQuickPick(
      ['red', 'yellow', 'green', 'blue', 'pink', 'orange'],
      { placeHolder: 'Pick a highlight color' }
    );

    if (picked) {
      const colorMap: any = {
        red: 'rgba(255, 0, 0, 0.7)',
        yellow: 'rgba(255, 255, 0, 0.7)',
        green: 'rgba(0, 255, 0, 0.7)',
        blue: 'rgba(0, 0, 255, 0.7)',
        pink: 'rgba(255, 105, 180, 0.7)',
        orange: 'rgba(255, 165, 0, 0.7)'
      };

      currentColor = colorMap[picked];
      decorationType.dispose();
      decorationType = createDecorationType(currentColor);
      vscode.window.showInformationMessage(`Highlight color set to ${picked}`);

      // Re-apply highlights for all visible editors
      vscode.window.visibleTextEditors.forEach(editor => {
        const uri = editor.document.uri.toString();
        const ranges = fileHighlights.get(uri) || [];
        editor.setDecorations(decorationType, ranges);
      });
    }
  });

  // Clear highlights for current file only
  const clearCommand = vscode.commands.registerCommand('extension.clearHighlights', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && decorationType) {
      const uri = editor.document.uri.toString();
      fileHighlights.set(uri, []);
      editor.setDecorations(decorationType, []);
      vscode.window.showInformationMessage('Cleared highlights for current file (still in highlight mode).');
    }
  });

  // Stop highlight mode and clear all highlights
  const stopCommand = vscode.commands.registerCommand('extension.stopHighlighting', () => {
    highlightingActive = false;
    fileHighlights.clear();

    vscode.window.visibleTextEditors.forEach(editor => {
      editor.setDecorations(decorationType, []);
    });

    vscode.window.showInformationMessage('Stopped highlight mode and cleared all highlights.');
  });

  // Toggle logic on selection
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
      let highlights = fileHighlights.get(uri) || [];

      selections.forEach(sel => {
        const newRange = new vscode.Range(sel.start, sel.end);
        const result: vscode.Range[] = [];

        let isExactMatch = false;

        for (const existing of highlights) {
          if (existing.isEqual(newRange)) {
            // Exact match -> remove
            isExactMatch = true;
            continue;
          }

          const intersection = existing.intersection(newRange);

          if (!intersection) {
            result.push(existing); // No overlap -> keep as is
          } else {
            // Partial overlap -> remove overlapping part
            if (existing.start.isBefore(intersection.start)) {
              result.push(new vscode.Range(existing.start, intersection.start));
            }
            if (existing.end.isAfter(intersection.end)) {
              result.push(new vscode.Range(intersection.end, existing.end));
            }
          }
        }

        if (!isExactMatch) {
          // Only add newRange if it's not already fully inside any existing highlight
          const alreadyFullyCovered = highlights.some(h => h.contains(newRange));
          if (!alreadyFullyCovered) {
            result.push(newRange);
          }
        }

        highlights = result;
      });

      fileHighlights.set(uri, highlights);

      // Ensure file ends with a blank line
      const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
      if (!lastLine.isEmptyOrWhitespace) {
        await editor.edit(editBuilder => {
          editBuilder.insert(new vscode.Position(editor.document.lineCount, 0), '\n');
        });
        vscode.window.showInformationMessage('Blank line added at end of file.');
      }

      editor.setDecorations(decorationType, highlights);
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

  context.subscriptions.push(
    startCommand,
    setColorCommand,
    clearCommand,
    stopCommand,
    selectionListener,
    editorChangeListener
  );
}

export function deactivate() {
  if (decorationType) decorationType.dispose();
  if (selectionStableTimer) clearTimeout(selectionStableTimer);
}
