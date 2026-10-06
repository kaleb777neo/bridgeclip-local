"""Speaker tracking in the editor: focus paths survive analysis, reach the
renderer, and reused job plans import without a second analysis pass."""
import asyncio
import json
from pathlib import Path

import pytest
from clip_engine.services.layout_analyzer import Box, ClipLayoutPlan, LayoutType, ShotLayout
from clip_engine.services.layout_renderer import shot_chain
from clip_engine.services.manual_editor import (
    manual_plan, read_tracking, run_editor, scenes_from_plan, shots_from_summary, write_tracking,
)
from clip_engine.services.rendering_service import RenderingService


def talking_shot(start=0, end=10000):
    return ShotLayout(start, end, LayoutType.TALKING_HEAD,
        focus_path=[(t, 0.3 + t / 100000, 0.5) for t in range(0, end - start, 250)])


# --- scenes_from_plan --------------------------------------------------------------------------

def test_fill_scenes_keep_the_analyzers_focus_path_in_absolute_time():
    scenes, tracking = scenes_from_plan([talking_shot()], 5000, 1920, 1080, 9 / 16)
    assert scenes[0]['layout'] == 'fill' and scenes[0]['at_ms'] == 0
    at_ms, crops, points = tracking[0]
    assert at_ms == 0 and crops == scenes[0]['crops']
    assert points[0][0] == 5000  # window start maps to absolute source time
    assert points[-1][0] <= 5000 + 10000
    assert points[0][1] < points[-1][1]  # the path actually moves


def test_second_scene_starts_at_its_shot_boundary():
    shots = [talking_shot(0, 6000), talking_shot(6000, 12000)]
    scenes, tracking = scenes_from_plan(shots, 1000, 1920, 1080, 9 / 16)
    assert [s['at_ms'] for s in scenes] == [0, 7000]
    assert {entry[0] for entry in tracking} == {0, 7000}


def test_paths_are_capped_for_json():
    shot = talking_shot(0, 60000)  # 240 samples at the analyzer's 4 fps
    _, tracking = scenes_from_plan([shot], 0, 1920, 1080, 9 / 16)
    assert len(tracking[0][2]) <= 41


def screen_cam_shot(start=0, end=10000):
    return ShotLayout(start, end, LayoutType.SCREEN_CAM, screen_box=Box(.5, .05, .45, .8),
        cam_box=Box(.05, .15, .4, .6), focus_path=[(t, .25 + t / 100000, .45) for t in range(0, end - start, 250)])


def test_fill_only_collapses_a_screen_cam_shot_onto_its_presenter():
    split_scenes, split_tracking = scenes_from_plan([screen_cam_shot()], 1000, 1920, 1080, 9 / 16)
    assert split_scenes[0]['layout'] == 'split' and len(split_scenes[0]['crops']) == 2
    assert split_tracking == []  # Split scenes stay static as before.
    scenes, tracking = scenes_from_plan([screen_cam_shot()], 1000, 1920, 1080, 9 / 16, fill_only=True)
    assert scenes[0]['layout'] == 'fill' and len(scenes[0]['crops']) == 1
    assert scenes[0]['crops'][0][0] < .5  # Centered on the camera panel, not the screen one.
    assert tracking[0][2][0][0] == 1000  # Non-talking-head shots carry their focus path too.


# --- shots_from_summary (persisted plan reuse) ---------------------------------------------------

def test_summary_round_trip_rebuilds_scenes_and_paths():
    summary = talking_shot().summary()
    rebuilt = shots_from_summary([summary, {'layout': 'nonsense'}, {'layout': LayoutType.TALKING_HEAD, 'start_ms': 0}])
    assert len(rebuilt) == 1 and rebuilt[0].focus_path
    scenes, tracking = scenes_from_plan(rebuilt, 12000, 1920, 1080, 9 / 16)
    assert scenes[0]['at_ms'] == 0 and scenes[0]['layout'] == 'fill'
    assert tracking[0][2][0][0] == 12000


def test_box_fields_reconstruct_and_garbage_is_dropped():
    rebuilt = shots_from_summary([{
        'start_ms': 0, 'end_ms': 5000, 'layout': LayoutType.TWO_SHOT, 'people': [[0.1, 0.2, 0.3, 0.4], 'x'],
        'screen_box': [2, 2], 'content_box': None, 'focus_path': [['a', 1, 1], [0, 0.5, 0.5], [5000, 0.6, 0.5]],
    }])
    assert len(rebuilt) == 1
    shot = rebuilt[0]
    assert len(shot.people) == 1 and shot.screen_box is None
    assert shot.focus_path == [(0, 0.5, 0.5), (5000, 0.6, 0.5)]


