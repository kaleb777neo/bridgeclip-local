"""NVIDIA planning smoke test: real transcript -> Whisper -> NIM planner.

Uses the free build.nvidia.com tier, so it spends a few of its credits.
Set your key first:

  set NVIDIA_API_KEY=nvapi-...
  .venv/Scripts/python -m tests.manual_test_nvidia_planner [nvidia_model]
"""
import asyncio
import os
import sys
import time
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("AI_BACKEND", "nvidia")
os.environ.setdefault("LOCAL_WHISPER_MODEL", "large-v3-turbo")
os.environ.setdefault(
    "BRIDGECLIP_MODELS_DIR",
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "BridgeClip", "models"),
)
if len(sys.argv) > 1:
    os.environ["NVIDIA_PLANNER_MODEL"] = sys.argv[1]
os.environ["TRANSCRIPTION_LANGUAGE"] = "en"

if not os.environ.get("NVIDIA_API_KEY"):
    sys.exit("Set NVIDIA_API_KEY (nvapi-..., from build.nvidia.com) first.")

import httpx

from clip_engine.config import get_settings
from clip_engine.services.transcription_service import TranscriptionService
from clip_engine.services.intelligence_planner import IntelligencePlannerService


async def check_catalog(settings):
    """Confirm the configured slugs exist on the live NIM catalog."""
    async with httpx.AsyncClient(
        base_url=settings.llm_base_url,
        headers={"Authorization": f"Bearer {settings.llm_api_key}"},
        timeout=30.0,
    ) as client:
        response = await client.get("/models")
        response.raise_for_status()
        available = {model.get("id") for model in response.json().get("data", [])}
    for slug in (settings.planner_model, settings.nvidia_repair_model):
        print(("OK  " if slug in available else "MISS"), slug)
    return available


async def main():
    settings = get_settings()
    print("backend:", settings.ai_backend, "| planner:", settings.planner_model,
          "| endpoint:", settings.llm_base_url)
    await check_catalog(settings)

    transcription = TranscriptionService()
    transcript = await transcription.transcribe_audio(os.path.join("tests", "test_speech.wav"))
    print("transcript words:", sum(len(s.words) for s in transcript.segments))

    planner = IntelligencePlannerService()
    started = time.perf_counter()
    plan = await planner.plan_clips(
        transcript,
        video_metadata=SimpleNamespace(duration_seconds=transcript.duration_seconds),
        max_clips=2,
        auto_clip_count=False,
        min_duration_seconds=5,
        max_duration_seconds=20,
    )
    elapsed = time.perf_counter() - started
    print("planning seconds: %.1f" % elapsed)
    print("clips planned:", plan.total_clips)
    for clip in plan.segments:
        print("  %.1fs-%.1fs score=%.2f title=%r tags=%s" % (
            clip.start_time_ms / 1000, clip.end_time_ms / 1000,
            clip.virality_score, clip.summary, clip.tags))
    print("insights:", (plan.insights or "")[:200])
    if plan.api_costs:
        print("cost: $%.6f via %s (attempts=%d)" % (
            plan.api_costs.estimated_cost_usd, plan.api_costs.provider, plan.api_costs.attempts))


asyncio.run(main())
