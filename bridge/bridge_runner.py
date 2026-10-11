#!/usr/bin/env python3
"""
BridgeClip Bridge Runner

Thin bridge between Electron and BridgeClip clipping engine.
Accepts a JSON config on stdin, runs the pipeline in LOCAL_MODE,
and streams structured JSON-line progress to stdout for Electron to consume.

Usage:
    python bridge_runner.py < job-config.json
"""

import asyncio
import json
import logging
import os
import sys
import time
import re
from urllib.parse import urlsplit

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("bridge_runner")

# Protocol stream set by reserve_stdout_for_protocol(); tests use sys.stdout.
_protocol = None

# Mirrors DURATION_OPTIONS in src/shared/job-contract.ts.
DURATION_RANGE_IDS = ("xshort", "short", "medium", "long", "xlong", "extended", "feature")

# Known failure classes -> (message, hint). Raw engine errors can contain
# request URLs, proxy credentials and local paths, so only these fixed strings
# reach the UI. First match wins.
FAILURES = (
    (("selected planner requires a video with speech",),
     "The selected planning model cannot analyze a video without speech.",
     "Choose a planning model that supports silent-video planning in Advanced mode, or use Quality or Economy."),
    (("unsupported twitch source",),
     "Choose a public, completed Twitch VOD.",
     "Copy the video link from a saved Twitch video. Live channels, collections and Twitch clips are not supported."),
    (("twitch vod is not completed",),
     "This Twitch video is still live or processing.",
     "Wait until the broadcast has ended and its saved video is ready, then retry."),
    (("twitch vod duration is invalid or too long",),
     "This Twitch video has no usable duration or exceeds the allowed length.",
     "Choose a completed video within the length limit, or trim a downloaded file before adding it."),
    (("twitch vod unavailable",),
     "The Twitch VOD could not be downloaded.",
     "Check that the saved video plays while signed out. Deleted, expired and subscriber-only videos are not supported. You can also use a local file."),
    (("not enough disk space to save clips",),
     "There is not enough free disk space to finish this video.",
     "Free space on your startup disk and the output drive, then retry. Source videos can use several GB while clipping."),
    (("transcription authentication failed",),
     "OpenRouter rejected the transcription request.",
     "Check the OpenRouter API key in Settings."),
    (("transcription providers are temporarily rate limited",),
     "Transcription providers are busy after automatic recovery attempts.",
     "Wait a few minutes, then run again. If this persists, check the OpenRouter account's rate limits."),
    (("transcription account credit limit reached",),
     "OpenRouter could not transcribe the video because the account has insufficient credit or a spending limit.",
     "Check the OpenRouter balance and API key spending limit, then run again."),
    (("transcription quota or rate limit reached",),
     "OpenRouter could not transcribe the video because its quota or rate limit was reached.",
     "Check the OpenRouter account, then retry later."),
    (("transcription service unavailable",),
     "OpenRouter could not be reached for transcription.",
     "Check your connection and retry."),
    (("transcription request rejected by provider",),
     "OpenRouter rejected the transcription audio request.",
     "The selected model may not support WAV audio and word timestamps. In Advanced mode, choose a timestamp-capable model such as Whisper Large V3 or MAI Transcribe 2."),
    (("transcription response lacked word timestamps",),
     "OpenRouter returned a transcript without word timestamps.",
     "Choose a transcription model with word timestamps in Advanced mode, such as Whisper Large V3 or MAI Transcribe 2, or retry using a preset."),
    (("transcription response was invalid", "transcription response was too large"),
     "OpenRouter returned an unusable transcription response.",
     "Retry the run. If it persists, report this run so the provider response can be investigated."),
    (("audio extraction failed", "audio duration could not be determined", "transcription audio preparation failed"),
     "BridgeClip could not prepare this video's audio for transcription.",
     "Run Settings → System check. If the tools are ready, report this run with its failure code."),
    (("transcription audio chunk exceeded the size limit",),
     "The transcription audio exceeded BridgeClip's size limit.",
     "Set a shorter start and end time, or report this run so the chunk size can be adjusted."),
    (("transcription failed",),
     "Audio transcription failed.",
     "Check that the video has a playable audio track, then retry."),
    (("local transcription is not installed", "could not load local whisper", "unknown local whisper model", "local backend unavailable",),
     "The offline transcription stack is not ready.",
     "Open Settings → Local AI and run the offline setup, then retry."),
    (("local ai runtime (ollama) is not running", "local model '", "local ai request failed",),
     "The offline AI runtime is not answering.",
     "Open Settings → Local AI, confirm Ollama is running and the model is installed, then retry."),
    (("video render failed",),
     "Clip rendering failed.",
     "Run Settings → System check. If all tools are ready, report this run so the render can be diagnosed."),
    (("http error 403", "sign in to confirm", "blocking this request"),
     "The video service refused the download.",
     "Update BridgeClip and retry. If it keeps happening, download the video yourself and clip it as a local file."),
    (("video unavailable", "private video", "members-only", "has been removed", "not available in your country"),
     "This video is private, removed or unavailable in your region.",
     "Check the link opens in a signed-out browser window, or clip a local file instead."),
    (("exceeds maximum allowed duration",),
     "This video is longer than BridgeClip can process.",
     "Choose a shorter source video, or trim a downloaded file before adding it."),
    (("insufficient credits for jev review",),
     "OpenRouter ran out of credits during Jev review; no clips were exported.",
     "Add OpenRouter credits or raise your key's limit, then re-run. To clip without review, turn off Jev review in Settings → TypeSafe Jev."),
    (("jev review was unavailable for every candidate",),
     "Jev review was unavailable, so no clips were exported.",
     "This does not mean the video has no suitable clips. Retry later, or turn off Jev review in Settings → TypeSafe Jev and re-run to clip without it."),
    (("review could not finish",),
     "Clip review could not finish; no clips were exported.",
     "A review or repair response was incomplete, unavailable, or hit a limit. This does not mean the video has no suitable clips. Inspect transcript & edits in Jobs for the failed requests, then retry."),
    (("no clips passed the coherence review", "clip omitted:"),
     "No clips passed the coherence review.",
     "Inspect transcript & edits in Jobs to see which context, ending, title or cut checks failed. No clip was forced."),
    (("no moments matched the clip request",),
     "No moments matched what you asked to clip.",
     "Try describing it more broadly, or leave What to clip blank to get the best moments. Inspect transcript & edits in Jobs shows the planner's explanation."),
    (("the planner returned no clip candidates",),
     "The planner returned no clip candidates.",
     "Open Inspect transcript & edits in Jobs and check the planner response for its explanation. The video may still contain suitable clips; this is not a rendering or system-check failure."),
    (("playlist or channel",),
     "This link is a playlist or channel, not a single video.",
     "Paste the link of one video."),
    (("duration is unavailable", "video is live or upcoming"),
     "This video is live or not yet available.",
     "Wait until the stream has ended and the saved video is ready, then retry."),
    (("no clip-worthy moments",),
     "BridgeClip couldn't find any clips in this video.",
     "No clear spoken or visual moment met the selected clip length. If you set a start and end time, widen it or pick a shorter clip length."),
    (("nvidia api error (401)", "nvidia api error (403)"),
     "NVIDIA rejected the API key.",
     "Check the NVIDIA key in Settings. It starts with nvapi- and is generated at build.nvidia.com."),
    (("nvidia api error (429)",),
     "NVIDIA's free tier rate limit was reached.",
     "Wait a minute and retry. For sustained runs, request a higher rate limit from build.nvidia.com."),
    (("out of credits", "quota exceeded"),
     "Your OpenRouter key is out of credits.",
     "Add credits at openrouter.ai/credits or raise the key's limit at openrouter.ai/keys."),
    (("(401)", "status_code: 401", "unauthorized", "invalid api key", "invalid_api_key"),
     "An API key was rejected.",
     "Check your OpenRouter key in Settings."),
    (("timed out", "connection", "name resolution", "network is unreachable"),
     "A network request failed.",
     "Check your internet connection and retry."),
    (("video download failed",),
     "The video could not be downloaded.",
     "Check the link opens in a browser and your connection works, then retry. You can also clip a local file instead."),
)


