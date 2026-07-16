# ListAgent

ListAgent is a lightweight Windows desktop app (built with Tauri) for configuring and running your own local LLM "agents" against any OpenAI-API-compatible endpoint. Each agent is a self-contained card with its own prompt, model, tool set, skills, and memory, and can be triggered from the UI, on a schedule, by another agent's event, or through a local HTTP API — which makes it easy to wire ListAgent into external scripts and automation (build pipelines, monitoring, etc.).

## Requirements

- Windows 10/11 (uses the system WebView2 runtime).
- To run from source: [Node.js](https://nodejs.org/) + npm, and the [Rust toolchain](https://www.rust-lang.org/tools/install) (for `tauri build`/`tauri dev`).
- To just use the app: the prebuilt `ListAgent.exe` — no toolchain needed.

## Quick Start

**Run the prebuilt executable**

```
ListAgent.exe
```

**Run from source (dev mode)**

```
run.bat
```

This installs npm dependencies (first run only) and launches `npx tauri dev` from `listagent-app/`.

**Build a portable executable**

```
build_exe.bat
```

This installs dependencies, runs `npx tauri build --no-bundle`, and copies the resulting binary to `ListAgent.exe` at the repo root.

## Creating an Agent

Click the `+` button to add a new item, then fill in:

| Field | Purpose |
|---|---|
| Agent Name | Display name; also matched against the HTTP API's `agent` parameter. |
| Agent ID | Stable, auto-generated ID — prefer this over the name for HTTP calls, since it survives renames. |
| Working Directory | Root folder the agent's file/command tools are sandboxed to. Leave blank to use the app's own working directory. |
| Prompt | The system prompt. Supports `{message}`, `{arg1}`, `{arg2}`, `{arg3}` placeholders, filled in at run time from user input, a scheduled event, or an HTTP call. |
| API Base URL / API Key / Model Name | Connection to an OpenAI-compatible chat completions endpoint. The API key is looked up from an environment variable (you enter the variable's *name*, not the secret itself), or pick a saved preset. |
| Max Rounds | Cap on tool-call round trips per run. |

**Tools** — check any of: `list_directory`, `search_content`, `read_file`, `write_file`, `replace_string`, `trigger_event`, `web_search`, `fetch_url`, `get_current_time`, `execute_command`. All file/command tools are restricted to the agent's working directory.

**Tools Search** — when enabled, the agent starts with no tools attached and must call `tools_search` to discover and unlock what it needs, which keeps large tool sets out of the initial prompt. Optionally fill in the three Embedding API fields (Base URL / Key / Model) to have ListAgent pre-select the top‑5 most relevant tools by vector search instead of relying on the model to search.

**Skills** — reusable system-prompt snippets stored as JSON files under `listagent-app/skills/`. Create/edit them from the in-app skill editor, or drop `.json` files directly into that folder; each has an id, display name, version, description, and a prompt/system_prompt body. Attach one or more skills to an agent to compose behavior (see `bios-build.json` / `bios-flash.json` for examples).

**MCP Servers** — add stdio or HTTP MCP servers (e.g. `npx -y @modelcontextprotocol/server-filesystem .`); their tools are automatically merged into the agent's tool set.

**Memory** — toggle to automatically carry the previous conversation history into each new run.

## Running an Agent

- **Manual** — select the agent, type into its input box, and click Run.
- **Scheduled Events** — open the clock icon to create one-time or recurring triggers bound to a specific agent.
- **Custom Events** — an agent with the `trigger_event` tool can fire an event ID that runs other agents mapped to that event, passing `message`/`arg1`/`arg2`/`arg3` along.
- **HTTP API** — enable "Allow HTTP request to run this agent's task" on the agent, then call the local server on `127.0.0.1:37123` (only active while the app is running). See [HTTP API](#http-api) below for the full parameter reference.

## HTTP API

The app runs a local HTTP server on `http://127.0.0.1:37123` while it is open. Two switches gate it: the global "HTTP trigger" toggle in event settings (off → every `/input` call returns `403`), and the per-agent "Allow HTTP request" checkbox (unchecked → the request is accepted but silently dropped at dispatch).

### Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/input` | GET / POST | Run an agent, query status, or list agents (see parameters below). |
| `/health` | GET | Liveness check; always returns `{"status":"ok"}`. |
| `/session_file?path=...` | GET | Read back a saved session JSON (e.g. the `lastSessionUrl` from `get_status`). Only `.json` files under a `.ListAgent/session` or `.listagent/sessions` directory are allowed. |

### `/input` parameters

Send them as URL query parameters (GET) or as a JSON object body (POST, `Content-Type: application/json`, max 1 MB). Both forms accept the same parameters:

| Parameter | Aliases | Type | Required | Description |
|---|---|---|---|---|
| `agent_id` | `agentId` | string | one of `agent_id` / `agent` (for `run`) | Stable agent ID — preferred, since it survives renames. Shown in the agent's edit form. |
| `agent` | — | string | — | Agent display name (max 200 chars). Fallback when `agent_id` is not given; matching is by name. |
| `action` | — | string | no | `run` (default), `get_status`, or `list_agents`. Any other value returns `400`. |
| `exec_id` | `execId` | string | no | Caller-supplied correlation ID. Echoed back by `get_status` as `currentExecId` while the run is active and `lastExecId` after it ends. |
| `tools` | `tool` | string / array | no | Extra tools to enable **for this run only**, merged (union) with the agent's configured tools. Comma-separated string (`tools=read_file,write_file`) or, in POST, a JSON array. |
| `model` | `model_name`, `modelName` | string | no | Overrides the agent's model name for this run only. |
| `parameters` | `params`, `input` | object | no | POST only: JSON object holding the prompt arguments (see below). If omitted, any *other* top-level keys in the body are collected into `parameters` instead. |
| *(any other key)* | — | string | no | GET only: every unrecognized query key becomes an entry in `parameters` (a repeated key becomes an array of values). |

**Prompt arguments** — inside `parameters`, the keys `message`, `arg1`, `arg2`, `arg3` are substituted into the matching `{message}` / `{arg1}` / `{arg2}` / `{arg3}` placeholders in the agent's prompt (non-string values are JSON-stringified). The full `parameters` object is also passed to the agent as the user input of the run. Other keys are carried along but have no placeholder substitution.

**Examples**

```
GET /input?agent_id=<id>&action=run&exec_id=job-42&message=hello&arg1=alpha
```

```bash
curl -X POST http://127.0.0.1:37123/input \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "<id>",
    "action": "run",
    "exec_id": "job-42",
    "tools": ["read_file", "write_file"],
    "model": "qwen2.5-coder-3b-instruct",
    "parameters": { "message": "hello", "arg1": "alpha" }
  }'
```

### Actions and responses

- **`action=run`** — queues the run and immediately returns `202 Accepted` with `{"accepted":true,"agent":...,"agentId":...,"action":"run"}`. Execution is asynchronous (up to 1000 requests are queued; the oldest is dropped when full) — poll `get_status` with your `exec_id` to track completion.
- **`action=get_status`** — runs nothing. Without `agent`/`agent_id` it returns the global snapshot `{running:[names], queued:{name:count}, detail:{name:{...}}, updatedAt}`; with `agent`/`agent_id` it returns that agent's `{agent, agentId, running, queued, detail, updatedAt}`. The `detail` object includes `currentRound`, `currentTokens`, `currentExecId`, `lastEndedAt`, `lastSuccess`, `lastContentPreview`, `lastTokens`, `lastPromptTokens`, `lastRounds`, `lastExecId`, `lastSessionPath`, and `lastSessionUrl` (fetchable via `/session_file`).
- **`action=list_agents`** — returns `{"agents":[{"agentId":...,"name":...,"allowHttp":true|false}]}` for every configured agent.

## Where things are stored

- App settings (agents, presets, events, MCP config): `%USERPROFILE%\.listagent\settings.json`
- Session/run history: `<working directory>\.ListAgent\session\*.json` when a working directory is set, otherwise `%USERPROFILE%\.listagent\sessions\<agent>\*.json`.
- Skills: `listagent-app/skills/*.json` (dev) or next to the executable (release build).
