# 🖍️ Highlight-It: VS Code Highlight Extension

This extension allows you to highlight text in your editor using multiple colors, helping you mark important code areas, annotate sections, or visually separate logic blocks.

---

## ✨ Features

- Highlight selected text using customizable colors.
- Choose from Red, Yellow, Green, Blue, Pink, and Orange.
- Toggle highlights on/off by selecting the same region.
- Multiple colors can exist simultaneously in a file.
- Highlights persist per file during the session.
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
| `Highlight: Stop Highlighting` | Disables highlighting mode and clears all highlights from all files. |

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
Run the `Highlight: Stop Highlighting` command to disable highlighting mode. This will clear all highlights from all files and stop the extension from highlighting any text.
![Stop Highlighting Demo](assets/Stop-Highlighting.gif)

---

## 🧑‍💻 Developer Guide

### Commands

Ensure the following commands are defined in your `package.json`:

```json
{
  "contributes": {
    "commands": [
      {
        "command": "extension.highlightSelection",
        "title": "Highlight: Start Highlighting"
      },
      {
        "command": "extension.setHighlightColor",
        "title": "Highlight: Set Highlight Color"
      },
      {
        "command": "extension.clearHighlights",
        "title": "Highlight: Clear Highlights"
      },
      {
        "command": "extension.stopHighlighting",
        "title": "Highlight: Stop Highlighting"
      }
    ]
  },
  "activationEvents": [
    "onCommand:extension.highlightSelection",
    "onCommand:extension.setHighlightColor",
    "onCommand:extension.clearHighlights",
    "onCommand:extension.stopHighlighting"
  ]
}
```

### Contributing

1. Fork this repository 
2. Create a new branch for your feature or bugfix
3. Submit a pull request with a clear explanation

Suggestions for new color options, persistent highlight storage, or UI enhancements are welcome!

⚠️ This extension is licensed under the MIT License, but commercial use is **not permitted** without explicit written permission from the author.


## 👤 Author

Created and maintained by **Sarvesh Mankar**  
[GitHub](https://github.com/SarveshMankar)
[LinkedIn](https://www.linkedin.com/in/sarvesh-mankar/)