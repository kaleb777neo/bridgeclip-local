"""B-roll layouts: Fill (default), Picture-in-Picture and Split (vertical only).

Fill keeps today's full-frame overlay. PiP puts the B-roll behind and shrinks
the speaker into a corner window; Split stacks speaker and B-roll top/bottom
with an optional swap, and falls back to Fill on landscape outputs.
"""
import pytest

from clip_engine.services.clip_editor import TimeMap
from clip_engine.services.manual_editor import editor_bake_layers, validate_candidate
from clip_engine.services.rendering_service import RenderRequest, RenderingService


def candidate(brolls):
    return {'id': 'candidate-1', 'title': 'Clip', 'ranges': [[0, 6000]],
            'scenes': [{'at_ms': 0, 'layout': 'fill', 'crops': [[.1, .1, .8, .8]]}],
            'captions': True, 'caption_preset': 'pop', 'video_speed': 1, 'brolls': brolls}


def bake(brolls, out_w=1080, out_h=1920):
    request = RenderRequest('src.mp4', 'clip.mp4', 0, 6000, out_w, out_h,
                            brolls=[{'path': 'b.png', **b} for b in brolls])
    graph, _ = RenderingService()._bake_stage(request, request.brolls, TimeMap(keeps=[(0, 6000)]), 0, out_w, out_h, '30', 2)
    return graph


def test_broll_layouts_validate_and_bake(tmp_path):
    (tmp_path / ('editor-asset-' + 'a' * 32 + '.mp4')).write_bytes(b'video')
    (tmp_path / ('editor-asset-' + 'b' * 32 + '.png')).write_bytes(b'img')
    assert validate_candidate(candidate([{'asset': 'a' * 32 + '.mp4', 'start_ms': 0, 'end_ms': 2000, 'layout': 'pip'}]), 6000, 4) is None
    assert validate_candidate(candidate([{'asset': 'a' * 32 + '.mp4', 'start_ms': 0, 'end_ms': 2000, 'layout': 'split', 'swap': True}]), 6000, 4) is None
    for brolls in [
        [{'asset': 'a' * 32 + '.mp4', 'start_ms': 0, 'end_ms': 2000, 'layout': 'window'}],
        [{'asset': 'a' * 32 + '.mp4', 'start_ms': 0, 'end_ms': 2000, 'layout': 'fill', 'swap': True}],
        [{'asset': 'a' * 32 + '.mp4', 'start_ms': 0, 'end_ms': 2000, 'swap': True}],
        [{'asset': 'a' * 32 + '.mp4', 'start_ms': 0, 'end_ms': 2000, 'layout': 'split', 'swap': 'yes'}],
    ]:
        with pytest.raises(ValueError):
            validate_candidate(candidate(brolls), 6000, 4)
    layers = editor_bake_layers(tmp_path, candidate([
        {'asset': 'a' * 32 + '.mp4', 'start_ms': 0, 'end_ms': 1000, 'layout': 'split', 'swap': True},
        {'asset': 'b' * 32 + '.png', 'start_ms': 1000, 'end_ms': 2000}]))
    assert layers['brolls'][0]['layout'] == 'split' and layers['brolls'][0]['swap'] is True
    assert 'layout' not in layers['brolls'][1]


def test_fill_stays_the_full_frame_overlay():
    graph = bake([{'start_ms': 500, 'end_ms': 2500}])
    assert 'overlay=0:0:enable=' in graph and 'split=2' not in graph


def test_pip_puts_the_broll_behind_and_the_speaker_in_a_window():
    graph = bake([{'start_ms': 500, 'end_ms': 2500, 'layout': 'pip'}])
    assert 'split=2[spkbase2][spksrc2]' in graph, 'the footage splits into base + speaker window source'
    music = [part for part in graph.split(';') if 'pipbg' in part or 'spkwin' in part]
    assert any(part.startswith('[spkbase2][broll2]overlay=0:0') for part in music), 'the B-roll fills the frame first'
    corner = next(part for part in music if 'spkwin' in part and 'overlay=' in part and 'spkbase' not in part)
    assert 'overlay=627:1275:enable=' in corner, 'the speaker window sits in the bottom-right corner'
    assert any('scale=410:576' in part for part in music), 'the speaker window is about 38% wide'


def test_split_stacks_halves_and_swap_flips_them():
    graph = bake([{'start_ms': 500, 'end_ms': 2500, 'layout': 'split'}])
    assert '[spkbase2][spkhalf2]overlay=0:0:enable=' in graph, 'the speaker fills the top half'
    assert 'overlay=0:960:enable=' in graph, 'the B-roll lands on the bottom half (960 of 1920)'
    swapped = bake([{'start_ms': 500, 'end_ms': 2500, 'layout': 'split', 'swap': True}])
    assert '[spkbase2][brollhalf2]overlay=0:0:enable=' in swapped
    assert '[splittop2][spkhalf2]overlay=0:960:enable=' in swapped


def test_split_falls_back_to_fill_on_landscape():
    graph = bake([{'start_ms': 500, 'end_ms': 2500, 'layout': 'split'}], out_w=1920, out_h=1080)
    assert 'split=2' not in graph and 'overlay=0:0:enable=' in graph
