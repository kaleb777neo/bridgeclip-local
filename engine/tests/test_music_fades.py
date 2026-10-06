"""Music bed fades: Fade in / Fade out (≤ 5 s per side) on the looping music.

The fades ride on the music branch only, scaled to the pre-speed clock so a
"2s fade" on the output stays ~2s at any export speed. Absent fades keep
today's graph byte-identical.
"""
import pytest

from clip_engine.services.layout_renderer import LayoutType, ClipLayoutPlan, ShotLayout, build_layout_graph
from clip_engine.services.manual_editor import editor_bake_layers, validate_candidate


def candidate(music):
    return {'id': 'candidate-1', 'title': 'Clip', 'ranges': [[0, 4000]],
            'scenes': [{'at_ms': 0, 'layout': 'fill', 'crops': [[.1, .1, .8, .8]]}],
            'captions': True, 'caption_preset': 'pop', 'video_speed': 1, 'music': music}


def graph(**kwargs):
    plan = ClipLayoutPlan(shots=[ShotLayout(0, 10000, LayoutType.SCREEN, source='fallback')],
                          source_width=1920, source_height=1080, face_samples=[])
    return build_layout_graph(plan, 1080, 1920, [(0, 10000)], True, music_index=1, **kwargs)


def music_branch(graph):
    return next(part for part in graph.split(';') if 'music_bed' in part)


def test_music_fades_validate_and_bake(tmp_path):
    (tmp_path / ('editor-asset-' + 'a' * 32 + '.mp3')).write_bytes(b'audio')
    music = {'asset': 'a' * 32 + '.mp3', 'gain': .3, 'fade_in_ms': 2000, 'fade_out_ms': 4000}
    assert validate_candidate(candidate(music), 4000, 4) is None
    assert validate_candidate(candidate({'asset': 'a' * 32 + '.mp3', 'gain': .3}), 4000, 4) is None
    for patch in [{'fade_in_ms': 6000}, {'fade_out_ms': -100}, {'fade_in_ms': 'slow'}]:
        with pytest.raises(ValueError):
            validate_candidate(candidate({'asset': 'a' * 32 + '.mp3', 'gain': .3, **patch}), 4000, 4)
    layers = editor_bake_layers(tmp_path, candidate(music))
    assert layers['music']['fade_in_ms'] == 2000 and layers['music']['fade_out_ms'] == 4000
    assert 'fade_in_ms' not in editor_bake_layers(tmp_path, candidate({'asset': 'a' * 32 + '.mp3', 'gain': .3}))['music']


def test_fades_render_on_the_bed_scaled_by_speed():
    plain = music_branch(graph(music_gain=.3))
    assert 'afade' not in plain, 'absent fades keep the music chain unchanged'
    audio = music_branch(graph(music_gain=.3, music_fade_in_ms=2000, music_fade_out_ms=4000))
    assert 'afade=t=in:st=0:d=2.000' in audio
    assert 'afade=t=out:st=6.000:d=4.000' in audio, 'the fade-out ends exactly at the clip end'
    # The fades never touch the speech chain (its own micro edge fades aside).
    speech = graph(music_gain=.3, music_fade_in_ms=2000, music_fade_out_ms=4000).split('[speech_baked]')[0]
    assert 'd=2.000' not in speech and 'd=4.000' not in speech
    # At 2x export speed the pre-speed fades double, so the output fade keeps its length.
    fast = music_branch(graph(music_gain=.3, video_speed=2, music_fade_in_ms=2000, music_fade_out_ms=4000))
    assert 'afade=t=in:st=0:d=1.000' in fast
    assert 'afade=t=out:st=8.000:d=2.000' in fast


def test_a_fade_longer_than_the_clip_is_dropped_not_broken():
    audio = music_branch(graph(music_gain=.3, music_fade_in_ms=5000, music_fade_out_ms=5000))
    # 10 s clip: a 5 s fade per side is exactly half — allowed.
    assert 'afade=t=in:st=0:d=5.000' in audio and 'afade=t=out:st=5.000:d=5.000' in audio
    tiny = build_layout_graph(
        ClipLayoutPlan(shots=[ShotLayout(0, 3000, LayoutType.SCREEN, source='fallback')],
                       source_width=1920, source_height=1080, face_samples=[]),
        1080, 1920, [(0, 3000)], True, music_index=1, music_gain=.3, music_fade_out_ms=5000)
    assert 'afade=t=out' not in music_branch(tiny), 'a fade longer than the bed is skipped, never negative'
