# LexiAI — Grammar Checker

A privacy-first Chrome extension that checks your grammar and rewrites your text using **100% local AI** — no data ever leaves your machine.

Powered by [LanguageTool](https://languagetool.org/) for grammar checking and [Ollama](https://ollama.com/) (Llama 3) for AI-assisted rewriting.

---

## Features

- **Live grammar & spelling underlining** on any `<textarea>` or `contenteditable` field across all websites
- **Click-to-fix suggestions** from LanguageTool with rule category badges
- **AI rewriting** via Ollama — select any text and press `Alt+G` (or right-click → *Improve with AI*)
- **Tone controls** — Original, Formal, Casual, or Concise
- **AI Chat panel** — a persistent local chat assistant in the popup
- **LaTeX ↔ Plain Text converter** for math notation
- **Ignore list** — add words to skip during grammar checks
- **Multi-language support** — English (CA/US/UK/AU), French, German, Spanish
- Fully **offline and private** — no API keys, no cloud calls

### Web UI (`lexiai.html`)
A standalone webpage you can open directly in your browser (no extension required):
- **Grammar checking** powered by LanguageTool
- **AI rewriting** with tone selection via Ollama
- **File export** — save your corrected text to a file

---

## Requirements

You need two local services running before the extension will work:

| Service | Default Port | Purpose |
|---|---|---|
| [LanguageTool](https://dev.languagetool.org/http-server) | `8081` | Grammar & spell checking |
| [Ollama](https://ollama.com/) with `llama3` | `11434` | AI rewriting & chat |

### 1. Start LanguageTool

The easiest way is via Docker:

```bash
docker run -d -p 8081:8010 silviof/docker-languagetool
```

Or download the standalone server from [languagetool.org](https://dev.languagetool.org/http-server) and run:

```bash
java -jar languagetool-server.jar --port 8081 --allow-origin "*"
```

### 2. Start Ollama

Download Ollama from [ollama.com](https://ollama.com/), then pull and run Llama 3:

```bash
ollama pull llama3
ollama serve
```

---

## Installation

1. Clone or download this repository:
   ```bash
   git clone https://github.com/your-username/lexiai.git
   ```

2. Open Chrome and go to `chrome://extensions/`

3. Enable **Developer mode** (toggle in the top-right corner)

4. Click **Load unpacked** and select the project folder

5. The LexiAI icon will appear in your toolbar — click it to open settings

---

## Usage

### Grammar Checking
Grammar and spelling errors are automatically underlined on any text field as you type. Click an underline to see suggestions and apply a fix.

### AI Rewriting (Alt+G)
1. Select any text on a webpage
2. Press `Alt+G` (or right-click → *Improve with AI*)
3. Choose a tone: **Original**, **Formal**, **Casual**, or **Concise**
4. Click **Apply** to replace the selected text

### AI Chat
Open the extension popup and click the **✦ AI Chat** tab to chat with Llama 3 directly — ask questions, request rewrites, or generate new content.

### Web UI
Open lexiai.html directly in your browser (no extension needed). It provides grammar checking, AI rewriting with tone selection, and the ability to export your corrected text as a file. Requires LanguageTool and Ollama to be running locally.

### Math Converter
Open the **π Math** tab to convert between LaTeX and plain-text math notation in either direction.

---

## Settings

| Setting | Description |
|---|---|
| Checking language | Language used by LanguageTool |
| AI Default Tone | Pre-selected tone for the AI rewrite popup |
| Ignore List | Words that will be skipped during grammar checks |

---

## Project Structure

```
lexiai/
├── manifest.json            # Extension manifest
├── popup/                   
│   ├── popup.html           # Extension toolbar UI & dashboard
│   ├── popup.js             # Popup logic (settings, chat, math converter)
│   └── popup.css            # Popup styling overlays
├── index/                   
│   ├── lexiai.html          # Standalone web UI 
│   ├── lexiai.js            # Web logic (grammar check, AI rewrite, file export)
│   └── lexiai.css           # Webpage styling overlays
├── scripts/                 
│   ├── background.js        # Background service worker
│   └── content.js           # Grammar highlighting & AI popup logic
├── styles/                  
│   └── content.css          # Page styling overlays
└── config/                  
    └── grammar.xml          # Custom rules & data
```

---

## Privacy

All processing happens locally on your machine. No text, keystrokes, or data are sent to any external server. The only network requests made are to `localhost`.

---

## License

MIT
