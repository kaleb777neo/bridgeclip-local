"""Full-coverage planning: tiling counts, exhaustive prompt, gap top-up and
neighbour-aware extension. All offline; no network calls."""

import asyncio
from types import SimpleNamespace

import pytest

from clip_engine.config import Settings
from clip_engine.services.ai_clipping_pipeline import (
    AIClippingPipeline,
    ClippingJobRequest,
    format_duration_estimate,
    pace_eta_seconds,
    uncovered_gaps,
)
from clip_engine.services.intelligence_planner import (
    ClipPlanSegment,
    IntelligencePlannerService,
    coverage_clip_count,
)
from clip_engine.services.transcription_service import (
    TranscriptSegment,
    TranscriptionResult,
)


def make_planner(coverage=False, min_d=30, max_d=60, ranges=None):
    planner = IntelligencePlannerService()
    planner.settings = Settings(_env_file=None, openrouter_api_key="test")
    planner._jev_enabled = False
    planner._coverage = coverage
    planner._current_min_duration = min_d
    planner._current_max_duration = max_d
    planner._current_duration_ranges = ranges
    # An empty transcript keeps sentence snapping off, so spans stay exact.
    planner._current_transcript = []
    planner._start_time_seconds = None
    planner._end_time_seconds = None
    planner._current_target_platform = "tiktok"
    return planner


