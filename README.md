Here's a complete and polished `README.md` for your VSCode extension:

---

## 📌 highlight-code — A VSCode Extension

**highlight-code** is a lightweight Visual Studio Code extension that allows you to highlight selected text in the editor with a red background. You can persist multiple highlights and clear them all with a single command.

---

## ✨ Features

* ✅ Highlight any selected text in red
* ✅ Keep multiple highlights active across the document
* ✅ Clear all highlights via command
* ✅ Auto-adds a blank line at the end of the file (if missing)

---

## 🚀 How to Use

1. Open the **Command Palette** (`Ctrl+Shift+P`)
2. Run **`Highlight Selected Text`**
3. Start selecting text — it will be highlighted in **red**
4. Run **`Clear Highlights`** to remove all highlights

> 💡 If the last line of the file is not blank, the extension will automatically insert a new line.

---

## 🧪 Commands

| Command                   | Description                                  |
| ------------------------- | -------------------------------------------- |
| `Highlight Selected Text` | Activates highlight mode for selections      |
| `Clear Highlights`        | Clears all highlights and stops highlighting |

---

## ⚙️ Extension Settings

No custom settings yet — plug and play!

---

## 💻 Development

Clone the repo and run:

```bash
npm install
npm run compile
```

Press `F5` to launch a new **Extension Development Host**.

---

## 📂 File Structure (Important Files)

```
├── package.json          # Metadata and command registrations
├── src/
│   └── extension.ts      # Extension logic
├── out/                  # Compiled output
└── README.md             # This file
```

---

## 📣 Roadmap Ideas

* [ ] Customizable highlight color
* [ ] Toggle mode (on/off via single command)
* [ ] Word-based highlighting
* [ ] Settings support via `settings.json`

---

## 🙌 Author

Made with ❤️ by \[Your Name]

---

Let me know if you want to:

* Change project name/description
* Add demo GIF or screenshots
* Prepare for VSCode Marketplace publishing (`vsce`)
