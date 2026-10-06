"""Regressions for the mouth-motion tiebreak that picks the talking subject.

When two people share the frame and neither dominates, the largest face may
be a listener leaning toward the camera. These tests cover the candidate
selection, the motion evidence gate, and the retargeted focus path.
"""
import asyncio

import numpy as np
import pytest

from clip_engine.services.layout_analyzer import (
    Box, FrameInfo, LayoutType, LayoutAnalyzer, LIP_FPS,
    _box_at, _mouth_crop, apply_speaker_timeline, competing_faces, heuristic_layout,
    pick_speaker_timeline, pick_talking_track, track_faces,
)


# ---------------------------------------------------------------------------
# competing_faces: which shots deserve a decode

def test_no_rival_when_a_single_face_dominates():
    big = Box(.3, .2, .3, .5)
    observations = [FrameInfo(t, [big], None) for t in range(0, 8000, 250)]
    assert competing_faces(track_faces(observations), len(observations)) is None


def test_split_screen_two_faces_get_a_tiebreak():
    # Two comparable faces far apart (a broadcast split screen) can never share
    # a narrow talking-head crop, so the camera must decode who is talking
    # rather than assume both are framed.
    left, right = Box(.18, .2, .14, .3), Box(.65, .2, .14, .3)
    observations = [FrameInfo(t, [left, right], None) for t in range(0, 8000, 250)]
    rivals = competing_faces(track_faces(observations), len(observations))
    assert rivals is not None and len(rivals) == 2
    assert rivals[0].median_box().cx < rivals[1].median_box().cx


def test_tiny_corner_face_is_not_a_rival():
    big, overlay = Box(.4, .2, .2, .44), Box(.02, .02, .1, .12)
    observations = [FrameInfo(t, [big, overlay], None) for t in range(0, 8000, 250)]
    assert competing_faces(track_faces(observations), len(observations)) is None


def test_leaning_listener_counts_as_a_rival():
    # Larger and less than 0.22 from the speaker in cx (the two-shot gate
    # fails on separation): the camera locks on the largest face — exactly
    # the ambiguous case worth a decode.
    listener, speaker = Box(.30, .18, .16, .34), Box(.46, .24, .13, .28)
    observations = [FrameInfo(t, [listener, speaker], None) for t in range(0, 8000, 250)]
    rivals = competing_faces(track_faces(observations), len(observations))
    assert rivals is not None and len(rivals) == 2
    # Largest first: rivals[0] is whoever the camera currently follows.
    assert rivals[0].median_box().area > rivals[1].median_box().area


# ---------------------------------------------------------------------------
# _box_at: interpolating face positions onto the 12 fps decode grid

def test_box_at_interpolates_between_detections():
    a, b = Box(.1, .1, .1, .1), Box(.3, .1, .1, .1)
    box = _box_at([(0, a), (1000, b)], 500)
    assert box.cx == pytest.approx(.25)


def test_box_at_holds_past_the_ends():
    a, b = Box(.1, .1, .1, .1), Box(.3, .1, .1, .1)
    assert _box_at([(1000, a), (2000, b)], 900) == a
    assert _box_at([(1000, a), (2000, b)], 2200) == b
    assert _box_at([(1000, a), (2000, b)], 500) is None


def test_box_at_refuses_to_bridge_a_gap():
    a, b = Box(.1, .1, .1, .1), Box(.8, .1, .1, .1)
    # A gap longer than the association window: the identity was unobserved,
    # motion there belongs to nobody.
    assert _box_at([(0, a), (4000, b)], 2000) is None
    assert _box_at([], 2000) is None


# ---------------------------------------------------------------------------
# pick_talking_track: the evidence gate

def test_speaker_wins_over_still_listener():
    assert pick_talking_track([[0.4] * 10, [8.0] * 10]) == 1


def test_current_subject_stays_when_already_talking():
    assert pick_talking_track([[8.0] * 10, [0.4] * 10]) == 0


def test_silence_keeps_the_largest_face():
    assert pick_talking_track([[0.3] * 10, [0.9] * 10]) is None


def test_camera_pan_moving_both_faces_keeps_the_choice():
    assert pick_talking_track([[5.0] * 10, [4.0] * 10]) is None


def test_short_track_without_enough_samples_cannot_win():
    assert pick_talking_track([[0.2] * 10, [9.0] * 2]) is None


# ---------------------------------------------------------------------------
# pick_speaker_timeline: mid-shot turn-taking with hysteresis

def _windowed(track0_windows, track1_windows, frames_per_window=24):
    """Build per-frame mouth deltas from a per-window loud/quiet pattern."""
    loud, quiet = 8.0, 0.3
    def expand(flags):
        out = []
        for f in flags:
            out += [loud if f else quiet] * frames_per_window
        return out
    return [expand(track0_windows), expand(track1_windows)]


def test_timeline_holds_current_speaker_then_switches_after_confirmation():
    # Windows: man talks (0,1), woman talks (2,3,4). The switch commits only
    # once the woman wins two consecutive windows (LIP_SWITCH_CONFIRM).
    deltas = _windowed([1, 1, 0, 0, 0], [0, 0, 1, 1, 1])
    timeline = pick_speaker_timeline(deltas, 10000)
    assert timeline[0] == (0, 0)
    assert timeline[-1] == (6000, 1)  # confirmed at window 3 -> 6s
    assert any(i > 0 for _t, i in timeline)


