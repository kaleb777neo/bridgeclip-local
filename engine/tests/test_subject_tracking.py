"""Manual subject tracking: a click hint steers classify_shot to the clicked subject."""
import sys

sys.path.insert(0, '.')
from clip_engine.services.layout_analyzer import Box, FaceTrack, classify_shot  # noqa: E402


def track(name, cx, cy, w=0.12, h=0.3, samples=40):
    t = FaceTrack()
    t.samples = [(i * 100, Box(cx, cy, w, h)) for i in range(samples)]
    return t


def test_subject_click_prefers_the_clicked_face_over_the_larger_one():
    big = track('big', 0.3, 0.5, w=0.3, h=0.6)
    small = track('small', 0.7, 0.5)
    shot, main = classify_shot([big, small], 40, 16, 9, subject={'x': 0.7, 'y': 0.5})
    assert shot.layout == 'talking_head'
    assert main is small, 'the clicked (smaller) face is followed, not the largest'
    assert shot.people == [small.median_box()]


def test_without_a_hint_the_largest_face_wins():
    big = track('big', 0.3, 0.5, w=0.3, h=0.6)
    small = track('small', 0.9, 0.1, w=0.08, h=0.12)  # corner overlay: never the default subject
    shot, main = classify_shot([big, small], 40, 16, 9)
    assert main is big


def test_a_click_far_from_every_face_falls_back_to_defaults():
    big = track('big', 0.3, 0.5, w=0.3, h=0.6)
    shot, main = classify_shot([big], 40, 16, 9, subject={'x': 0.95, 'y': 0.05})
    assert main is big, 'a click far from any face keeps the default subject'


def test_a_clicked_corner_cam_face_becomes_the_followed_subject():
    overlay = track('cam', 0.08, 0.1, w=0.14, h=0.25)
    wide = track('wide', 0.5, 0.6, w=0.4, h=0.5)
    shot, main = classify_shot([overlay, wide], 40, 16, 9, subject={'x': 0.08, 'y': 0.1})
    assert shot.layout == 'talking_head'
    assert main is overlay, 'a clicked overlay face is promoted to the followed subject'
