---
name: bridgeclip
description: Work with a user's BridgeClip clip library — find clips, read captions and transcripts, fix caption typos, and publish through Zernio. Use when the user mentions their clips, runs, captions, or posting clips socially.
---

# BridgeClip

BridgeClip is a desktop app that turns long videos into short vertical clips.
Its data lives in a local library you can read through the `bridgeclip` MCP
server (this folder), and it publishes through Zernio via the `zernio` MCP
server. Both are read-mostly: only `update_caption` writes, and only into an
editor project file.

## Which server does what

- `bridgeclip` (this server): `library_info`, `list_runs`, `list_clips`,
  `get_clip`, `search_clips`, `get_editor_project`, `get_captions`,
  `update_caption`.
- `zernio`: accounts, media upload, `create_post`, scheduling, calendar,
  retries — everything publishing.

## Recipes

- "Give me the top 5 clips" → `list_runs` for the newest run, then
  `list_clips`, sort by `score`, present the top 5 with titles and scores.
- "Find clips about X" → `search_clips` with the topic; fall back to
  `list_clips` + `get_clip` transcripts when the summary text is thin.
- "What does clip 3 say?" → `get_captions` (run from `list_runs`).
- "Fix the typo in caption 4 of clip 3" → `get_captions`, find the segment
  whose text holds the typo, `update_caption` with the corrected text. Say
  what you changed. Best while the BridgeClip app is closed; if it is open,
  the app offers "Reload project" and keeps the fix.
- "Post clip 2 to YouTube/TikTok…" → find the clip's file `path`, then use
  the `zernio` server (`upload_media` + `create_post`) with the user's
  accounts and caption.

## Honest limits

- Starting a NEW clipping job from a URL runs inside the desktop app; you
  cannot trigger it from here. Tell the user to start it, then use
  `list_runs` to pick up the results once it finishes.
- Baked clips are rendered files; changing their burned captions means
  editing the editor project (`update_caption`) and re-baking in the app.

## Ground rules

- Never invent run names, clip indexes or segment indexes — always read them
  from a tool first.
- One `update_caption` per real mistake; quote the before/after to the user.
- Caption text is the user's voice: fix spelling and names, never rewrite
  meaning.