# --- manual_plan ---------------------------------------------------------------------------------

def test_manual_plan_attaches_paths_in_shot_relative_time():
    project = {'width': 1920, 'height': 1080}
    c = {'ranges': [[1000, 11000]], 'scenes': [
        {'at_ms': 0, 'layout': 'fill', 'crops': [[0.2, 0.1, 0.3, 0.53]]},
        {'at_ms': 6000, 'layout': 'fill', 'crops': [[0.4, 0.1, 0.3, 0.53]]}]}
    tracking = [[0, [[0.2, 0.1, 0.3, 0.53]], [[1000, 0.3, 0.5], [6000, 0.35, 0.5], [11000, 0.4, 0.5]]],
                [6000, [[0.4, 0.1, 0.3, 0.53]], [[6000, 0.5, 0.5], [11000, 0.6, 0.5]]]]
    plan = manual_plan(project, c, tracking)
    assert len(plan.shots) == 2
    assert plan.shots[0].manual_focus_path == [(0, 0.3, 0.5), (5000, 0.35, 0.5)]  # clamped, deduped
    assert plan.shots[1].manual_focus_path == [(0, 0.5, 0.5), (5000, 0.6, 0.5)]


def test_a_repositioned_crop_overrides_the_stored_path():
    project = {'width': 1920, 'height': 1080}
    c = {'ranges': [[1000, 11000]], 'scenes': [{'at_ms': 0, 'layout': 'fill', 'crops': [[0.25, 0.1, 0.3, 0.53]]}]}
    tracking = [[0, [[0.2, 0.1, 0.3, 0.53]], [[1000, 0.3, 0.5], [11000, 0.4, 0.5]]]]
    plan = manual_plan(project, c, tracking)
    assert plan.shots[0].manual_focus_path == []


def test_user_motion_transitions_render_static_eases_instead_of_tracking():
    project = {'width': 1920, 'height': 1080}
    c = {'ranges': [[0, 12000]], 'scenes': [
        {'at_ms': 0, 'layout': 'fill', 'crops': [[0.2, 0.1, 0.3, 0.53]]},
        {'at_ms': 6000, 'layout': 'fill', 'crops': [[0.4, 0.1, 0.3, 0.53]], 'transition_ms': 800}]}
    tracking = [[6000, [[0.4, 0.1, 0.3, 0.53]], [[6000, 0.5, 0.5], [12000, 0.6, 0.5]]]]
    plan = manual_plan(project, c, tracking)
    assert [bool(s.manual_focus_path) for s in plan.shots] == [False, False, True]


# --- shot_chain ----------------------------------------------------------------------------------

def test_tracked_manual_fill_emits_a_time_varying_crop():
    shot = ShotLayout(0, 5000, LayoutType.TALKING_HEAD, source='manual', manual_crops=[(0.2, 0.1, 0.3, 0.53)],
        manual_focus_path=[(0, 0.3, 0.5), (2500, 0.35, 0.5), (5000, 0.4, 0.5)])
    chain = shot_chain(0, shot, 1920, 1080, 1080, 1920)
    assert 'crop=w=' in chain and 'if(lt(t,' in chain


def test_untracked_manual_fill_stays_a_static_crop():
    shot = ShotLayout(0, 5000, LayoutType.TALKING_HEAD, source='manual', manual_crops=[(0.2, 0.1, 0.3, 0.53)])
    chain = shot_chain(0, shot, 1920, 1080, 1080, 1920)
    assert chain.count('crop=') == 1 and 'if(lt(t,' not in chain


# --- tracking file -------------------------------------------------------------------------------

def test_tracking_round_trips_and_survives_a_missing_file(tmp_path):
    assert read_tracking(tmp_path, 'candidate-1') == []
    write_tracking(tmp_path, {'candidate-1': [[0, [[0.2, 0.1, 0.3, 0.53]], [[100, 0.3, 0.5]]]]})
    assert read_tracking(tmp_path, 'candidate-1')[0][2] == [[100, 0.3, 0.5]]
    assert read_tracking(tmp_path, 'candidate-9') == []
    (tmp_path / 'editor-tracking.json').write_text('{broken')
    assert read_tracking(tmp_path, 'candidate-1') == []


# --- create-project reuse ------------------------------------------------------------------------

