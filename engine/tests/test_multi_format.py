"""
Faza B (multi-format): 1:1 square output and per-clip format variants.

A 1:1 request renders on a 1080x1080 canvas through the same smart-framing
path as 9:16 (never the landscape branch). Variant renders reuse the primary
clip's analyzed plan and edit map, so no second vision or pacing call runs
and their vision cost reports zero. Variant files are named
clip_{i:02d}_{ratio}.mp4 with x for : (illegal on Windows). Review & edit
rejects 1:1 and multi-ratio jobs in both the engine request and the desktop
bridge config gate. FFmpeg is stubbed: these check which edit gets rendered.
"""

import asyncio
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from clip_engine.config import AspectRatioType, get_output_dimensions, is_longform
from clip_engine.services import ai_clipping_pipeline as pipeline_module
from clip_engine.services.ai_clipping_pipeline import (
    AIClippingPipeline,
    ClippingJobRequest,
    JobStatus,
    VALID_ASPECT_RATIOS,
    variant_suffix,
)
from clip_engine.services.clip_editor import TimeMap
from clip_engine.services.intelligence_planner import ClipPlanResponse, ClipPlanSegment
from clip_engine.services.layout_analyzer import Box, ClipLayoutPlan, LayoutType, ShotLayout
from clip_engine.services.rendering_service import RenderingError, RenderingService, RenderRequest, RenderResult
from clip_engine.services.transcription_service import TranscriptionResult, TranscriptSegment, TranscriptWord


def smart_plan(window_ms: int) -> ClipLayoutPlan:
    return ClipLayoutPlan(
        shots=[ShotLayout(0, window_ms, LayoutType.SCREEN_CAM, source="vision",
                          cam_box=Box(0.62, 0.55, 0.36, 0.43), screen_box=Box(0, 0, 1, 1))],
        source_width=1920, source_height=1080, vision_cost_usd=0.002,
    )


@pytest.fixture
def service(monkeypatch):
    """RenderingService with FFmpeg, analysis and the edit graph stubbed out.

    svc.calls['layout'] lists the aspect ratios that ran layout analysis;
    svc.calls['render'] lists the (width, height, landscape, fps, time_map)
    each _render_edit step received.
    """
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    svc = RenderingService()
    calls = {"layout": [], "render": []}

    async def dims(_path):
        return 1920, 1080

    async def probe_fps(_path):
        return "60"

    async def plan_layout(request, src_w, src_h, window_start_ms, window_ms):
        calls["layout"].append(request.aspect_ratio)
        return smart_plan(window_ms)

    async def render_edit(request, plan, time_map, window_start_ms, window_ms,
                          target_width, target_height, is_landscape, fps, loudness_filter=None):
        calls["render"].append((target_width, target_height, is_landscape, fps, time_map))
        with open(request.output_path, "wb") as f:
            f.write(b"mp4")

    monkeypatch.setattr(svc, "_get_video_dimensions", dims)
    monkeypatch.setattr(svc, "_probe_fps", probe_fps)
    monkeypatch.setattr(svc, "_plan_layout", plan_layout)
    monkeypatch.setattr(svc, "_render_edit", render_edit)
    svc.calls = calls
    return svc


def request_for(tmp_path, **kwargs) -> RenderRequest:
    return RenderRequest(
        video_path="src.mp4", output_path=str(tmp_path / "clip.mp4"),
        start_time_ms=0, end_time_ms=10000, source_width=1920, source_height=1080,
        **kwargs,
    )