def describe_failure(error: object) -> dict:
    """Map an engine error to a safe, actionable message and hint."""
    text = str(error or "").lower()
    for markers, message, hint in FAILURES:
        if any(marker in text for marker in markers):
            return {"message": message, "hint": hint}
    return {"message": "The clipping pipeline failed.", "hint": "Check System check and retry. If it persists, report the steps that reproduce it."}


def reserve_stdout_for_protocol() -> None:
    """Keep stdout for JSON lines and send all other output to stderr.

    yt-dlp progress bars and FFmpeg children write to stdout. A partial line
    (no newline) glues itself to the next JSON message, and Electron then
    drops that message as non-JSON.
    """
    global _protocol
    _protocol = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)


def emit(msg: dict) -> None:
    """Write a JSON line to the protocol stream for Electron to read."""
    stream = _protocol or sys.stdout
    stream.write(json.dumps(msg) + "\n")
    stream.flush()


def progress_callback(progress) -> None:
    """Forward pipeline progress as JSON-line."""
    emit({
        "type": "progress",
        "status": progress.status.value if hasattr(progress.status, 'value') else str(progress.status),
        "percent": progress.progress_percent,
        "step": progress.current_step,
        "clips_done": progress.clips_completed,
        "clips_total": progress.total_clips,
        "stages": getattr(progress, "stages", None),
        "diagnostics": getattr(progress, "diagnostics", None),
    })


