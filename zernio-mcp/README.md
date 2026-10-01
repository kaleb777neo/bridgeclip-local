# zernio-mcp

Control Zernio (social publishing) from any MCP client — ZCode, Claude Desktop,
etc. Wraps the same REST API BridgeClip uses (`https://zernio.com/api/v1`) —
with **full-spec coverage**: every endpoint in Zernio's OpenAPI is callable.

## Tools

Typed tools for the core publishing flows:

| Tool | What it does |
|---|---|
| `list_profiles` | Zernio workspace profiles |
| `list_accounts` | Connected social accounts (with the accountId posts need) |
| `account_health` | healthy/warning/error, canPost, reconnect flags |
| `tiktok_creator_info` | Allowed privacy levels, toggles, duration limit for a TikTok account |
| `upload_media` | Uploads a local video file and returns the public URL |
| `create_post` | Posts/schedules a video to one or more accounts (per-platform options) |
| `list_posts` | Post history/calendar: filter by date window, status, platform, account, full-text; `source=external` includes posts made outside Zernio |
| `get_post` | Status, per-platform results and links |
| `reschedule_post` | Moves a scheduled post to a new time |
| `delete_post` | Deletes a draft or scheduled post |
| `retry_post` | Retries the failed platforms of a failed/partial post |

Generic tools covering **the entire API** (939 endpoints across 45 groups —
publishing, queue, analytics, inbox, ads, whatsapp, commerce, workflows,
webhooks, contacts, sms/voice and more):

| Tool | What it does |
|---|---|
| `list_endpoints` | Search/discover the full OpenAPI index; without a search, shows endpoint counts per resource group |
| `call_endpoint` | Invoke any endpoint (`method`, `path`, `query`, `body`), validated against the spec — unknown paths or wrong methods get an error with the closest matches |

Example: "care e cel mai bun moment de postare?" → `list_endpoints` cu
`search: "best time"` → `call_endpoint` cu `GET /v1/analytics/best-time`.

## Setup

1. Generate an API key at [zernio.com/dashboard/api-keys](https://zernio.com/dashboard/api-keys)
   (**Read & Write**, with access to the profiles you want to post to).
2. Install once: `npm install` in this folder.
3. Register in ZCode — `<repo>/.zcode/config.json` (already prepared here):

```json
{
  "mcp": {
    "servers": {
      "zernio": {
        "type": "stdio",
        "command": "<absolute path to node>",
        "args": ["<repo>/zernio-mcp/index.js"],
        "env": { "ZERNIO_API_KEY": "your nv key here" }
      }
    }
  }
}
```

Restart the session, then check **Settings → MCP** → `zernio` shows connected.
Any other MCP client works the same way (stdio server: `node index.js`).

`ZERNIO_BASE_URL` overrides the API base (tests only).

## Test

```bash
npm test
```

Spins a local mock of the Zernio API and drives a real MCP session over stdio:
handshake, tool listing, accounts, health, upload and a scheduled post.

## Notes

- The key is read only from the environment; it is never printed in tool output
  (the smoke test asserts this).
- Provider error text is sanitized (links and credential-looking runs removed)
  before it reaches the model.
- `create_post` sends an idempotency `x-request-id`, so retrying the same call
  after a timeout will not double-post (Zernio replays it for ~5 minutes).

## Refreshing the endpoint index

`openapi-paths.json` (the validated index behind `list_endpoints` /
`call_endpoint`) is built from Zernio's public spec:

```bash
curl -sL https://zernio.com/openapi.yaml -o openapi.yaml
node scripts/build-paths.mjs
```