class TestSquareFormat:
    def test_square_ratio_and_output_dimensions(self):
        assert AspectRatioType.SQUARE == "1:1"
        assert get_output_dimensions("1:1") == (1080, 1080)
        assert get_output_dimensions("9:16") == (1080, 1920)
        assert get_output_dimensions("16:9") == (1920, 1080)
        assert VALID_ASPECT_RATIOS == ("9:16", "16:9", "1:1")

    def test_square_is_never_longform(self):
        # Longform is 16:9-only; a 5-minute 1:1 job stays a short-form edit.
        assert not is_longform("1:1", 600)
        assert is_longform("16:9", 600)

    def test_variant_suffix_is_windows_file_safe(self):
        assert variant_suffix("1:1") == "1x1"
        assert variant_suffix("16:9") == "16x9"
        assert variant_suffix("9:16") == "9x16"
        assert all(":" not in variant_suffix(r) and "/" not in variant_suffix(r) for r in VALID_ASPECT_RATIOS)

    def test_square_renders_through_the_vertical_framing_path(self, service, tmp_path):
        result = asyncio.run(service.render_clip(request_for(tmp_path, aspect_ratio="1:1")))
        # Smart framing analysis runs for square, like 9:16 (landscape skips it).
        assert service.calls["layout"] == ["1:1"]
        target_width, target_height, is_landscape, fps, _ = service.calls["render"][0]
        assert (target_width, target_height) == (1080, 1080)
        assert is_landscape is False
        # Vertical/square renders keep the fixed 30 fps plan (no source probe).
        assert fps == "30"
        assert (result.output_width, result.output_height) == (1080, 1080)
        assert result.layout_type == LayoutType.SCREEN_CAM  # not the landscape "fit"
        assert result.layout_cost_usd == pytest.approx(0.002)

    def test_landscape_branch_stays_landscape(self, service, tmp_path):
        result = asyncio.run(service.render_clip(request_for(tmp_path, aspect_ratio="16:9")))
        assert service.calls["layout"] == []
        target_width, target_height, is_landscape, fps, _ = service.calls["render"][0]
        assert (target_width, target_height) == (1920, 1080)
        assert is_landscape is True
        assert fps == "60"  # landscape follows the source frame rate
        assert result.layout_type == "fit"


class TestPrecomputedPlan:
    """Variant renders must reuse the primary's plan and edit map verbatim."""

    def test_variant_skips_all_reanalysis_and_reports_zero_vision_cost(self, service, tmp_path):
        plan = smart_plan(10000)
        time_map = TimeMap([(0, 4000), (6000, 10000)], 10000)
        result = asyncio.run(service.render_clip(request_for(
            tmp_path, aspect_ratio="1:1", apply_padding=False,
            precomputed_plan=plan, precomputed_time_map=time_map,
        )))
        # No layout analysis, no pacing analysis: the primary already paid for it.
        assert service.calls["layout"] == []
        target_width, target_height, is_landscape, _, used_map = service.calls["render"][0]
        assert (target_width, target_height, is_landscape) == (1080, 1080, False)
        assert used_map is time_map
        assert result.used_plan is plan
        assert result.used_time_map is time_map
        # The reused plan carried vision cost; the variant itself must bill none.
        assert plan.vision_cost_usd == pytest.approx(0.002)
        assert result.layout_cost_usd == 0.0

    def test_precomputed_time_map_must_match_the_render_window(self, service, tmp_path):
        with pytest.raises(RenderingError, match="time map"):
            asyncio.run(service.render_clip(request_for(
                tmp_path, aspect_ratio="1:1", apply_padding=False,
                precomputed_plan=smart_plan(9000), precomputed_time_map=TimeMap([(0, 9000)], 9000),
            )))