def _local_ai_ports() -> tuple[int, ...]:
    """Loopback ports the local AI backend may use (Ollama chat endpoint)."""
    from urllib.parse import urlparse

    base_url = os.environ.get("LOCAL_LLM_BASE_URL", "http://127.0.0.1:11434")
    try:
        parsed = urlparse(base_url if "://" in base_url else f"http://{base_url}")
        host = (parsed.hostname or "").lower()
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        # Only the machine itself; a LAN-hosted runtime stays blocked.
        if host in ("localhost", "127.0.0.1", "::1", "[::1]"):
            return (port,)
    except ValueError:
        pass
    return ()


def check_whisper_ready() -> "str | None":
    """Fail fast when the offline transcription runtime is missing."""
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        return ("Local transcription is not installed. Open Settings → Local AI and run "
                "the offline setup before clipping without a cloud provider.")
    return None


def check_ollama_ready(settings) -> "str | None":
    """Fail fast when the offline chat runtime is missing or has no model."""
    base_url = getattr(settings, "local_llm_base_url", "http://127.0.0.1:11434").rstrip("/")
    planner = getattr(settings, "planner_model", "qwen3:8b")
    try:
        import urllib.request
        with urllib.request.urlopen(f"{base_url}/api/tags", timeout=3) as response:
            tags = json.loads(response.read().decode("utf-8", "replace"))
    except Exception:
        return ("The local AI runtime (Ollama) is not running. Open Settings → Local AI "
                "and run the offline setup, or start Ollama, then retry.")
    installed = {model.get("name") or model.get("model") for model in tags.get("models", [])}
    if planner not in installed:
        return (f"The local model '{planner}' is not installed in Ollama. Open Settings → "
                "Local AI and run the offline setup to download it.")
    return None


def check_local_backend(settings) -> "str | None":
    """Fail fast with an actionable message when the offline stack is not ready."""
    return check_whisper_ready() or check_ollama_ready(settings)


def check_nvidia_backend() -> "str | None":
    """Fail fast when the NVIDIA backend's local whisper stack is not ready.

    NVIDIA NIM has no transcription endpoint, so the free backend transcribes
    with faster-whisper locally; the chat side only needs the API key.
    """
    return check_whisper_ready()


