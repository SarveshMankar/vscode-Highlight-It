import * as vscode from 'vscode';

// Current selected color for highlighting (default is red)
let currentColor = 'rgba(255, 0, 0, 0.7)';

// Map to store decoration types by color
let decorationStyles: Map<string, vscode.TextEditorDecorationType> = new Map();

// Map to store highlights by file URI, each with its associated color and range
let fileHighlights: Map<string, { color: string; range: vscode.Range }[]> = new Map();

// Toggle state and timers for selection stability
let highlightingActive = false;
let selectionStableTimer: NodeJS.Timeout | null = null;
let lastSelectionKey = '';

export function activate(context: vscode.ExtensionContext) {
  vscode.window.showInformationMessage('Highlight extension ready.');

  // Returns or creates a decoration type for a given color
  function getDecorationType(color: string): vscode.TextEditorDecorationType {
    if (!decorationStyles.has(color)) {
      decorationStyles.set(color, vscode.window.createTextEditorDecorationType({
        backgroundColor: color,
        isWholeLine: false, // prevent full line coloring
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        borderRadius: '3px'
      }));
    }
    return decorationStyles.get(color)!;
  }

  // Command to start highlight mode
  const startCommand = vscode.commands.registerCommand('extension.highlightSelection', async () => {
    highlightingActive = true;
    const editor = vscode.window.activeTextEditor;

    if (editor) {
      // Add blank line at end if last line isn't blank
      const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
      if (!lastLine.isEmptyOrWhitespace) {
        await editor.edit(editBuilder => {
          editBuilder.insert(new vscode.Position(editor.document.lineCount, 0), '\n');
        });
        vscode.window.showInformationMessage('Blank line added at end of file.');
      }

      const uri = editor.document.uri.toString();
      const highlights = fileHighlights.get(uri) || [];

      // Apply decorations grouped by color
      const colorsInUse = new Set(highlights.map(h => h.color));
      colorsInUse.forEach(color => {
        const ranges = highlights.filter(h => h.color === color).map(h => h.range);
        const style = getDecorationType(color);
        editor.setDecorations(style, ranges);
      });
    }

    vscode.window.showInformationMessage('Highlighting mode started. Select text to toggle highlights.');
  });

  // Command to set the highlight color
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
      getDecorationType(currentColor); // Ensure decoration type is created
      vscode.window.showInformationMessage(`Highlight color set to ${picked}`);
    }
  });

  // Command to clear highlights for the current file
  const clearCommand = vscode.commands.registerCommand('extension.clearHighlights', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const uri = editor.document.uri.toString();
      fileHighlights.set(uri, []);
      decorationStyles.forEach(style => editor.setDecorations(style, []));
      vscode.window.showInformationMessage('Cleared highlights for current file (still in highlight mode).');
    }
  });

  // Command to stop highlight mode and clear all highlights across files
  const stopCommand = vscode.commands.registerCommand('extension.stopHighlighting', () => {
    highlightingActive = false;
    fileHighlights.clear();

    vscode.window.visibleTextEditors.forEach(editor => {
      decorationStyles.forEach(style => editor.setDecorations(style, []));
    });

    vscode.window.showInformationMessage('Stopped highlight mode and cleared all highlights.');
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
      let highlights = fileHighlights.get(uri) || [];

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
            // Partial overlap → trim existing range
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

      fileHighlights.set(uri, highlights);

      // Add blank line if needed
      const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
      if (!lastLine.isEmptyOrWhitespace) {
        await editor.edit(editBuilder => {
          editBuilder.insert(new vscode.Position(editor.document.lineCount, 0), '\n');
        });
        vscode.window.showInformationMessage('Blank line added at end of file.');
      }

      const colorsInUse = new Set(highlights.map(h => h.color));
      colorsInUse.forEach(color => {
        const ranges = highlights.filter(h => h.color === color).map(h => h.range);
        const style = getDecorationType(color);
        editor.setDecorations(style, ranges);
      });
    }, 300);
  });

  // Listener to reapply highlights when switching between files
  const editorChangeListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      const uri = editor.document.uri.toString();
      const highlights = fileHighlights.get(uri) || [];
      const colorsInUse = new Set(highlights.map(h => h.color));
      colorsInUse.forEach(color => {
        const ranges = highlights.filter(h => h.color === color).map(h => h.range);
        const style = getDecorationType(color);
        editor.setDecorations(style, ranges);
      });
    }
  });

  // Register all commands and listeners
  context.subscriptions.push(
    startCommand,
    setColorCommand,
    clearCommand,
    stopCommand,
    selectionListener,
    editorChangeListener
  );
}

// Dispose decorations and timers on deactivation
export function deactivate() {
  decorationStyles.forEach(style => style.dispose());
  if (selectionStableTimer) clearTimeout(selectionStableTimer);
}