class TestJobRequestRatios:
    def test_defaults_to_the_single_primary_ratio(self):
        request = ClippingJobRequest(video_url="v", job_id="j", aspect_ratio="1:1")
        assert request.aspect_ratios == ["1:1"]

    def test_multi_ratio_list_is_kept_in_order(self):
        request = ClippingJobRequest(
            video_url="v", job_id="j", aspect_ratio="9:16", aspect_ratios=["9:16", "1:1", "16:9"],
        )
        assert request.aspect_ratios == ["9:16", "1:1", "16:9"]

    def test_duplicate_ratios_collapse(self):
        request = ClippingJobRequest(
            video_url="v", job_id="j", aspect_ratio="9:16", aspect_ratios=["9:16", "9:16"],
        )
        assert request.aspect_ratios == ["9:16"]

    @pytest.mark.parametrize("ratios", [["16:9", "9:16"], ["1:1", "9:16"], ["1:1", "16:9", "9:16"]])
    def test_primary_must_be_the_first_ratio(self, ratios):
        # aspect_ratio stays the primary; a list that starts elsewhere is a bug.
        with pytest.raises(ValueError, match="first"):
            ClippingJobRequest(video_url="v", job_id="j", aspect_ratio="9:16", aspect_ratios=ratios)

    @pytest.mark.parametrize("ratios,primary", [
        (["9:16", "4:3"], "9:16"),                # unknown ratio
        (["9:16", "16:9", "1:1", "4:3"], "9:16"),  # more than 3 formats
        (["9x16"], "9x16"),                       # malformed primary
        ([True], "9:16"),                         # non-string entry
    ])
    def test_invalid_ratio_lists_are_rejected(self, ratios, primary):
        with pytest.raises(ValueError):
            ClippingJobRequest(video_url="v", job_id="j", aspect_ratio=primary, aspect_ratios=ratios)

    def test_review_workflow_rejects_square_and_multi_ratio(self):
        with pytest.raises(ValueError, match="single 9:16, 16:9 or 1:1"):
            ClippingJobRequest(video_url="v", job_id="j", aspect_ratio="9:16", workflow="review",
                               aspect_ratios=["9:16", "1:1"])
        with pytest.raises(ValueError, match="single 9:16, 16:9 or 1:1"):
            ClippingJobRequest(video_url="v", job_id="j", aspect_ratio="9:16", workflow="review",
                               aspect_ratios=["9:16", "16:9"])

    def test_review_workflow_accepts_square_primary(self):
        request = ClippingJobRequest(video_url="v", job_id="j", aspect_ratio="1:1", workflow="review")
        assert request.aspect_ratio == "1:1"
        request = ClippingJobRequest(video_url="v", job_id="j", aspect_ratio="1:1", workflow="review",
                                     aspect_ratios=["1:1"])
        assert request.aspect_ratios == ["1:1"]

    @pytest.mark.parametrize("primary", ["9:16", "16:9"])
    def test_review_workflow_keeps_single_format_jobs(self, primary):
        request = ClippingJobRequest(video_url="v", job_id="j", aspect_ratio=primary, workflow="review")
        assert request.aspect_ratios == [primary]


def load_bridge_runner():
    spec = importlib.util.spec_from_file_location(
        "bridge_runner_multi_format", Path(__file__).parents[2] / "bridge" / "bridge_runner.py")
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    return bridge


@pytest.fixture(scope="module")
def validate():
    return load_bridge_runner().validate_config


class TestBridgeConfigGate:
    @staticmethod
    def config(**overrides):
        base = {
            "contract_version": 3, "layout_vision_enabled": True, "job_id": "job-1",
            "video_url": "https://example.com/video.mp4", "aspect_ratio": "9:16",
        }
        return {**base, **overrides}

    @pytest.mark.parametrize("ratios", [None, ["9:16"], ["1:1"], ["9:16", "1:1"], ["16:9", "1:1"]])
    def test_valid_format_lists_pass(self, validate, ratios):
        config = self.config(aspect_ratio=(ratios or ["9:16"])[0])
        if ratios is not None:
            config["aspect_ratios"] = ratios
        passed = validate(config)
        assert passed.get("aspect_ratios", [passed["aspect_ratio"]]) == (ratios or [passed["aspect_ratio"]])

    @pytest.mark.parametrize("ratios", [
        [], ["9:16", "9:16"], ["9:16", "4:3"], ["9:16", "1:1", "16:9", "9:16"],
        "9:16", ["9x16"], [True],
    ])
    def test_invalid_format_lists_are_rejected(self, validate, ratios):
        with pytest.raises(ValueError, match="aspect ratio"):
            validate(self.config(aspect_ratio="9:16", aspect_ratios=ratios))

    def test_square_primary_passes_the_gate(self, validate):
        assert validate(self.config(aspect_ratio="1:1"))["aspect_ratio"] == "1:1"

    @pytest.mark.parametrize("primary,ratios", [
        ("9:16", ["9:16", "1:1"]), ("9:16", ["9:16", "16:9"]), ("1:1", ["1:1", "9:16"]),
    ])
    def test_review_rejects_square_and_multi_format(self, validate, primary, ratios):
        config = self.config(aspect_ratio=primary, workflow="review")
        if ratios is not None:
            config["aspect_ratios"] = ratios
        with pytest.raises(ValueError, match="single 9:16, 16:9 or 1:1"):
            validate(config)

    def test_review_accepts_square_primary(self, validate):
        # 1:1 in the editor: a single square primary passes the review gate.
        assert validate(self.config(aspect_ratio="1:1", workflow="review"))["aspect_ratio"] == "1:1"
        assert validate(self.config(aspect_ratio="1:1", workflow="review", aspect_ratios=["1:1"]))["aspect_ratios"] == ["1:1"]

    def test_review_keeps_single_format_and_automatic_keeps_multi(self, validate):
        assert validate(self.config(workflow="review"))["workflow"] == "review"
        assert validate(self.config(aspect_ratio="16:9", workflow="review",
                                    aspect_ratios=["16:9"]))["aspect_ratios"] == ["16:9"]
        assert validate(self.config(aspect_ratios=["9:16", "1:1", "16:9"]))["aspect_ratios"] == ["9:16", "1:1", "16:9"]


