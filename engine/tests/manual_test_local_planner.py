"""Full local planning smoke test: real transcript -> IntelligencePlanner -> Ollama.

Run from engine/:
  .venv/Scripts/python -m tests.manual_test_local_planner [ollama_model]
"""
import asyncio
import os
import sys
import time
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("AI_BACKEND", "local")
os.environ.setdefault("LOCAL_WHISPER_MODEL", "large-v3-turbo")
os.environ.setdefault("BRIDGECLIP_MODELS_DIR", r"C:\Users\Administrator\AppData\Local\BridgeClip\models")
os.environ["LOCAL_PLANNER_MODEL"] = sys.argv[1] if len(sys.argv) > 1 else "qwen2.5:1.5b"
os.environ["TRANSCRIPTION_LANGUAGE"] = "en"

from clip_engine.config import get_settings
from clip_engine.services.transcription_service import TranscriptionService
from clip_engine.services.intelligence_planner import IntelligencePlannerService


async def main():
    settings = get_settings()
    print("backend:", settings.ai_backend, "| planner:", settings.planner_model)

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

asyncio.run(main())
