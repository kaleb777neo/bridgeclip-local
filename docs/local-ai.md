# Local AI (offline mode)

BridgeClip can clip videos entirely on your computer — no OpenRouter key, no
cloud cost, and transcripts never leave the machine. One switch in
**Settings → Local AI** moves transcription and clip planning from the cloud
to local models; rendering, captions and smart framing were already local.
A middle ground — free NVIDIA cloud planning with this same local Whisper
transcription — is described in [nvidia-cloud.md](nvidia-cloud.md).

```
Settings → Local AI → AI provider: Local (offline) → "Prepare offline mode"
```

## What the offline stack is

| Stage | Cloud mode | Local mode |
|---|---|---|
| Transcription | MAI Transcribe 2 / Whisper via OpenRouter | **faster-whisper** on your GPU (default: `large-v3-turbo`) |
| Clip planning | Claude / GPT / Gemini via OpenRouter | **Ollama** serving a local LLM (default: `qwen3:8b`) |
| Smart framing | Cloud vision boxes + local YuNet | Local YuNet face detection only |
| Jev review, web research | OpenRouter | Skipped (cloud-only features) |
| Rendering, captions, yt-dlp download | Local | Local (unchanged) |

The **Prepare offline mode** button deploys everything in order, with progress:

1. `pip install -r engine/requirements-local.txt` into the engine venv
   (faster-whisper + CUDA cuBLAS/cuDNN wheels on Windows).
2. Whisper weights downloaded once into the app's models folder
   (`<userData>/models`), reused by every later job.
3. A portable Ollama runtime into `<userData>/local-ai` — **skipped when an
   Ollama server already answers** at the configured URL. If you already use
   Ollama, BridgeClip simply talks to it.
4. The planner model (`qwen3:8b` by default) pulled through `/api/pull`.

## Choosing models

- **Transcription** — `large-v3-turbo` is the best speed/quality point on a
  laptop GPU (roughly 10–15× real-time on an RTX 4060, strong Romanian).
  `large-v3` is the most accurate but ~5× slower; `medium` is smallest but
  clearly weaker in Romanian. Pin the spoken language (Auto / Română /
  English) to stop auto-detect drift on music-heavy audio.
- **Planning** — any tag your Ollama has installed works. `qwen3:8b` is a fast
  Romanian + English all-rounder that fits an 8 GB GPU with a 16k context.
  Thinking mode is disabled per request (strict JSON beats deliberation for
  planning), and long transcripts are planned in ~24k-char windows that are
  merged and de-duplicated automatically.

## Hardware notes (8 GB VRAM class)

Transcription and planning run **sequentially**: the Whisper model is freed
after transcription so Ollama can use the whole GPU for planning. On CPU-only
machines transcription falls back to `int8` automatically. The managed Ollama
server is started with `OLLAMA_CONTEXT_LENGTH=16384`.

## Environment variables (engine side)

Set by the desktop app per job; useful for source runs and tests:

| Variable | Default | Meaning |
|---|---|---|
| `AI_BACKEND` | `cloud` | `local` turns on the offline backend; `nvidia` keeps local transcription but plans on NVIDIA's free NIM tier ([nvidia-cloud.md](nvidia-cloud.md)) |
| `LOCAL_LLM_BASE_URL` | `http://127.0.0.1:11434` | Ollama base URL (loopback only) |
| `LOCAL_PLANNER_MODEL` | `qwen3:8b` | Ollama tag used for planning |
| `LOCAL_REPAIR_MODEL` | `qwen3:8b` | Ollama tag used for review repairs |
| `LOCAL_WHISPER_MODEL` | `large-v3-turbo` | `large-v3` / `medium` also available |
| `LOCAL_WHISPER_DEVICE` | `auto` | `cuda` / `cpu` |
| `LOCAL_WHISPER_COMPUTE_TYPE` | `auto` | `float16` on CUDA, `int8` on CPU |
| `TRANSCRIPTION_LANGUAGE` | *(empty)* | ISO 639-1 code, e.g. `ro`; empty = auto |
| `LOCAL_PLANNER_MAX_OUTPUT_TOKENS` | `16000` | Cap on planner output locally |
| `LOCAL_PLANNER_CONTEXT_TOKENS` | `16384` | `num_ctx` sent to Ollama |
| `BRIDGECLIP_MODELS_DIR` | platform cache dir | Where Whisper weights live |

## Security posture

- The worker's network guard still blocks every private destination. In local
  mode it opens **exactly one exception**: loopback connections to the
  configured Ollama port. LAN-hosted runtimes remain blocked.
- Loopback-only `LOCAL_LLM_BASE_URL` is enforced in settings validation.
- Local mode forces `JEV_ENABLED=false`, `SOURCE_CONTEXT_WEB_RESEARCH=false`
  and `LAYOUT_VISION_ENABLED=false`; no cloud call is attempted.

## Troubleshooting

- **huggingface.co refuses downloads** (some datacenter IP ranges get 401 even
  for public repos): the setup detects the refusal and automatically
  re-downloads the same public conversion from a ModelScope mirror into the
  models folder — no user action needed. `HF_ENDPOINT=https://hf-mirror.com`
  in the environment also works, and a model folder containing `model.bin`
  placed directly under the models dir is always loaded first.
- **`cuda` load fails** (missing cuDNN DLLs): re-run the offline setup so the
  `nvidia-*-cu12` wheels install; transcription falls back to CPU meanwhile.
- **Model not found (404)**: pull it via `ollama pull <tag>` or the offline
  setup button; the job error names the exact missing tag.