async def run(config: dict) -> bool:
    """Run the clipping pipeline with the given config."""
    config = validate_config(config)
    # Configure before BridgeClip imports: settings are cached by the engine.
    os.environ["LOCAL_MODE"] = "true"
    if config.get("output_dir"):
        os.environ["LOCAL_OUTPUT_DIR"] = config["output_dir"]
    # Downloads use the user's own connection. A developer's BridgeClip .env can
    # hold the server's proxy pool, and environment variables beat .env values.
    os.environ["YTDLP_PROXIES"] = ""
    os.environ["YTDLP_PROXY"] = ""
    # yt-dlp otherwise imports plugin code from config folders, including
    # /etc/yt-dlp, which Windows resolves to C:\etc (creatable by any user).
    os.environ["YTDLP_NO_PLUGINS"] = "1"
    os.environ["LAYOUT_VISION_ENABLED"] = "true" if config["layout_vision_enabled"] else "false"
    os.environ["CLIPPING_MODE"] = config.get("clipping_mode", "quality")
    backend = os.environ.get("AI_BACKEND", "cloud")
    local_backend = backend == "local"
    nvidia_backend = backend == "nvidia"
    if config.get("clipping_mode", "quality") == "economy":
        # Each job has its own bridge process, so model choices cannot leak to
        # another queued or concurrent run. Do not fall back to higher-cost planners.
        os.environ["PLANNER_FALLBACK_MODELS"] = ""
        os.environ["LAYOUT_VISION_ENABLED"] = "false"
        if not nvidia_backend:
            os.environ["PLANNER_MODEL"] = "z-ai/glm-5.3-flash"
            os.environ["EDITORIAL_REPAIR_MODEL"] = "google/gemini-3.8-flash"
    elif config.get("clipping_mode") == "advanced":
        # Advanced models come from the OpenRouter catalog; the NVIDIA backend
        # serves its own models and the UI does not offer the combination.
        if not nvidia_backend:
            os.environ["PLANNER_MODEL"] = config["planner_model"]
            os.environ["ADVANCED_TRANSCRIPTION_MODEL"] = config["transcription_model"]
        os.environ["PLANNER_FALLBACK_MODELS"] = ""
        os.environ["PLANNER_MAX_OUTPUT_TOKENS"] = str(config.get("planner_max_output_tokens", 32000))
        os.environ["PLANNER_SUPPORTS_IMAGES"] = str(config.get("planner_supports_images", False)).lower()
        for name in ("planner_input_price", "planner_output_price"):
            if config.get(name) is not None:
                os.environ[name.upper()] = str(config[name])

    if local_backend or nvidia_backend:
        # Cloud-only stages have no free equivalent: Jev decisions and web
        # research are OpenRouter services, and without a vision model smart
        # framing falls back to the bundled local YuNet face detector.
        os.environ["JEV_ENABLED"] = "false"
        os.environ["JEV_VISUAL_CONTEXT"] = "false"
        os.environ["SOURCE_CONTEXT_WEB_RESEARCH"] = "false"
        os.environ["LAYOUT_VISION_ENABLED"] = "false"

    from network_guard import install as install_network_guard
    install_network_guard(allowed_loopback_ports=_local_ai_ports() if local_backend else ())

    from clip_engine.logging_safety import install_safe_logging
    install_safe_logging()

    from clip_engine.bridge_contract import BRIDGE_CONTRACT_VERSION
    if config["contract_version"] != BRIDGE_CONTRACT_VERSION:
        emit({"type": "error", "message": "The bundled clipping engine is incompatible with this BridgeClip version."})
        return False

    from clip_engine.config import get_settings, get_caption_preset, apply_caption_style_overrides
    from clip_engine.services.ai_clipping_pipeline import (
        AIClippingPipeline,
        ClippingJobRequest,
        JobStatus,
    )

    settings = get_settings()

    missing = []
    if backend == "cloud" and not settings.openrouter_api_key:
        missing.append("OPENROUTER_API_KEY")
    if nvidia_backend and not settings.nvidia_api_key:
        missing.append("NVIDIA_API_KEY")
    if local_backend:
        local_error = check_local_backend(settings)
        if local_error:
            emit({"type": "error", "message": local_error})
            return False
    if nvidia_backend:
        nvidia_error = check_nvidia_backend()
        if nvidia_error:
            emit({"type": "error", "message": nvidia_error})
            return False
    if missing:
        emit({"type": "error", "message": f"Missing required API keys: {', '.join(missing)}"})
        return False

    caption_style = None
    preset_name = config.get("caption_preset", "pop")
    if config.get("include_captions", True):
        try:
            caption_style = get_caption_preset(preset_name)
        except ValueError:
            try:
                caption_style = get_caption_preset("pop")
            except ValueError:
                pass
        if caption_style is not None and isinstance(config.get("caption_style"), dict):
            try:
                caption_style = apply_caption_style_overrides(caption_style, config["caption_style"])
            except ValueError:
                pass

    duration_ranges = config.get("duration_ranges")

    video_source = config.get("video_url", "")
    if os.path.isfile(video_source):
        video_source = os.path.abspath(video_source)

    request = ClippingJobRequest(
        video_url=video_source,
        workflow=config.get('workflow', 'automatic'),
        caption_preset=preset_name,
        job_id=config.get("job_id"),
        max_clips=config.get("max_clips"),
        auto_clip_count=config.get("auto_clip_count", True),
        coverage=config.get("coverage", False),
        duration_ranges=duration_ranges,
        aspect_ratio=config.get("aspect_ratio", "9:16"),
        aspect_ratios=config.get("aspect_ratios"),
        layout_style=config.get("layout_style") or "auto",
        debug_capture=config.get("debug_capture", False),
        pacing=config.get("pacing") or "tight",
        video_speed=config.get("video_speed", 1.0),
        include_captions=config.get("include_captions", True),
        caption_style=caption_style,
        include_title=config.get("include_title", True),
        start_time_seconds=config.get("start_time_seconds"),
        end_time_seconds=config.get("end_time_seconds"),
        banner_platform=config.get("banner_platform"),
        banner_channel_url=config.get("banner_channel_url"),
        keyterms=config.get("keyterms") or None,
        srt_path=config.get("srt_path"),
        clip_request=config.get("clip_request"),
        logo=config.get("logo"),
        intro=config.get("intro"),
        outro=config.get("outro"),
        cta_badges=config.get("cta_badges") or [],
    )

    emit({
        "type": "progress",
        "status": "pending",
        "percent": 0,
        "step": "Starting pipeline...",
        "clips_done": 0,
        "clips_total": 0,
    })

    pipeline = AIClippingPipeline(progress_callback=progress_callback)
    start = time.monotonic()
    result = await pipeline.process_video(request)
    elapsed = time.monotonic() - start

    if result.status == JobStatus.COMPLETED and result.output:
        from dataclasses import asdict
        output_data = asdict(result.output)
        emit({
            "type": "result",
            "status": "completed",
            "job_id": result.job_id,
            "processing_time_seconds": elapsed,
            "output": output_data,
        })
        return True
    failure_code = getattr(result, "failure_code", None)
    failure_stage = getattr(result, "failure_stage", None)
    http_status = getattr(result, "http_status", None)
    diagnostic = {}
    if isinstance(failure_code, str) and re.fullmatch(r"[a-z]+(?:[._][a-z]+)*", failure_code) and len(failure_code) <= 64:
        diagnostic["code"] = failure_code
    if failure_stage in {"setup", "download", "transcription", "planning", "rendering", "saving", "uploading"}:
        diagnostic["stage"] = failure_stage
    if type(http_status) is int and 100 <= http_status <= 599:
        diagnostic["http_status"] = http_status
    emit({"type": "error", **describe_failure(result.error), **diagnostic})
    return False


