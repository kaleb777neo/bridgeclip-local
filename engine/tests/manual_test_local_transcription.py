"""End-to-end local transcription smoke test through TranscriptionService.

Run from engine/:
  .venv/Scripts/python -m tests.manual_test_local_transcription <audio.wav> [language]
"""
import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("AI_BACKEND", "local")
os.environ.setdefault("LOCAL_WHISPER_MODEL", "large-v3-turbo")
os.environ.setdefault("BRIDGECLIP_MODELS_DIR", r"C:\Users\Administrator\AppData\Local\BridgeClip\models")
if len(sys.argv) > 2:
    os.environ["TRANSCRIPTION_LANGUAGE"] = sys.argv[2]

from clip_engine.config import get_settings
from clip_engine.services.transcription_service import TranscriptionService


async def main():
    settings = get_settings()
    print("backend:", settings.ai_backend, "| whisper:", settings.local_whisper_model,
          "| language:", settings.transcription_language or "auto")
    service = TranscriptionService()
    started = time.perf_counter()
    result = await service.transcribe_audio(sys.argv[1])
    elapsed = time.perf_counter() - started
    print("transcript:", result.full_text[:300])
    print("language:", result.language, "| segments:", len(result.segments),
          "| words:", sum(len(s.words) for s in result.segments))
    print("model:", result.model, "| cost: $%.4f" % (result.api_costs.estimated_cost_usd if result.api_costs else 0))
    if result.segments:
        first = result.segments[0].words[0]
        last = result.segments[-1].words[-1]
        print("first word: %r @ %d-%d ms | last word: %r @ %d-%d ms" % (
            first.word, first.start_time_ms, first.end_time_ms,
            last.word, last.start_time_ms, last.end_time_ms))
    print("elapsed: %.1fs (audio %.1fs)" % (elapsed, result.duration_seconds or 0))

asyncio.run(main())
