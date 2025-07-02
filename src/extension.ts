import * as vscode from 'vscode';

let decorationType: vscode.TextEditorDecorationType;
let allHighlights: vscode.Range[] = [];
let highlightingActive = false;

export function activate(context: vscode.ExtensionContext) {
  vscode.window.showInformationMessage('Highlight extension ready.');

  decorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 0, 0, 0.4)',
    border: '1px solid darkred',
    borderRadius: '3px'
  });

  // Command: Start highlighting mode
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
    }

    vscode.window.showInformationMessage('Highlighting mode started. Select text to highlight.');
  });

  // Command: Clear all highlights
  const clearCommand = vscode.commands.registerCommand('extension.clearHighlights', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && decorationType) {
      allHighlights = [];
      editor.setDecorations(decorationType, []);
      highlightingActive = false;
      vscode.window.showInformationMessage('Highlights cleared and highlighting stopped.');
    }
  });

  // Selection listener
  const selectionListener = vscode.window.onDidChangeTextEditorSelection((e) => {
    if (!highlightingActive) return;

    const editor = e.textEditor;
    const selections = e.selections.filter(sel => !sel.isEmpty);

    const frozenRanges = selections.map(sel => {
      const start = new vscode.Position(sel.start.line, sel.start.character);
      const end = new vscode.Position(sel.end.line, sel.end.character);
      return new vscode.Range(start, end);
    });

    if (frozenRanges.length > 0) {
      allHighlights.push(...frozenRanges);
      editor.setDecorations(decorationType, allHighlights);

      const selectedText = editor.document.getText(selections[0]);
      vscode.window.showInformationMessage(`Highlighted: ${selectedText}`);
    }
  });

  context.subscriptions.push(startCommand, clearCommand, selectionListener);
}

export function deactivate() {
  if (decorationType) decorationType.dispose();
}
