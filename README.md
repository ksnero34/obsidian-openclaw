# Obsidian OpenClaw

Chat with Pip (OpenClaw) directly from Obsidian. Create, edit, and manage notes through conversation.

## Features

- **Chat sidebar** - Talk to Pip from the right sidebar
- **Context-aware** - Optionally include the current note in your conversation
- **File operations** - Pip can create, update, append to, delete, and rename files
- **Markdown rendering** - Pip's responses render as proper markdown

## Installation

This plugin is installed using [BRAT](https://github.com/TfTHacker/obsidian42-brat) (Beta Reviewers Auto-update Tool).

### Step 1: Install BRAT

1. Open Obsidian Settings → Community plugins
2. Click "Browse" and search for "BRAT"
3. Install and enable the BRAT plugin

### Step 2: Add OpenClaw via BRAT

1. Open Obsidian Settings → BRAT
2. Click "Add Beta plugin"
3. Enter the repository URL: `AndyBold/obsidian-openclaw`
4. Click "Add Plugin"
5. Enable "OpenClaw" in Settings → Community plugins

### Step 3: Configure

1. Open Obsidian Settings → OpenClaw
2. Set your **Gateway URL** (e.g., `https://your-machine.tailnet.ts.net` or `http://127.0.0.1:18789`)
   - Do not include a trailing slash
3. Set your **Gateway Token** (from your Clawdbot config)
4. Click "Test Connection" to verify

## Opening the Chat Sidebar

There are several ways to open the Pip chat panel:

1. **Ribbon icon** - Click the chat bubble icon (💬) in the left ribbon
2. **Command palette** - Press `Cmd/Ctrl+P` and search for "Open Pip Chat"
3. **Hotkey** - Assign a custom hotkey in Settings → Hotkeys, search for "Pip"

The chat panel opens in the right sidebar. You can drag it to a different position if preferred.

## Usage

1. Open the Pip chat sidebar (see above)
2. Type your message and press `Cmd/Ctrl+Enter` or click **Send**
3. Toggle "Include current note" to give Pip context about what you're working on

### Example prompts

- "Summarize this note"
- "Create a new note called 'Meeting Notes' with today's date"
- "Add a TODO section to the end of this file"
- "Rename this file to include today's date"

## File Actions

When you ask Pip to work with files, it returns structured actions that the plugin executes:

| Action | Description |
|--------|-------------|
| `createFile` | Create a new file with content |
| `updateFile` | Replace file contents |
| `appendToFile` | Add content to end of file |
| `deleteFile` | Delete a file |
| `renameFile` | Rename/move a file |
| `openFile` | Open a file in the editor |

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| Gateway URL | Clawdbot gateway address (no trailing slash) | `http://127.0.0.1:18789` |
| Gateway Token | Auth token for the gateway | (empty) |
| Show actions in chat | Display action indicators | false |

## OpenClaw Setup

Make sure your OpenClaw config has the HTTP endpoint enabled:

```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true }
      }
    }
  }
}
```

## Development

```bash
git clone https://github.com/AndyBold/obsidian-openclaw.git
cd obsidian-openclaw
npm install
npm run dev   # Watch mode
npm run build # Production build
```

## License

MIT
