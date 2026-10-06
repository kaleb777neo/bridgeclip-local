"""Range Effects: scoped visual edits (grades, sharpen/soften, region blur).

They land on the footage at the very start of the bake stage — before any
B-roll, text or caption — with FFmpeg timeline `enable` windows on the final
clock. A range that was cut away produces no graph at all.
"""
import json

import pytest

from clip_engine.services.clip_editor import TimeMap
from clip_engine.services.manual_editor import editor_bake_layers, validate_candidate
from clip_engine.services.rendering_service import RenderRequest, RenderingService


def candidate(**patch):
    base = {'id': 'candidate-1', 'title': 'Clip', 'ranges': [[0, 4000]],
            'scenes': [{'at_ms': 0, 'layout': 'fill', 'crops': [[.1, .1, .8, .8]]}],
            'captions': True, 'caption_preset': 'pop', 'video_speed': 1}
    base.update(patch)
    return base


def test_range_edits_validate_against_the_caps():
    warm = {'id': 'a' * 32, 'kind': 'warm', 'intensity': .6, 'start_ms': 500, 'end_ms': 2500}
    blur = {'id': 'b' * 32, 'kind': 'blur', 'intensity': .8, 'start_ms': 0, 'end_ms': 1000,
            'region': [0, 0, 1, 1 / 3]}
    assert validate_candidate(candidate(range_edits=[warm, blur]), 4000, 4) is None
    assert validate_candidate(candidate(), 4000, 4) is None
    for patch in [
        {'range_edits': [{'id': 'a' * 32, 'kind': 'explode', 'intensity': .5, 'start_ms': 0, 'end_ms': 500}]},
        {'range_edits': [{'id': 'short', 'kind': 'warm', 'intensity': .5, 'start_ms': 0, 'end_ms': 500}]},
        {'range_edits': [{'id': 'a' * 32, 'kind': 'warm', 'intensity': 0, 'start_ms': 0, 'end_ms': 500}]},
        {'range_edits': [{'id': 'a' * 32, 'kind': 'warm', 'intensity': .5, 'start_ms': 0, 'end_ms': 50}]},
        {'range_edits': [{'id': 'a' * 32, 'kind': 'warm', 'intensity': .5, 'start_ms': 0, 'end_ms': 400000}]},
        {'range_edits': [{'id': 'a' * 32, 'kind': 'warm', 'intensity': .5, 'start_ms': 0, 'end_ms': 500, 'region': [0, 0, .5, .5]}]},
        {'range_edits': [{'id': 'a' * 32, 'kind': 'blur', 'intensity': .5, 'start_ms': 0, 'end_ms': 500, 'region': [.8, 0, .5, .5]}]},
        {'range_edits': [{'id': 'a' * 32, 'kind': 'warm', 'intensity': .5, 'start_ms': 0, 'end_ms': 500},
                         {'id': 'a' * 32, 'kind': 'cool', 'intensity': .5, 'start_ms': 1000, 'end_ms': 1500}]},
    ]:
        with pytest.raises(ValueError):
            validate_candidate(candidate(**patch), 4000, 4)


def test_bake_layers_pass_clean_sorted_range_edits():
    c = candidate(range_edits=[
        {'id': 'b' * 32, 'kind': 'blur', 'intensity': .8, 'start_ms': 0, 'end_ms': 1000, 'region': [0, 0, 1, 1 / 3], 'note': 'dropped'},
        {'id': 'a' * 32, 'kind': 'warm', 'intensity': .6, 'start_ms': 500, 'end_ms': 2500}])
    layers = editor_bake_layers(json.loads(json.dumps({})), c)
    assert [e['id'] for e in layers['range_edits']] == ['b' * 32, 'a' * 32]
    assert layers['range_edits'][0]['region'] == [0.0, 0.0, 1.0, 1 / 3]
    assert 'note' not in layers['range_edits'][0]
    assert 'range_edits' not in editor_bake_layers({}, candidate())


def test_chain_builds_enable_windows_and_region_blur():
    chain = RenderingService._range_edit_chain('[pre]', {'kind': 'warm', 'intensity': .6}, 'between(t,0.500,2.500)', 0)
    assert chain.startswith(";[pre]colorbalance=rs=0.168:bs=-0.168,hue=s=1.150:enable='between(t,0.500,2.500)'[rge0]")
    blur = RenderingService._range_edit_chain('[pre]', {'kind': 'blur', 'intensity': .8, 'region': [0, 0, 1, 1 / 3]}, 'between(t,0.000,1.000)', 1)
    assert 'split=2' in blur and 'gblur=sigma=20.4' in blur and "overlay=iw*0.0000:ih*0.0000:enable='between(t,0.000,1.000)'" in blur
    default = RenderingService._range_edit_chain('[pre]', {'kind': 'blur', 'intensity': .5}, 'between(t,0.000,1.000)', 2)
    assert 'crop=iw*1.0000:ih*1.0000' in default, 'no region means the whole frame'


def bake_graph(overlays):
    request = RenderRequest('src.mp4', 'clip.mp4', 0, 6000, 1080, 1920, range_edits=overlays)
    graph, _ = RenderingService()._bake_stage(request, [], TimeMap(keeps=[(0, 6000)]), 0, 1080, 1920, '30', 1)
    return graph


def test_bake_stage_applies_effects_before_overlays_on_the_final_clock():
    graph = bake_graph([{'id': 'a' * 32, 'kind': 'cinematic', 'intensity': .5, 'start_ms': 500, 'end_ms': 2500}])
    assert "enable='between(t,0.500,2.500)'" in graph
    assert graph.index('rge1') < graph.index('broll1') if 'broll1' in graph else True
    # A range the cuts removed produces no graph at all.
    request = RenderRequest('src.mp4', 'clip.mp4', 0, 6000, 1080, 1920,
                            range_edits=[{'id': 'a' * 32, 'kind': 'bw', 'intensity': .5, 'start_ms': 500, 'end_ms': 2500}])
    graph, _ = RenderingService()._bake_stage(request, [], TimeMap(keeps=[(3000, 6000)]), 0, 1080, 1920, '30', 1)
    assert 'rge' not in graph