def test_saved_local_outputs_carry_variant_files(monkeypatch, tmp_path):
    """clip_{i:02d}_{ratio}.mp4 naming and the variants list in the artifact."""
    pipeline = AIClippingPipeline.__new__(AIClippingPipeline)
    pipeline.settings = SimpleNamespace(local_output_dir=str(tmp_path / "out"))
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"primary")
    square = tmp_path / "variant_1x1.mp4"
    square.write_bytes(b"square")
    landscape = tmp_path / "variant_16x9.mp4"
    landscape.write_bytes(b"landscape")
    segment = ClipPlanSegment(0, 10000, 0.8, variants=[
        {"aspect_ratio": "1:1", "path": str(square)},
        {"aspect_ratio": "16:9", "path": str(landscape)},
    ])

    artifacts = pipeline._save_clips_locally("job1", [(str(source), segment)])

    output_dir = tmp_path / "out" / "job1"
    assert sorted(p.name for p in output_dir.glob("clip_*.mp4")) == [
        "clip_00.mp4", "clip_00_16x9.mp4", "clip_00_1x1.mp4",
    ]
    assert (output_dir / "clip_00_1x1.mp4").read_bytes() == b"square"
    variants = artifacts[0].variants
    assert [v["aspect_ratio"] for v in variants] == ["1:1", "16:9"]
    assert variants[0]["s3_url"].endswith(os.path.join("clip_00_1x1.mp4"))
    assert variants[1]["s3_url"].startswith("file://")


def run_pipeline_with_formats(monkeypatch, tmp_path, fail_for=()):
    """Automatic job with aspect_ratios=['9:16','1:1','16:9']; FFmpeg stubbed."""
    settings = pipeline_module.get_settings()
    monkeypatch.setattr(settings, "local_mode", True)
    monkeypatch.setattr(settings, "local_output_dir", str(tmp_path / "out"))
    monkeypatch.setattr(settings.__class__, "temp_directory", property(lambda self: str(tmp_path / "work")))
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    pipeline = AIClippingPipeline()
    pipeline.local_mode = True

    async def download(url, output_dir):
        meta = SimpleNamespace(title="Test", duration_seconds=30.0, width=1920, height=1080)
        source = os.path.join(output_dir, "source.mp4")
        with open(source, "wb") as f:
            f.write(b"source")
        return SimpleNamespace(video_path=source, metadata=meta, file_size_bytes=1)

    async def transcribe(video_path, work_dir, keyterms=None, **_range):
        words = [TranscriptWord("hi", 0, 500)]
        return TranscriptionResult(segments=[TranscriptSegment(0, 500, "hi", words=words)], full_text="hi")

    async def plan(**kwargs):
        return ClipPlanResponse(segments=[ClipPlanSegment(0, 20_000, 0.8, summary="One")], total_clips=1)

    used_plan, used_map = smart_plan(21_000), TimeMap([(0, 21_000)], 21_000)
    requests = []

    async def render(request):
        requests.append(request)
        if request.aspect_ratio in fail_for:
            raise RenderingError(f"synthetic {request.aspect_ratio} variant failure")
        open(request.output_path, "wb").write(b"mp4")
        if request.precomputed_plan is None:
            return RenderResult(output_path=request.output_path, file_size_bytes=3, duration_ms=20_000,
                                layout_type="talking_head", layout_cost_usd=0.002,
                                used_plan=used_plan, used_time_map=used_map)
        return RenderResult(output_path=request.output_path, file_size_bytes=3, duration_ms=20_000,
                            layout_type="talking_head", layout_cost_usd=0.0,
                            used_plan=request.precomputed_plan, used_time_map=request.precomputed_time_map)

    monkeypatch.setattr(pipeline.video_downloader, "download_video", download)
    monkeypatch.setattr(pipeline.transcription_service, "transcribe", transcribe)
    monkeypatch.setattr(pipeline.intelligence_planner, "plan_clips", plan)
    monkeypatch.setattr(pipeline.rendering_service, "render_clip", render)

    result = asyncio.run(pipeline.process_video(ClippingJobRequest(
        video_url="local.mp4", job_id="formats", aspect_ratio="9:16", aspect_ratios=["9:16", "1:1", "16:9"],
    )))
    return SimpleNamespace(result=result, requests=requests, plan=used_plan, map=used_map)


