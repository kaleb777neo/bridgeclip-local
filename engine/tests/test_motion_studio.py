"""Motion Studio's local generator: shot-plan validation and the ffmpeg render.

The plan mirrors src/shared parseMotionPlan's caps (≤ 8 shots, 0.5–8 s each,
≤ 20 s total). Stills get their Ken Burns move, videos are trimmed, titles
become centered ASS cards, and shots join through crossfades — all in one
bounded ffmpeg command that lands as `editor-asset-<id>.mp4` in the run.
"""
import json
from pathlib import Path

import pytest

from clip_engine.services.manual_editor import EditorError, _motion_branch, _motion_plan, _motion_title_ass, motion_render


def run_with_assets(tmp_path, aspect='9:16'):
    (tmp_path / 'editor-project.json').write_text(json.dumps(
        {'version': 1, 'aspect_ratio': aspect, 'duration_ms': 30000, 'width': 1920, 'height': 1080}))
    image = 'editor-asset-' + 'a' * 32 + '.png'
    video = 'editor-asset-' + 'b' * 32 + '.mp4'
    audio = 'editor-asset-' + 'c' * 32 + '.m4a'
    for name in (image, video, audio):
        (tmp_path / name).write_bytes(b'asset')
    return image, video, audio


def plan(shots=None, audio=False):
    return {'title': 'Brand intro', 'audio': audio, 'generator': 'ffmpeg-motion', 'shots': shots if shots is not None else [
        {'kind': 'title', 'text': 'Meet the product', 'duration_ms': 2000, 'motion': 'none'},
        {'kind': 'still', 'asset': 'a' * 32 + '.png', 'duration_ms': 3000, 'motion': 'zoom-in'}]}


def fake_render(monkeypatch, calls):
    from clip_engine.services import manual_editor as module
    def run(cmd, timeout=None, check=False):
        calls.append(cmd)
        Path(cmd[-1]).write_bytes(b'x' * 4000)
        return type('R', (), {'stdout': b''})()
    monkeypatch.setattr(module, 'run_media', run)


def test_plan_validation_mirrors_the_shared_caps(tmp_path):
    run_with_assets(tmp_path)
    cleaned, total, audio = _motion_plan(tmp_path, {'plan': plan()})
    assert total == 5000 and audio is None
    assert cleaned[0]['kind'] == 'title' and cleaned[1]['path'].endswith('.png')
    for bad in [
        plan(shots=[]),
        plan(shots=[{'kind': 'title', 'text': 'x', 'duration_ms': 400, 'motion': 'none'}]),
        plan(shots=[{'kind': 'title', 'text': 'x', 'duration_ms': 9000, 'motion': 'none'}]),
        plan(shots=[{'kind': 'still', 'asset': 'z' * 32 + '.png', 'duration_ms': 1000, 'motion': 'zoom-in'}]),
        plan(shots=[{'kind': 'still', 'asset': 'a' * 32 + '.png', 'duration_ms': 1000, 'motion': 'orbit'}]),
        plan(shots=[{'kind': 'still', 'asset': '../escape.png', 'duration_ms': 1000, 'motion': 'zoom-in'}]),
        plan(shots=[{'kind': 'still', 'asset': 'b' * 32 + '.mp4', 'duration_ms': 1000, 'motion': 'zoom-in'}]),
        plan(shots=[{'kind': 'title', 'text': '', 'duration_ms': 1000, 'motion': 'none'}]),
        plan(shots=[{'kind': 'title', 'text': 'filler', 'duration_ms': 8000, 'motion': 'none'},
                    {'kind': 'still', 'asset': 'a' * 32 + '.png', 'duration_ms': 8000, 'motion': 'zoom-in'},
                    {'kind': 'still', 'asset': 'a' * 32 + '.png', 'duration_ms': 8000, 'motion': 'zoom-in'}]),
    ]:
        with pytest.raises(EditorError):
            _motion_plan(tmp_path, {'plan': bad})
    with pytest.raises(EditorError):
        _motion_plan(tmp_path, {'plan': plan(audio=True)}), 'audio without an asset fails'
    cleaned, total, audio = _motion_plan(tmp_path, {'plan': plan(audio=True), 'audio_asset': 'c' * 32 + '.m4a'})
    assert audio.endswith('.m4a')


