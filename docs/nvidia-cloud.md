# NVIDIA free cloud mode

BridgeClip can plan clips on NVIDIA's hosted models **for free**, while
transcription stays on your machine. One switch in **Settings → AI provider**
moves clip planning from your paid OpenRouter key to the
[build.nvidia.com](https://build.nvidia.com) free tier; transcripts never
leave the machine, and only the planning prompt goes to NVIDIA.

```
Settings → AI provider → NVIDIA (free cloud) → "Prepare free transcription"
```

You need a free NVIDIA key (`nvapi-…`), generated at
[build.nvidia.com](https://build.nvidia.com) after signing in — no credit
card. Paste it in Settings → API keys → NVIDIA.

## What runs where

| Stage | Cloud mode | NVIDIA mode |
|---|---|---|
| Transcription | MAI Transcribe 2 / Whisper via OpenRouter | **faster-whisper** on your GPU (same stack as offline mode) |
| Clip planning | Claude / GPT / Gemini via OpenRouter | **NVIDIA NIM** (`https://integrate.api.nvidia.com/v1`, default `deepseek-ai/deepseek-v3.1`) |
| Review repairs | GPT via OpenRouter | NVIDIA NIM (default `meta/llama-3.3-70b-instruct`) |
| Jev review, web research, vision framing | OpenRouter | Skipped (cloud-only features) |
| Rendering, captions, yt-dlp download | Local | Local (unchanged) |

The **Prepare free transcription** button deploys only the Whisper half of
the offline stack (runtime + one-time weights download, ~1.5 GB for
`large-v3-turbo`); no Ollama and no local planner model are needed.

## Free tier limits

- **~1000 inference credits** on signup — enough for thousands of standard
  planning requests. Usage is shown on build.nvidia.com.
- **40 requests per minute**. The pipeline throttles itself: on a 429 it
  waits for the server's `Retry-After` window and retries (twice per call)
  before surfacing an error. For sustained runs you can request up to
  200 RPM and 5000 credits from the NVIDIA dashboard or developer forum.
- Cost estimates for NVIDIA runs are reported as $0 (free tier inference).

## Choosing models

The planner model dropdown offers curated NIM models (DeepSeek V3.1,
Llama 3.3 70B, Qwen3 235B, Nemotron Super 49B, Mistral Small 3.1). Any
`vendor/model` slug served by `https://integrate.api.nvidia.com/v1/models`
can be set through `NVIDIA_PLANNER_MODEL`. Models that reject JSON-schema
constrained decoding are retried once without the wire-level schema — the
planner validates every parse regardless.

## Environment variables (engine side)

Set by the desktop app per job; useful for source runs and tests:

| Variable | Default | Meaning |
|---|---|---|
| `AI_BACKEND` | `cloud` | `nvidia` switches planning/repairs to NVIDIA NIM and transcription to local Whisper |
| `NVIDIA_API_KEY` | *(empty)* | The `nvapi-…` key from build.nvidia.com |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | OpenAI-compatible NIM endpoint |
| `NVIDIA_PLANNER_MODEL` | `deepseek-ai/deepseek-v3.1` | NIM slug used for planning |
| `NVIDIA_REPAIR_MODEL` | `meta/llama-3.3-70b-instruct` | NIM slug used for review repairs |
| `NVIDIA_PLANNER_MAX_OUTPUT_TOKENS` | `16000` | Cap on planner output |
| `LOCAL_WHISPER_MODEL` | `large-v3-turbo` | Local transcription size (as offline mode) |
| `TRANSCRIPTION_LANGUAGE` | *(empty)* | ISO 639-1 code, e.g. `ro`; empty = auto |

## Security posture

- The NVIDIA key is stored encrypted with the OS keychain like every other
  provider key, passed to the engine worker only through its environment,
  and never reaches renderer code, argv or job config.
- The worker's network guard still blocks every private destination;
  `integrate.api.nvidia.com` is a public HTTPS endpoint.
- OpenRouter-only request fields (response healing, provider routing,
  fallback chains, web-search tools) are stripped from NVIDIA requests.
- NVIDIA mode forces `JEV_ENABLED=false`, `JEV_VISUAL_CONTEXT=false`,
  `SOURCE_CONTEXT_WEB_RESEARCH=false` and `LAYOUT_VISION_ENABLED=false`;
  no OpenRouter call is attempted.

## Troubleshooting

- **401/403 "NVIDIA rejected the API key"** — regenerate the key at
  build.nvidia.com and paste it again in Settings → API keys.
- **429 rate limit** — the free tier allows ~40 requests per minute; the
  pipeline retries automatically. If you clip in long sessions, request a
  higher limit from NVIDIA.
- **Model rejects the request (400)** — pick a different model from the
  dropdown; slugs must exist on build.nvidia.com.