def automatic_run(tmp_path, layouts=None):
    metrics = {'requested_settings': {'aspect_ratio': '9:16', 'video_speed': 1}, 'captions_status': 'enabled'}
    if layouts:
        metrics['clip_layouts'] = layouts
    (tmp_path / 'job_output.json').write_text(json.dumps({
        'source_video_title': 'My video', 'editor_project': False, 'total_clips': 2, 'clips': [
            {'clip_index': 0, 's3_url': str(tmp_path / 'clip_00.mp4'), 'duration_ms': 5000, 'start_time_ms': 1000,
             'end_time_ms': 6000, 'virality_score': 0.9, 'layout_type': 'talking_head', 'summary': 'First'},
            {'clip_index': 1, 's3_url': str(tmp_path / 'clip_01.mp4'), 'duration_ms': 4000, 'start_time_ms': 20000,
             'end_time_ms': 24000, 'virality_score': 0.5, 'layout_type': 'screen', 'summary': 'Second'}],
        'metrics': metrics}))
    (tmp_path / 'transcript.json').write_text(json.dumps({'segments': []}))
    (tmp_path / 'editor-source.mp4').write_bytes(b'streamed by main')


def patch_import(monkeypatch):
    from clip_engine.services import manual_editor as module
    monkeypatch.setattr(module, 'source_info', lambda path: {'width': 1920, 'height': 1080, 'duration': 30000,
        'rotation': 0, 'sar': '1:1', 'audio': True})

    async def preview(self, src, dest, **kwargs):
        Path(dest).write_bytes(b'fresh preview')

    monkeypatch.setattr(module, 'preview_duration_ok', lambda *args, **kwargs: True)
    monkeypatch.setattr(RenderingService, 'capture_framing_source', preview)


def test_create_project_reuses_the_jobs_persisted_framing_without_reanalyzing(monkeypatch, tmp_path):
    entry = {'clip_index': 0, 'layout_type': 'talking_head', 'framing_status': 'smart',
        'shots': [talking_shot(0, 5000).summary()], 'pacing_removed_ms': 0, 'render_fallback': None,
        'window_start_ms': 1000, 'source_width': 1920, 'source_height': 1080}
    automatic_run(tmp_path, [entry])
    patch_import(monkeypatch)
    asyncio.run(run_editor(
        {'action': 'create-project', 'run': str(tmp_path), 'source': {'kind': 'file'}}))
    project = json.loads((tmp_path / 'editor-project.json').read_text())
    first, second = project['candidates']
    assert first['framing'] == 'tracked' and first['scenes'][0]['layout'] == 'fill'
    assert second['framing'] == 'centered'  # no persisted plan for this clip
    tracking = json.loads((tmp_path / 'editor-tracking.json').read_text())
    points = tracking['candidate-1'][0][2]
    assert points[0][0] >= 1000 and points[-1][0] <= 6000
    assert 'candidate-2' not in tracking


def test_create_project_skips_a_plan_from_different_source_geometry(monkeypatch, tmp_path):
    entry = {'clip_index': 0, 'shots': [talking_shot(0, 5000).summary()], 'window_start_ms': 1000,
        'source_width': 3840, 'source_height': 2160}
    automatic_run(tmp_path, [entry])
    patch_import(monkeypatch)
    from clip_engine.services.manual_editor import run_editor
    asyncio.run(run_editor({'action': 'create-project', 'run': str(tmp_path), 'source': {'kind': 'file'}}))
    project = json.loads((tmp_path / 'editor-project.json').read_text())
    assert project['candidates'][0]['framing'] == 'centered'
    assert not (tmp_path / 'editor-tracking.json').exists() or json.loads((tmp_path / 'editor-tracking.json').read_text()) == {}


# --- auto-frame action -----------------------------------------------------------------------------

def stored_project(tmp_path, **candidate_extra):
    candidate = {'id': 'candidate-1', 'title': 'First', 'ranges': [[1000, 11000]],
        'scenes': [{'at_ms': 0, 'layout': 'fill', 'crops': [[0.342, 0, 0.316, 1]]}], 'score': 80,
        'captions': True, 'video_speed': 1, 'exports': [], 'review': None, 'status': 'baked',
        'caption_edits': [{'segment': 0, 'text': 'kept edit'}], 'baked_hash': 'old'}
    candidate.update(candidate_extra)
    (tmp_path / 'editor-project.json').write_text(json.dumps({
        'version': 1, 'revision': 1, 'title': 'My video', 'width': 1920, 'height': 1080,
        'duration_ms': 30000, 'aspect_ratio': '9:16', 'candidates': [candidate], 'transcript': [{}, {}]}))
    (tmp_path / 'editor-source.mp4').write_bytes(b'streamed by main')