def test_branches_knob_the_right_motion_into_each_shot():
    zoom = _motion_branch({'kind': 'still', 'path': 'x.png', 'duration_ms': 4000, 'motion': 'zoom-in'}, 0, 1080, 1920, 30)
    assert 'zoompan=z=\'min(1+0.001500*on,1.18)\'' in zoom and 'trim=duration=4.000' in zoom
    pan = _motion_branch({'kind': 'still', 'path': 'x.png', 'duration_ms': 2000, 'motion': 'pan-left'}, 0, 1080, 1920, 30)
    assert "x='(iw-iw/zoom)*(1-on/60)'" in pan
    video = _motion_branch({'kind': 'video', 'path': 'x.mp4', 'duration_ms': 2500, 'motion': 'zoom-in'}, 0, 1080, 1920, 30)
    assert 'zoompan' not in video and 'scale=1080:1920' in video, 'video shots are trimmed, never Ken Burns-ed'
    title = _motion_branch({'kind': 'title', 'text': 'Hi', 'duration_ms': 2000, 'motion': 'none'}, 0, 1080, 1920, 30)
    assert title.startswith('[0:v]format=yuv420p')


def test_title_ass_centers_each_beat_with_fades():
    content = _motion_title_ass(plan()['shots'], 1080, 1920)
    assert 'Dialogue: 0,0:00:00.20,0:00:01.80,Default,,0,0,0,,{\\an5\\fad(200,200)}Meet the product' in content
    assert 'zoompan' not in content


def test_motion_render_writes_the_asset_and_reports_progress(monkeypatch, tmp_path):
    run_with_assets(tmp_path)
    calls = []
    fake_render(monkeypatch, calls)
    events = []
    result = __import__('asyncio').run(motion_render(
        tmp_path, {'plan': plan(audio=True), 'audio_asset': 'c' * 32 + '.m4a'}, progress=events.append))
    assert result['asset'] == calls[0][-1].rsplit('editor-asset-', 1)[1].replace('\\', '/').split('/')[-1]
    assert (tmp_path / f"editor-asset-{result['asset']}").exists(), 'the rendered clip stays for the renderer to attach'
    assert result['duration_ms'] == 5000
    assert [e['phase'] for e in events] == ['motion'] * len(events)
    assert events[0]['percent'] == 4 and events[-1]['percent'] == 100
    command = ' '.join(str(part) for part in calls[0])
    assert '-loop' in command and "color=c=0x14161C:s=1080x1920" in command
    assert 'xfade=transition=fade:duration=0.400:offset=1.600' in command
    assert 'atrim=duration=5.000' in command and 'afade=t=out:st=4.400:d=0.6' in command and '[aout]' in command
    # The title ASS temp file is cleaned up.
    assert not list(tmp_path.glob('.editor-motion-*.ass'))


def test_a_failed_render_leaves_no_partial_asset(monkeypatch, tmp_path):
    from clip_engine.services import manual_editor as module
    def run(cmd, timeout=None, check=False):
        Path(cmd[-1]).write_bytes(b'tiny')
        return type('R', (), {'stdout': b''})()
    monkeypatch.setattr(module, 'run_media', run)
    run_with_assets(tmp_path)
    with pytest.raises(EditorError) as error:
        __import__('asyncio').run(motion_render(tmp_path, {'plan': plan()}))
    assert error.value.editor_code == 'render_failed'
    leftovers = [p for p in tmp_path.glob('editor-asset-*.mp4') if p.name != 'editor-asset-' + 'b' * 32 + '.mp4']
    assert leftovers == [], 'the partial render is removed; only the reference asset stays'
