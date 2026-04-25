# 🖍️ Highlight-It: VS Code Highlight Extension

This extension allows you to highlight text in your editor using multiple colors, helping you mark important code areas, annotate sections, or visually separate logic blocks.

---

## ✨ Features

- Highlight selected text using customizable colors.
- Choose from Red, Yellow, Green, Blue, Pink, and Orange.
- Toggle highlights on/off by selecting the same region.
- Multiple colors can exist simultaneously in a file.
- Highlights persist per file during the session.
- Version control support keeps highlights scoped to the current git branch and workspace folder.
- Automatically adds a blank line if needed for proper display.
- Clear highlights for the current file or stop highlighting completely.

---

## 📘 Usage Instructions

1. Open the Command Palette: `Ctrl + Shift + P`
2. Run one of the following commands:

| Command | Description |
|--------|-------------|
| `Highlight: Start Highlighting` | Enables highlight mode. Start selecting text and it will be highlighted. |
| `Highlight: Set Highlight Color` | Pick a color for future highlights. |
| `Highlight: Clear Highlights` | Clears all highlights for the current file. |
| `Highlight: Stop Highlighting (All Files)` | Disables highlighting mode and clears all highlights from all files. |
| `Highlight: Stop and Clear Highlights` | Stops highlighting mode and clears visible highlights from all files. |
| `Highlight: Clear All Highlights Permanently (Current Branch)` | Permanently deletes saved highlights for the current branch across all files. |
| `Highlight: Clear All Files Highlights (Current Branch)` | Removes all highlights for every file in the current branch. |
| `Highlight: Reset Highlight-It (Current Folder)` | Resets saved highlight data for the current workspace folder. |

### Start Highlighting
Run the `Highlight: Start Highlighting` command, then select text in your editor. The selected text will be highlighted with the currently selected color.
![Start Highlighting Demo](assets/Start-Highlighting.gif)

### Set Highlight Color
Run the `Highlight: Set Highlight Color` command to choose a color for your highlights. You can select from Red, Yellow, Green, Blue, Pink, and Orange. 
The selected color will be used for all new highlights.
![Set Highlight Color Demo](assets/Set-Highlight-Color.gif)

### Clear Highlights
Run the `Highlight: Clear Highlights` command to remove all highlights from the current file. This will not affect highlights in other files.
![Clear Highlights Demo](assets/Clear-Highlighting.gif)

### Stop Highlighting
Run the `Highlight: Stop Highlighting (All Files)` command to disable highlighting mode. This will clear all highlights from all files and stop the extension from highlighting any text.
![Stop Highlighting Demo](assets/Stop-Highlighting.gif)

### Stop and Clear Highlights
Run the `Highlight: Stop and Clear Highlights` command to stop highlighting mode and clear visible highlights from every open editor. Saved highlights remain available and can be restored later.

### Clear All Highlights Permanently
Run the `Highlight: Clear All Highlights Permanently (Current Branch)` command to permanently delete saved highlights for the current branch across all files.

### Clear All Files Highlights
Run the `Highlight: Clear All Files Highlights (Current Branch)` command to remove all highlights for every file in the current branch.

### Reset Highlight-It
Run the `Highlight: Reset Highlight-It (Current Folder)` command to reset highlight data for the current workspace folder.

### Version Control Support
Highlight-It keeps highlights scoped to the current git branch and workspace folder, so switching branches does not mix saved highlights between versions of the same files.
![Version Control Support Demo](assets/Version-Control-Support.gif)

---

## 🧑‍💻 Developer Guide

### Source Code
The source code for this extension is available on [Highlight-It](https://github.com/SarveshMankar/vscode-Highlight-It).

### Commands

Ensure the following commands are defined in your `package.json`:

```json
{
  "contributes": {
    "commands": [
      {
        "command": "extension.startHighlighting",
        "title": "Highlight: Start Highlighting"
      },
      {
        "command": "extension.setHighlightColor",
        "title": "Highlight: Set Highlight Color"
      },
      {
        "command": "extension.clearHighlights",
        "title": "Highlight: Clear Highlights (Current File)"
      },
      {
        "command": "extension.stopHighlighting",
        "title": "Highlight: Stop Highlighting"
      },
      {
        "command": "extension.stopAndClearHighlights",
        "title": "Highlight: Stop and Clear Highlights"
      },
      {
        "command": "extension.clearAllHighlightsPermanently",
        "title": "Highlight: Clear All Highlights Permanently (Current Branch)"
      },
      {
        "command": "extension.clearAllHighlightsForCurrentBranch",
        "title": "Highlight: Clear All Files Highlights (Current Branch)"
      },
      {
        "command": "extension.resetHighlightsForCurrentFolder",
        "title": "Highlight: Reset Highlight-It (Current Folder)"
      }
    ]
  },
  "activationEvents": [
    "onCommand:extension.startHighlighting",
    "onCommand:extension.setHighlightColor",
    "onCommand:extension.clearHighlights",
    "onCommand:extension.stopHighlighting",
    "onCommand:extension.stopAndClearHighlights",
    "onCommand:extension.clearAllHighlightsPermanently",
    "onCommand:extension.clearAllHighlightsForCurrentBranch",
    "onCommand:extension.resetHighlightsForCurrentFolder"
  ]
}
```

### Contributing

1. Fork the [Highlight-It](https://github.com/SarveshMankar/vscode-Highlight-It) Repository
2. Create a new branch for your feature or bugfix
3. Submit a pull request with a clear explanation

Suggestions for new color options, persistent highlight storage, or UI enhancements are welcome!

⚠️ This extension is licensed under the MIT License, but commercial use is **not permitted** without explicit written permission from the author.


## 👤 Author

Created and maintained by **Sarvesh Mankar**  
[GitHub](https://github.com/SarveshMankar)
[LinkedIn](https://www.linkedin.com/in/sarvesh-mankar/)