def test_timeline_ignores_a_single_noisy_window():
    # The woman wins only one middle window: not enough to jerk the camera.
    deltas = _windowed([1, 1, 1, 1], [0, 0, 1, 0])
    timeline = pick_speaker_timeline(deltas, 8000)
    assert timeline == [(0, 0)]


def test_timeline_stays_when_no_one_clearly_talks():
    deltas = _windowed([0, 0, 0, 0], [0, 0, 0, 0])
    assert pick_speaker_timeline(deltas, 8000) == [(0, 0)]


# ---------------------------------------------------------------------------
# apply_speaker_timeline: the camera pans between split-screen speakers

def test_apply_speaker_timeline_follows_the_switching_speaker():
    left, right = Box(.14, .2, .14, .3), Box(.78, .2, .14, .3)
    observations = [FrameInfo(t, [left, right], None) for t in range(0, 8000, 250)]
    rivals = competing_faces(track_faces(observations), len(observations))
    shot = heuristic_layout(observations, 0, 8000, 1920, 1080)
    apply_speaker_timeline(shot, rivals, [(0, 0), (6000, 1)], 0, 8000, 1920, 1080)
    assert shot.focus_path[0][1] < .45   # started on the left-hand man
    assert shot.focus_path[-1][1] > .55  # ended on the right-hand woman


# ---------------------------------------------------------------------------
# _mouth_crop

def test_mouth_crop_is_fixed_size():
    gray = np.zeros((360, 640), np.uint8)
    crop = _mouth_crop(gray, Box(.3, .2, .2, .4), 640, 360)
    assert crop.shape == (32, 48)


def test_mouth_crop_rejects_a_face_too_small_to_read():
    gray = np.zeros((360, 640), np.uint8)
    assert _mouth_crop(gray, Box(.3, .2, .01, .02), 640, 360) is None


# ---------------------------------------------------------------------------
# apply_speaker_timeline: single switch retargets to the new face

def test_apply_speaker_timeline_moves_the_focus_path_to_the_new_face():
    listener, speaker = Box(.30, .18, .16, .34), Box(.46, .24, .13, .28)
    observations = [FrameInfo(t, [listener, speaker], None) for t in range(0, 8000, 250)]
    shot = heuristic_layout(observations, 0, 8000, 1920, 1080)
    assert shot.layout == LayoutType.TALKING_HEAD
    assert shot.people[0] == listener  # the larger face held the lock
    rivals = competing_faces(track_faces(observations), len(observations))
    apply_speaker_timeline(shot, rivals, [(0, 0), (4000, 1)], 0, 8000, 1920, 1080)
    assert shot.people[0].cx == pytest.approx(speaker.cx, abs=.05)
    assert shot.focus_path[-1][1] == pytest.approx(speaker.cx, abs=.05)


# ---------------------------------------------------------------------------
# analyze() integration: the decode is mocked, everything else is the real pipeline

HIST = np.ones((24, 16), np.float32)


def _ambiguous_frames():
    listener, speaker = Box(.30, .18, .16, .34), Box(.46, .24, .13, .28)
    return [FrameInfo(t, [listener, speaker], HIST) for t in range(0, 8000, 250)]


def _run_analyze(monkeypatch, deltas):
    analyzer = LayoutAnalyzer()

    def boom(*args, **kwargs):
        raise OSError("no scan in tests")

    analyzer._precise_frames = boom
    analyzer._decode_and_detect = lambda *a, **k: (_ambiguous_frames(), [])
    calls = []

    def fake_mouth(*args):
        calls.append(args)
        return deltas

    analyzer._mouth_activity = fake_mouth
    plan = asyncio.run(analyzer.analyze("video.mp4", 0, 8000, 1920, 1080, vision=True))
    return plan, calls


def test_analyze_switches_subject_to_the_talking_face(monkeypatch):
    # The right-hand speaker is loud for the whole shot: after two confirmed
    # windows the camera commits to her and stays.
    plan, calls = _run_analyze(monkeypatch, [[0.4] * 60, [8.0] * 60])
    assert len(calls) == 1  # one decode for the one ambiguous shot
    shot = next(s for s in plan.shots if s.layout == LayoutType.TALKING_HEAD)
    assert shot.focus_path[-1][1] > .44  # followed the right-hand speaker, not .38


def test_analyze_keeps_subject_when_mouths_are_still(monkeypatch):
    plan, calls = _run_analyze(monkeypatch, [[0.2] * 20, [0.5] * 20])
    assert len(calls) == 1
    shot = next(s for s in plan.shots if s.layout == LayoutType.TALKING_HEAD)
    assert shot.focus_path[-1][1] < .44  # stayed on the larger left face


def test_analyze_skips_tiebreak_when_subject_is_uncontested(monkeypatch):
    face = Box(.4, .2, .2, .44)
    analyzer = LayoutAnalyzer()

    def boom(*args, **kwargs):
        raise OSError("no scan in tests")

    analyzer._precise_frames = boom
    analyzer._decode_and_detect = lambda *a, **k: ([FrameInfo(t, [face], HIST)
                                                    for t in range(0, 8000, 250)], [])
    analyzer._mouth_activity = lambda *a: pytest.fail("should not decode")
    plan = asyncio.run(analyzer.analyze("video.mp4", 0, 8000, 1920, 1080, vision=True))
    assert plan.shots