def completion(clips):
    import json
    content = json.dumps({"insights": "x", "clips": clips})
    return {"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}


def clip(start, end):
    return {
        "start_time": start, "end_time": end, "summary": "Title", "tags": [], "emphasis": [],
        "scores": {k: 5 for k in ("hook", "standalone", "arc", "quotability", "ending")},
    }


class TestCoverageClipCount:
    def test_tiles_the_range_with_target_length_clips(self):
        # short = 30-60s -> target 45s; a 30-minute video wants 40 clips.
        assert coverage_clip_count(1800, ["short"], None, absolute_cap=50, min_clips=3) == 40

    def test_long_ranges_tile_with_longer_targets(self):
        # long = 120-300s -> target 210s.
        assert coverage_clip_count(1800, ["long"], None, absolute_cap=50, min_clips=3) == 9

    def test_explicit_user_maximum_and_absolute_cap_still_apply(self):
        assert coverage_clip_count(1800, ["short"], 10, absolute_cap=50, min_clips=3) == 10
        assert coverage_clip_count(36000, ["short"], None, absolute_cap=12, min_clips=3) == 12

    def test_short_videos_keep_the_minimum(self):
        assert coverage_clip_count(60, ["short"], None, absolute_cap=50, min_clips=3) == 3

    def test_multi_hour_sources_are_not_cut_by_the_moments_cap(self):
        settings = Settings(_env_file=None, openrouter_api_key="test")
        assert settings.coverage_max_clips > settings.max_clips_absolute
        # A 3-hour show with 30-60s clips wants 240 — the coverage ceiling allows it.
        assert coverage_clip_count(3 * 3600, ["short"], None,
                                    absolute_cap=settings.coverage_max_clips,
                                    min_clips=settings.min_clips) == 240


class TestCoveragePrompt:
    def test_coverage_promptasks_for_exhaustive_chronological_extraction(self):
        prompt = make_planner(coverage=True)._build_system_prompt(12, 30, 60, ["short"])
        assert "Return exactly 12 clips as JSON" in prompt
        assert "exhaustive clipping editor" in prompt
        assert "COVERAGE: Extract EVERY distinct, complete moment" in prompt
        assert "chronologically" in prompt
        assert "NO OVERLAP" in prompt
        # Virality wording belongs to the default mode only.
        assert "scroll-stopping" not in prompt and "AI-Clipping-Agent" not in prompt

    def test_default_prompt_keeps_the_viral_role(self):
        prompt = make_planner(coverage=False)._build_system_prompt(12, 30, 60, ["short"])
        assert "AI-Clipping-Agent" in prompt and "exhaustive clipping editor" not in prompt


class TestNeighbourAwareExtension:
    def test_short_clip_extends_away_from_the_next_clip(self):
        # A ends 10s before B starts; extending A forward would walk into B,
        # so it grows backward and the two never overlap.
        planner = make_planner(min_d=30, max_d=60)
        plan = planner._parse_clip_plan_response(completion([clip(100, 120), clip(130, 160)]))
        spans = sorted((s.start_time_ms, s.end_time_ms) for s in plan.segments)
        for (_, a_end), (b_start, _) in zip(spans, spans[1:]):
            assert a_end <= b_start
        first = next(s for s in plan.segments if s.start_time_ms < 125000)
        assert first.start_time_ms == 90_000 and first.end_time_ms == 120_000

    def test_forward_extension_still_used_when_no_neighbour_blocks_it(self):
        planner = make_planner(min_d=30, max_d=60)
        plan = planner._parse_clip_plan_response(completion([clip(100, 120)]))
        assert plan.segments[0].start_time_ms == 100_000
        assert plan.segments[0].end_time_ms == 130_000


class TestUncoveredGaps:
    def test_empty_plan_leaves_the_whole_range(self):
        assert uncovered_gaps(0, 100_000, [], 30_000) == [(0, 100_000)]

    def test_middle_clip_leaves_both_edges(self):
        assert uncovered_gaps(0, 100_000, [(40_000, 60_000)], 30_000) == [(0, 40_000), (60_000, 100_000)]

    def test_gaps_shorter_than_one_clip_are_settled_not_missed(self):
        assert uncovered_gaps(0, 100_000, [(0, 90_000)], 30_000) == []
        assert uncovered_gaps(0, 100_000, [(0, 60_000)], 30_000) == [(60_000, 100_000)]

    def test_intervals_outside_the_range_are_clipped_away(self):
        assert uncovered_gaps(10_000, 90_000, [(0, 30_000), (70_000, 120_000)], 30_000) == [(30_000, 70_000)]


import time as _time


class TestProgressEstimates:
    def test_duration_estimates_read_naturally(self):
        assert format_duration_estimate(10) == "under a minute"
        assert format_duration_estimate(44) == "under a minute"
        assert format_duration_estimate(240) == "4 min"
        assert format_duration_estimate(90) == "2 min"
        assert format_duration_estimate(4_800) == "1 h 20 min"
        assert format_duration_estimate(7_200) == "2 h"

    def test_pace_eta_waits_for_the_first_clip_and_finishes_clean(self):
        started = _time.monotonic() - 60
        assert pace_eta_seconds(started, 0, 10) is None      # nothing landed yet
        assert pace_eta_seconds(started, 10, 10) is None      # done
        assert pace_eta_seconds(started, 1, 1) is None        # single-clip job: no estimate
        # 2 clips in 60 s, 8 to go -> about 4 minutes left.
        assert pace_eta_seconds(started, 2, 10) == pytest.approx(240)


class StubPlanner:
    """Returns one scripted batch of segments per call, recording the asks."""

    def __init__(self, batches):
        self.batches = list(batches)
        self.calls = []
        self.discovery_limit = None

    async def plan_clips(self, **kwargs):
        self.calls.append(kwargs)
        # Mimic the real planner: a single-shot request stores its count as
        # the job's discovery ceiling (see plan_clips / discovery_limit).
        if kwargs.get('max_clips') is not None:
            self.discovery_limit = kwargs['max_clips']
        batch = self.batches.pop(0) if self.batches else []
        return SimpleNamespace(segments=[ClipPlanSegment(s, e, .8, summary=f"Clip {s}") for s, e in batch])


def transcript_spanning(end_ms, step_ms=10_000):
    return [TranscriptSegment(t, t + step_ms - 1, f"line {t}", "S1")
            for t in range(0, end_ms, step_ms)]


class TestCoverageTopUp:
    def build_self(self, batches):
        planner = StubPlanner(batches)
        settings = Settings(_env_file=None, openrouter_api_key="test")
        fake = SimpleNamespace(
            intelligence_planner=planner,
            settings=settings,
            MAX_COVERAGE_PASSES=AIClippingPipeline.MAX_COVERAGE_PASSES,
            COVERAGE_GAPS_PER_PASS=AIClippingPipeline.COVERAGE_GAPS_PER_PASS,
            _update_progress=lambda *args, **kwargs: None,
        )
        return fake, planner

    def request(self):
        return ClippingJobRequest(video_url="x", coverage=True, duration_ranges=["short"], auto_clip_count=True)

    def test_gaps_are_planned_until_the_range_is_covered(self):
        fake, planner = self.build_self([
            [(60_000, 105_000)],       # pass 1: fills the middle gap
            [(105_000, 150_000)],      # pass 2: fills the tail gap
        ])
        kept = [ClipPlanSegment(0, 60_000, .9, summary="First")]
        result = asyncio.run(AIClippingPipeline._coverage_top_up(
            fake, kept, dict(), self.request(),
            TranscriptionResult(segments=transcript_spanning(150_000), full_text="t", provider="local"),
            video_end_ms=150_000, preferred_end_ms=150_000, job_id="job",
        ))
        spans = [(c.start_time_ms, c.end_time_ms) for c in result]
        assert spans == [(0, 60_000), (60_000, 105_000), (105_000, 150_000)]
        # Every top-up ask is bounded to its gap and asks for the tiling count.
        for call in planner.calls:
            assert call["coverage"] is True and call["auto_clip_count"] is False
            assert call["start_time_seconds"] >= 60 and call["end_time_seconds"] <= 150

    def test_gap_sub_requests_never_rewrite_the_job_ceiling(self):
        # The last gap asks for one clip; without the save/restore the planner's
        # discovery_limit would collapse the job's selection limit to 1.
        fake, planner = self.build_self([
            [(60_000, 105_000)],
            [(105_000, 150_000)],
        ])
        kept = [ClipPlanSegment(0, 60_000, .9, summary="First")]
        asyncio.run(AIClippingPipeline._coverage_top_up(
            fake, kept, dict(), self.request(),
            TranscriptionResult(segments=transcript_spanning(150_000), full_text="t", provider="local"),
            video_end_ms=150_000, preferred_end_ms=150_000, job_id="job",
        ))
        assert planner.calls
        assert planner.discovery_limit is None

    def test_duplicates_never_enter_and_an_empty_pass_stops_the_loop(self):
        fake, _ = self.build_self([
            [(0, 30_000)],             # overlaps the kept clip: rejected
        ])
        kept = [ClipPlanSegment(0, 60_000, .9, summary="First")]
        result = asyncio.run(AIClippingPipeline._coverage_top_up(
            fake, kept, dict(), self.request(),
            TranscriptionResult(segments=transcript_spanning(150_000), full_text="t", provider="local"),
            video_end_ms=150_000, preferred_end_ms=150_000, job_id="job",
        ))
        assert [(c.start_time_ms, c.end_time_ms) for c in result] == [(0, 60_000)]

    def test_a_failing_gap_does_not_sink_the_job(self):
        class FailingPlanner(StubPlanner):
            async def plan_clips(self, **kwargs):
                self.calls.append(kwargs)
                raise RuntimeError("model unavailable")

        planner = FailingPlanner([])
        fake = SimpleNamespace(
            intelligence_planner=planner,
            settings=Settings(_env_file=None, openrouter_api_key="test"),
            MAX_COVERAGE_PASSES=AIClippingPipeline.MAX_COVERAGE_PASSES,
            COVERAGE_GAPS_PER_PASS=AIClippingPipeline.COVERAGE_GAPS_PER_PASS,
            _update_progress=lambda *args, **kwargs: None,
        )
        kept = [ClipPlanSegment(0, 60_000, .9, summary="First")]
        result = asyncio.run(AIClippingPipeline._coverage_top_up(
            fake, kept, dict(), self.request(),
            TranscriptionResult(segments=transcript_spanning(150_000), full_text="t", provider="local"),
            video_end_ms=150_000, preferred_end_ms=150_000, job_id="job",
        ))
        assert [(c.start_time_ms, c.end_time_ms) for c in result] == [(0, 60_000)]
        # One gap remained (60s-150s), it was attempted once, and the empty pass ended the loop.
        assert len(planner.calls) == 1