def validate_config(config: object) -> dict:
    """Reject malformed bridge requests before loading the engine or writing files."""
    if not isinstance(config, dict):
        raise ValueError("Config must be a JSON object")
    if type(config.get("contract_version")) is not int or config["contract_version"] != 3:
        raise ValueError("Unsupported clipping engine contract version")
    if type(config.get("layout_vision_enabled")) is not bool:
        raise ValueError("layout_vision_enabled must be a boolean")
    job_id = config.get("job_id")
    if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job_id):
        raise ValueError("A valid job_id is required")
    source = config.get("video_url")
    if not isinstance(source, str) or not source.strip() or len(source) > 8192:
        raise ValueError("A video source is required")
    if not os.path.isfile(source):
        try:
            url = urlsplit(source)
            if url.scheme not in ("https", "http") or not url.hostname or url.username or url.password:
                raise ValueError()
        except ValueError:
            raise ValueError("Video source must be a local file or HTTP(S) URL") from None
    output = config.get("output_dir")
    if output is not None and (not isinstance(output, str) or not os.path.isabs(output) or "\0" in output):
        raise ValueError("Output directory must be an absolute path")
    for field in ("include_captions", "include_title", "auto_clip_count", "layout_vision_enabled", "debug_capture"):
        if field in config and not isinstance(config[field], bool):
            raise ValueError(f"{field} must be a boolean")
    if config.get('workflow', 'automatic') not in ('automatic', 'review'):
        raise ValueError('Invalid workflow')
    count = config.get("max_clips")
    if count is not None and (type(count) is not int or not 1 <= count <= 100):
        raise ValueError("max_clips must be between 1 and 100")
    if config.get("aspect_ratio", "9:16") not in ("9:16", "16:9", "1:1"):
        raise ValueError("Invalid aspect ratio")
    ratios = config.get("aspect_ratios")
    if ratios is not None and (
        not isinstance(ratios, list) or not 1 <= len(ratios) <= 3 or len(set(ratios)) != len(ratios) or
        any(not isinstance(ratio, str) or ratio not in ("9:16", "16:9", "1:1") for ratio in ratios)
    ):
        raise ValueError("Invalid aspect ratios")
    if config.get("workflow", "automatic") == "review" and (
        (ratios and len(ratios) > 1) or ("1:1" in (ratios or []) and config.get("aspect_ratio", "9:16") != "1:1")
    ):
        raise ValueError("Review & edit renders a single 9:16, 16:9 or 1:1 video")
    if config.get("layout_style", "auto") not in ("auto", "fill", "fit"):
        raise ValueError("Invalid layout style")
    if config.get("pacing", "tight") not in ("tight", "natural"):
        raise ValueError("Invalid pacing")
    speed = config.get("video_speed", 1.0)
    if type(speed) not in (int, float) or not 1 <= speed <= 2:
        raise ValueError("Video speed must be between 1x and 2x")
    if config.get("clipping_mode", "quality") not in ("quality", "economy", "advanced"):
        raise ValueError("Invalid clipping mode")
    for field in ("planner_model", "transcription_model"):
        if config.get("clipping_mode") == "advanced":
            value = config.get(field)
            if not isinstance(value, str) or len(value) > 120 or not re.fullmatch(r"~?[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:-]*", value):
                raise ValueError("Choose both models in Advanced mode")
        elif field in config:
            raise ValueError("Custom models require Advanced mode")
    if "planner_max_output_tokens" in config and (type(config["planner_max_output_tokens"]) is not int or not 1 <= config["planner_max_output_tokens"] <= 32000):
        raise ValueError("Invalid planner output limit")
    if "planner_supports_images" in config and type(config["planner_supports_images"]) is not bool:
        raise ValueError("Invalid planner image capability")
    for field in ("planner_input_price", "planner_output_price"):
        value = config.get(field)
        if value is not None and (type(value) not in (int, float) or not 0 <= value <= 1000):
            raise ValueError("Invalid planner price")
    keyterms = config.get("keyterms")
    if keyterms is not None and (
        not isinstance(keyterms, list) or len(keyterms) > 1000 or
        any(not isinstance(term, str) or not term.strip() or len(term) > 49 for term in keyterms)
    ):
        raise ValueError("Invalid keyterms")
    clip_request = config.get("clip_request")
    if clip_request is not None and (
        not isinstance(clip_request, str) or not clip_request.strip() or len(clip_request) > 1000 or "\0" in clip_request
    ):
        raise ValueError("Invalid clip request")
    ranges = config.get("duration_ranges")
    if ranges is not None and (
        not isinstance(ranges, list) or len(ranges) > len(DURATION_RANGE_IDS) or
        any(item not in DURATION_RANGE_IDS for item in ranges)
    ):
        raise ValueError("Invalid clip duration")
    # Brand-template overlays, snapshotted by main; the logo path is main-owned.
    logo = config.get("logo")
    if logo is not None:
        if not isinstance(logo, dict):
            raise ValueError("Invalid brand logo")
        path = logo.get("path")
        if not isinstance(path, str) or not os.path.isabs(path) or "\0" in path or len(path) > 4096:
            raise ValueError("Invalid brand logo path")
        if logo.get("position") not in ("top-left", "top-right", "bottom-left", "bottom-right", "center"):
            raise ValueError("Invalid brand logo position")
        for field, lo, hi in (("scale", 0.05, 0.5), ("opacity", 0.1, 1), ("margin", 0, 0.5)):
            value = logo.get(field)
            if field == "margin" and value is None:
                continue
            if type(value) not in (int, float) or not lo <= value <= hi:
                raise ValueError(f"Invalid brand logo {field}")
    # Intro/outro brand videos: only the main-owned snapshot path crosses the bridge.
    for slot in ("intro", "outro"):
        video = config.get(slot)
        if video is None:
            continue
        if not isinstance(video, dict):
            raise ValueError(f"Invalid brand {slot}")
        path = video.get("path")
        if not isinstance(path, str) or not os.path.isabs(path) or "\0" in path or len(path) > 4096:
            raise ValueError(f"Invalid brand {slot} path")
    badges = config.get("cta_badges")
    if badges is not None:
        if not isinstance(badges, list) or len(badges) > 4:
            raise ValueError("Invalid CTA badges")
        for badge in badges:
            if not isinstance(badge, dict):
                raise ValueError("Invalid CTA badges")
            if badge.get("kind") not in ("subscribe", "follow") or badge.get("position") not in (
                "top-left", "top-right", "bottom-left", "bottom-right", "center"
            ):
                raise ValueError("Invalid CTA badges")
            margin = badge.get("margin")
            if margin is not None and (type(margin) not in (int, float) or not 0 <= margin <= 0.5):
                raise ValueError("Invalid CTA badges")
    return config


