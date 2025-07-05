import * as vscode from 'vscode';

// Current selected color for highlighting (default is red)
let currentColor = 'rgba(255, 0, 0, 0.7)';

// Map to store decoration types by color
let decorationStyles: Map<string, vscode.TextEditorDecorationType> = new Map();

// Map to store highlights by file URI, each with its associated color and range
let fileHighlights: Map<string, { color: string; range: vscode.Range }[]> = new Map();

// Map to track if a blank line was added by the extension for each file
let blankLineAddedByExtension: Map<string, boolean> = new Map();

// Toggle state and timers for selection stability
let highlightingActive = false;
let selectionStableTimer: NodeJS.Timeout | null = null;
let lastSelectionKey = '';

export function activate(context: vscode.ExtensionContext) {
  // Returns or creates a decoration type for a given color
  function getDecorationType(color: string): vscode.TextEditorDecorationType {
    if (!decorationStyles.has(color)) {
      decorationStyles.set(color, vscode.window.createTextEditorDecorationType({
        backgroundColor: color,
        isWholeLine: false,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        borderRadius: '3px',
        overviewRulerColor: color,
        overviewRulerLane: vscode.OverviewRulerLane.Full
      }));
    }
    return decorationStyles.get(color)!;
  }

  // Command to start highlight mode
  const startCommand = vscode.commands.registerCommand('extension.startHighlighting', async () => {
    highlightingActive = true;
    const editor = vscode.window.activeTextEditor;

    if (editor) {
      const uri = editor.document.uri.toString();
      const highlights = fileHighlights.get(uri) || [];

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
          blankLineAddedByExtension.set(uri, true);
          // vscode.window.showInformationMessage('Blank line added at end of file.');
        }
      }

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
      ['Red', 'Yellow', 'Green', 'Blue', 'Pink', 'Orange'],
      { placeHolder: 'Pick a highlight color' }
    );

    if (picked) {
      const colorMap: any = {
        Red: 'rgba(255, 0, 0, 0.7)',
        Yellow: 'rgba(255, 255, 0, 0.7)',
        Green: 'rgba(0, 255, 0, 0.7)',
        Blue: 'rgba(0, 0, 255, 0.7)',
        Pink: 'rgba(255, 105, 180, 0.7)',
        Orange: 'rgba(255, 165, 0, 0.7)'
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
      fileHighlights.set(uri, []);
      decorationStyles.forEach(style => editor.setDecorations(style, []));

      const lastLineIndex = editor.document.lineCount - 1;
      const lastLine = editor.document.lineAt(lastLineIndex);
      const wasAddedByUs = blankLineAddedByExtension.get(uri);

      if (wasAddedByUs && lastLine.isEmptyOrWhitespace && lastLineIndex > 0) {
        await editor.edit(editBuilder => {
          const range = new vscode.Range(
            new vscode.Position(lastLineIndex - 1, editor.document.lineAt(lastLineIndex - 1).text.length),
            new vscode.Position(lastLineIndex, lastLine.text.length)
          );
          editBuilder.delete(range);
        });
        await editor.document.save();
        blankLineAddedByExtension.set(uri, false);
      }

      vscode.window.showInformationMessage('Cleared highlights for current file (still in highlight mode).');
    }
  });

  // Command to stop highlight mode and clear all highlights across files
  const stopCommand = vscode.commands.registerCommand('extension.stopHighlighting', async () => {
    highlightingActive = false;
    fileHighlights.clear();

    for (const editor of vscode.window.visibleTextEditors) {
      const uri = editor.document.uri.toString();
      decorationStyles.forEach(style => editor.setDecorations(style, []));

      const lastLineIndex = editor.document.lineCount - 1;
      const lastLine = editor.document.lineAt(lastLineIndex);
      const wasAddedByUs = blankLineAddedByExtension.get(uri);

      if (wasAddedByUs && lastLine.isEmptyOrWhitespace && lastLineIndex > 0) {
        await editor.edit(editBuilder => {
          const range = new vscode.Range(
            new vscode.Position(lastLineIndex - 1, editor.document.lineAt(lastLineIndex - 1).text.length),
            new vscode.Position(lastLineIndex, lastLine.text.length)
          );
          editBuilder.delete(range);
        });
        await editor.document.save();
        blankLineAddedByExtension.set(uri, false);
      }
    }

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

      fileHighlights.set(uri, highlights);

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
          blankLineAddedByExtension.set(uri, true);
          // vscode.window.showInformationMessage('Blank line added at end of file.');
        }
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