def patch_analyzer(monkeypatch, plan=None, asked=None):
    monkeypatch.setattr('clip_engine.services.layout_analyzer.LayoutAnalyzer.available', property(lambda self: True))

    async def analyze(self, video_path, start_ms, duration_ms, src_w, src_h, style='auto', vision=True,
                      capture=False, progress=None, precise=None, subject=None):
        if asked is not None:
            asked.update({'video_path': video_path, 'start_ms': start_ms, 'duration_ms': duration_ms,
                          **({'subject': subject} if subject is not None else {})})
        if progress:
            progress('Sampling faces', 10)
        return plan if plan is not None else ClipLayoutPlan(
            shots=[talking_shot(0, duration_ms)], source_width=src_w, source_height=src_h)

    monkeypatch.setattr('clip_engine.services.layout_analyzer.LayoutAnalyzer.analyze', analyze)


def auto_frame(**config):
    return asyncio.run(run_editor({'action': 'auto-frame', 'revision': 1, 'candidate_id': 'candidate-1', **config},
        progress=lambda value: None))


def test_auto_frame_rewrites_scenes_and_keeps_the_rest_of_the_edit(monkeypatch, tmp_path):
    stored_project(tmp_path)
    write_tracking(tmp_path, {'candidate-2': [[0, [[0.1, 0, 0.5, 0.5]], [[1000, 0.3, 0.5]]]],
        'candidate-1': [[0, [[0.342, 0, 0.316, 1]], [[1000, 0.5, 0.5]]]]})
    asked = {}
    patch_analyzer(monkeypatch, asked=asked)
    auto_frame(run=str(tmp_path))
    assert Path(asked['video_path']).name == 'editor-source.mp4' and asked['start_ms'] == 1000 and asked['duration_ms'] == 10000
    saved = json.loads((tmp_path / 'editor-project.json').read_text())
    c = saved['candidates'][0]
    assert c['ranges'] == [[1000, 11000]] and c['caption_edits'] == [{'segment': 0, 'text': 'kept edit'}]
    assert c['framing'] == 'tracked' and c['scenes'][0]['layout'] == 'fill'
    assert c['status'] == 'ready' and 'baked_hash' not in c  # The old bake used the old layouts.
    assert saved['revision'] == 2
    tracking = json.loads((tmp_path / 'editor-tracking.json').read_text())
    assert tracking['candidate-1'][0][0] == 0 and tracking['candidate-1'][0][2][0][0] == 1000
    assert 'candidate-2' in tracking  # Other candidates' paths survive the merge.


def test_auto_frame_falls_back_to_centered_when_nothing_is_framed(monkeypatch, tmp_path):
    stored_project(tmp_path)
    write_tracking(tmp_path, {'candidate-1': [[0, [[0.342, 0, 0.316, 1]], [[1000, 0.5, 0.5]]]]})
    patch_analyzer(monkeypatch, plan=ClipLayoutPlan(shots=[], source_width=1920, source_height=1080))
    from clip_engine.services.manual_editor import default_crop
    auto_frame(run=str(tmp_path))
    c = json.loads((tmp_path / 'editor-project.json').read_text())['candidates'][0]
    assert c['framing'] == 'centered'
    assert c['scenes'] == [{'at_ms': 0, 'layout': 'fill', 'crops': [default_crop(1920, 1080, 9 / 16)]}]
    assert json.loads((tmp_path / 'editor-tracking.json').read_text()) == {}


def test_auto_frame_never_leaves_the_clip_in_a_static_split(monkeypatch, tmp_path):
    stored_project(tmp_path)
    patch_analyzer(monkeypatch, plan=ClipLayoutPlan(shots=[screen_cam_shot()], source_width=1920, source_height=1080))
    auto_frame(run=str(tmp_path))
    c = json.loads((tmp_path / 'editor-project.json').read_text())['candidates'][0]
    assert c['scenes'][0]['layout'] == 'fill' and len(c['scenes'][0]['crops']) == 1
    assert json.loads((tmp_path / 'editor-tracking.json').read_text())['candidate-1'][0][2][0][0] == 1000


def test_auto_frame_needs_the_face_tracker(monkeypatch, tmp_path):
    stored_project(tmp_path)
    monkeypatch.setattr('clip_engine.services.layout_analyzer.LayoutAnalyzer.available', property(lambda self: False))
    with pytest.raises(ValueError) as raised:
        auto_frame(run=str(tmp_path))
    assert raised.value.editor_code == 'engine_unavailable'


def test_auto_frame_only_applies_to_vertical_projects(monkeypatch, tmp_path):
    stored_project(tmp_path)
    project = json.loads((tmp_path / 'editor-project.json').read_text())
    project['aspect_ratio'] = '16:9'
    (tmp_path / 'editor-project.json').write_text(json.dumps(project))
    patch_analyzer(monkeypatch)
    with pytest.raises(ValueError) as raised:
        auto_frame(run=str(tmp_path))
    assert raised.value.editor_code == 'invalid'
