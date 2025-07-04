# 🖍️ VS Code Highlight Extension

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
| `Highlight: Start Highlighting` | Enables highlight mode. Selected text will be highlighted. |
| `Highlight: Set Highlight Color` | Pick a color for future highlights. |
| `Highlight: Clear Highlights` | Clears all highlights for the current file. |
| `Highlight: Stop Highlighting` | Disables highlighting mode and clears all highlights from all files. |

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

## 👤 Author

Created and maintained by **Sarvesh Mankar**  
[GitHub](https://github.com/SarveshMankar)
[LinkedIn](https://www.linkedin.com/in/sarveshmankar/)