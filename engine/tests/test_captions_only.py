"""Captions-only mode: the whole range becomes one captioned clip, planner skipped."""
import asyncio
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from clip_engine.config import get_settings
from clip_engine.services import ai_clipping_pipeline as pipeline_module
from clip_engine.services.ai_clipping_pipeline import AIClippingPipeline, ClippingJobRequest
from clip_engine.services.intelligence_planner import ClipPlanResponse, ClipPlanSegment
from clip_engine.services.rendering_service import RenderingService, RenderResult
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord, TranscriptionResult


@pytest.fixture()
def run_captions_only(monkeypatch, tmp_path):
    settings = pipeline_module.get_settings()
    monkeypatch.setattr(settings, "local_mode", True)
    monkeypatch.setattr(settings, "local_output_dir", str(tmp_path / "out"))
    monkeypatch.setattr(settings.__class__, "temp_directory", property(lambda self: str(tmp_path / "work")))
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    pipeline = AIClippingPipeline()
    pipeline.local_mode = True

    async def download(url, output_dir):
        meta = SimpleNamespace(title="Long talk", duration_seconds=120.0, width=1920, height=1080)
        source = os.path.join(output_dir, "source.mp4")
        with open(source, "wb") as f:
            f.write(b"source")
        return SimpleNamespace(video_path=source, metadata=meta, file_size_bytes=1)

    async def transcribe(video_path, work_dir, keyterms=None, **_range):
        words = [TranscriptWord("hello", 0, 800)]
        return TranscriptionResult(segments=[TranscriptSegment(0, 800, "hello", words=words)], full_text="hello")

    async def plan(**kwargs):  # pragma: no cover - must never run in captions-only
        raise AssertionError("planner must be skipped in captions-only mode")

    requests = []

    async def render(request):
        requests.append(request)
        open(request.output_path, "wb").write(b"mp4")
        from clip_engine.services.layout_analyzer import ClipLayoutPlan, LayoutType, ShotLayout
        from clip_engine.services.clip_editor import TimeMap
        used_plan = ClipLayoutPlan(shots=[ShotLayout(0, 120_000, LayoutType.TALKING_HEAD, source='fallback')],
                                   source_width=1920, source_height=1080, face_samples=[])
        used_map = TimeMap([(0, 120_000)], 120_000)
        return RenderResult(output_path=request.output_path, file_size_bytes=3, duration_ms=120_000,
                            layout_type="talking_head", layout_cost_usd=0.0,
                            used_plan=used_plan, used_time_map=used_map)

    monkeypatch.setattr(pipeline.video_downloader, "download_video", download)
    monkeypatch.setattr(pipeline.transcription_service, "transcribe", transcribe)
    monkeypatch.setattr(pipeline.intelligence_planner, "plan_clips", plan)
    monkeypatch.setattr(pipeline.rendering_service, "render_clip", render)
    return SimpleNamespace(pipeline=pipeline, requests=requests, tmp_path=tmp_path)


def test_captions_only_skips_planning_and_captions_the_whole_range(run_captions_only):
    run = run_captions_only
    result = asyncio.run(run.pipeline.process_video(ClippingJobRequest(
        video_url="local.mp4", job_id="captions-only", workflow="captions-only",
        aspect_ratio="9:16", include_captions=True, caption_preset="karaoke", include_title=True,
    )))
    assert result.status.value == "completed"
    assert result.output.total_clips == 1
    assert len(run.requests) == 1
    request = run.requests[0]
    assert (request.start_time_ms, request.end_time_ms) == (0, 120_000)
    assert request.include_captions is True
    assert request.include_title is False, "no title card on a captioned whole video"
    assert request.apply_padding is False, "padding would extend beyond the source"


def test_captions_only_honors_the_trim_range(run_captions_only):
    result = asyncio.run(run_captions_only.pipeline.process_video(ClippingJobRequest(
        video_url="local.mp4", job_id="captions-trim", workflow="captions-only",
        aspect_ratio="9:16", include_captions=True,
        start_time_seconds=10, end_time_seconds=60,
    )))
    assert result.output.total_clips == 1
    assert (run_captions_only.requests[0].start_time_ms, run_captions_only.requests[0].end_time_ms) == (10_000, 60_000)


def test_captions_only_rejects_tiny_ranges(run_captions_only):
    from clip_engine.services.ai_clipping_pipeline import JobStatus
    result = asyncio.run(run_captions_only.pipeline.process_video(ClippingJobRequest(
        video_url="local.mp4", job_id="captions-tiny", workflow="captions-only",
        aspect_ratio="9:16", include_captions=True, start_time_seconds=5, end_time_seconds=5.2,
    )))
    assert result.status == JobStatus.FAILED