def main() -> int:
    if len(sys.argv) > 2:
        emit({"type": "error", "message": "Pass JSON config on stdin."})
        return 1
    try:
        # Legacy CLI argument remains accepted; Electron uses stdin to keep
        # private source URLs out of process listings. Bound either transport.
        if len(sys.argv) == 2:
            raw = sys.argv[1]
        else:
            # Electron sends UTF-8; read bytes and decode explicitly so the
            # Windows text layer (ANSI code page) cannot mangle diacritics.
            stream = getattr(sys.stdin, 'buffer', None)
            raw = stream.read(65537).decode('utf-8') if stream is not None else sys.stdin.read(65537)
        if len(raw) > 65536:
            raise ValueError("Config too large")
        config = validate_config(json.loads(raw))
    except (ValueError, TypeError):
        emit({"type": "error", "message": "Invalid clipping configuration."})
        return 1
    try:
        return 0 if asyncio.run(run(config)) else 1
    except KeyboardInterrupt:
        emit({"type": "error", "message": "Pipeline cancelled by user"})
        return 130
    except Exception as error:
        # Provider exceptions can include request URLs, credentials and local paths.
        logger.error("Bridge runner failed (%s)", type(error).__name__)
        emit({"type": "error", "message": "The clipping engine failed. Check your setup and retry."})
        return 1


if __name__ == "__main__":
    reserve_stdout_for_protocol()
    sys.exit(main())