class TestPipelineVariants:
    def test_variants_reuse_the_primary_plan_and_are_saved_per_format(self, monkeypatch, tmp_path):
        run = run_pipeline_with_formats(monkeypatch, tmp_path)
        result, requests = run.result, run.requests
        assert result.status == JobStatus.COMPLETED, result.error

        # Primary first, then one render per extra format.
        assert [r.aspect_ratio for r in requests] == ["9:16", "1:1", "16:9"]
        primary, square, landscape = requests
        assert primary.precomputed_plan is None
        # Both variants carry the primary's analyzed plan and edit map
        # unchanged: no second vision or pacing pass.
        assert square.precomputed_plan is run.plan
        assert square.precomputed_time_map is run.map
        assert landscape.precomputed_plan is run.plan
        assert landscape.precomputed_time_map is run.map
        for variant, suffix in ((square, "1x1"), (landscape, "16x9")):
            assert variant.output_path.endswith(f"clip_00_{suffix}.mp4")
            # The primary's editorial pass already reviewed this edit; variants
            # must not re-run Jev or repeat the debug capture.
            assert variant.editorial_context is None
            assert variant.editorial_service is None
            assert variant.coherence_reviewer is None
            assert variant.debug_capture is False

        clip = result.output.clips[0]
        assert [v["aspect_ratio"] for v in clip.variants] == ["1:1", "16:9"]
        manifest = json.loads((tmp_path / "out" / "formats" / "job_output.json").read_text())
        assert [v["aspect_ratio"] for v in manifest["clips"][0]["variants"]] == ["1:1", "16:9"]
        for suffix in ("clip_00.mp4", "clip_00_1x1.mp4", "clip_00_16x9.mp4"):
            assert (tmp_path / "out" / "formats" / suffix).is_file()
        # The requested formats are echoed in the metrics for the UI.
        assert manifest["metrics"]["requested_settings"]["aspect_ratios"] == ["9:16", "1:1", "16:9"]
        # Vision cost is booked once: variants reuse the analyzed plan.
        assert manifest["metrics"]["api_costs"]["layout_vision"]["estimated_cost_usd"] == pytest.approx(0.002)

    def test_a_failed_variant_only_loses_that_variant(self, monkeypatch, tmp_path):
        run = run_pipeline_with_formats(monkeypatch, tmp_path, fail_for=("16:9",))
        result, requests = run.result, run.requests
        assert result.status == JobStatus.COMPLETED, result.error
        assert [r.aspect_ratio for r in requests] == ["9:16", "1:1", "16:9"]
        clip = result.output.clips[0]
        assert [v["aspect_ratio"] for v in clip.variants] == ["1:1"]
        output_dir = tmp_path / "out" / "formats"
        assert (output_dir / "clip_00_1x1.mp4").is_file()
        assert not (output_dir / "clip_00_16x9.mp4").exists()
