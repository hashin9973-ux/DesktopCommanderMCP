# Local OpenAI-compatible API mode

Local API mode runs Desktop Commander as a local tool-using assistant. It sends chat messages and the Desktop Commander function schemas to a local OpenAI-compatible model server, executes returned tool calls directly on this computer, and sends the tool results back to the model.

This mode does not use MCP, the Cloud-folder request/response queue, GitHub, Cloudflare, or any remote relay.

## KoboldCpp setup

1. Start KoboldCpp and load a model that supports tool/function calling.
2. Enable **Jinja** and **Jinja for Tools** in KoboldCpp. Tool-call support and exact behavior depend on the loaded model and its chat template.
3. Confirm the local server is ready. KoboldCpp's default OpenAI-compatible base URL is `http://localhost:5001/v1`.
4. From the portable folder, double-click **Start Local OpenAI API (KoboldCpp).cmd**, or run `DesktopCommanderBridge.exe local-api`. To show the four-choice menu explicitly, double-click **Choose Desktop Commander Mode.cmd**.

The portable package includes both `.cmd` launchers for convenient startup from File Explorer or an interactive terminal. Menu selection, first-run consent, and local chat require an interactive terminal. A no-argument launch of `DesktopCommanderBridge.exe` uses the menu only when both standard input and output are interactive; MCP hosts use piped stdio and therefore start standard MCP mode without a menu.

The default endpoint is `http://127.0.0.1:5001/v1`. Local API mode requests the model list from `/models` and lets you choose a returned model ID. KoboldCpp generally uses the model already loaded by the server.

## Other local OpenAI-compatible servers

The mode can use another OpenAI-compatible server running on the same computer. Supply its base URL:

```powershell
DesktopCommanderBridge.exe local-api --base-url http://127.0.0.1:1234/v1 --model local-model
```

The base URL must use `localhost`, `127.0.0.1`, or `::1`. Remote API hosts are deliberately rejected: this mode is intended to keep prompts, tool arguments, and local tool results on the same computer.

If the local server requires a bearer API key, set `KOBOLDCPP_API_KEY` or `OPENAI_API_KEY` in the process environment. API keys are not stored in the Local API settings file. Do not put credentials in the base URL or command-line arguments.

## Chat commands

- Enter a message to send it to the local model.
- `/clear` clears the current conversation.
- `/tools` lists the available Desktop Commander tools.
- `/help` displays chat commands.
- `/exit` or `/quit` closes Local API mode.

Command-line options:

| Option | Purpose |
|---|---|
| `--base-url <url>` | Local OpenAI-compatible base URL |
| `--model <id>` | Model ID; auto-detected from `/models` when available |
| `--max-tokens <n>` | Maximum completion tokens (64–16384; default 2048) |
| `--max-tool-rounds <n>` | Maximum tool-call rounds per user turn (1–20; default 8) |

## Tool execution and safety

The model receives the available Desktop Commander tools as OpenAI function tools. Tool calls are validated and executed through the existing Desktop Commander dispatcher, so configured allowed directories and command restrictions remain in effect.

The first connection to a base URL requires typing `YES` in the local terminal. The connected model can read and modify permitted files and run local commands. Desktop Commander's restrictions are guardrails, not an operating-system sandbox. Only connect to a local model server you trust.

Settings are stored locally in:

- Windows: `%LOCALAPPDATA%\DesktopCommanderBridge\local-api.json`
- macOS/Linux: `$XDG_STATE_HOME/desktop-commander-bridge/local-api.json` (or `~/.local/state/desktop-commander-bridge/local-api.json` when `XDG_STATE_HOME` is unset)

The API key is never written to this file.
