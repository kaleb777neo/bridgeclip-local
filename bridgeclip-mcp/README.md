# bridgeclip-mcp

BridgeClip as an AI-assistant connector: a **read-only, local, zero-credential**
MCP server over your clip library, so MCP clients (Claude Desktop, ZCode, …)
can use BridgeClip's best features simply by prompting — find clips, read
transcripts, pull file paths for editing or posting.

Nothing here writes to the library, touches the network, or needs the
BridgeClip app to be running.

## Tools

| Tool | What it does |
| --- | --- |
| `library_info` | Where the library is; run / clip / favorite / editable-project counts. |
| `list_runs` | Recent runs (a run = one source video turned into clips), newest first. |
| `list_clips` | Every clip in a run: title, virality score, summary, tags, path, posted status. |
| `get_clip` | One clip in full, including the transcript excerpt covering its window. |
| `search_clips` | Free-text search across all runs (titles, summaries, tags), best score first. |
| `get_editor_project` | A run's editor project: every editable clip with id, title, status and revision. |
| `get_captions` | One editor clip's caption lines (segment, time, text), edits applied, with an `edited` flag. |
| `update_caption` | Fix one caption line by segment index; bumps the project revision atomically. Best while the app is closed — the app offers "Reload project" on conflict. |

## Connect it (no API keys, no "MCP settings" inside BridgeClip)

The library is auto-discovered from BridgeClip's own settings (`settings.json`
→ output directory), falling back to the default `~/BridgeClip`. Two env
overrides exist: `BRIDGECLIP_LIBRARY` (use a library directly) and
`BRIDGECLIP_USER_DATA` (read `settings.json` from a specific app-data folder).

Run the server from this folder once so its dependencies are in place:

```
npm install
```

Then register it with your MCP client, e.g. Claude Desktop
(`claude_desktop_config.json` → `mcpServers`):

```json
{
  "mcpServers": {
    "bridgeclip": {
      "command": "node",
      "args": ["<path-to-bridgeclip>/bridgeclip-mcp/index.js"]
    }
  }
}
```

Or in any CLI MCP client: `node <path-to-bridgeclip>/bridgeclip-mcp/index.js`.

## Safety

* Strictly read-only: the only filesystem access is bounded JSON reads
  (≤ 32 MB per file) inside the library, and run names can never traverse
  outside it.
* Tool output is capped (48 KB) so a model never drowns in one response.
* Markers the app already uses (`.bridgeclip-favorite`,
  `.bridgeclip-posted-<index>`) are surfaced as `favorite` / `posted`.

## Skill

`SKILL.md` in this folder is a ready-made agent skill (Claude Code, Codex,
OpenClaw and any skill-aware host): it teaches the agent when and how to use
these tools together with the `zernio` publishing server — "give me the top 5
clips", "fix the typo in caption 4 of clip 3", "post clip 2 to YouTube".
Install by pointing your skill host at this folder, or paste the file into
`~/.claude/skills/bridgeclip/SKILL.md`.

## Test

```
npm test
```

Builds a fake library in a temp directory and drives a real MCP session over
stdio: handshake, tool listing, every tool, marker pickup, search ranking and
path-traversal rejection.
