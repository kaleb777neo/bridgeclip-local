"""Speech Enhancement: the two sliders (noise reduction, voice enhancement).

Both are candidate fields baked at export. The filter chain rides on the
speech BEFORE loudness normalization (so the -14 LUFS target still holds),
never on the music bed, and 0/absent keeps today's graph byte-identical.
"""
import json

import pytest

from clip_engine.services.clip_editor import TimeMap
from clip_engine.services.layout_renderer import LayoutType, ClipLayoutPlan, ShotLayout, build_layout_graph, speech_enhancement_filter
from clip_engine.services.manual_editor import editor_bake_layers, validate_candidate


def candidate(**patch):
    base = {'id': 'candidate-1', 'title': 'Clip', 'ranges': [[0, 4000]],
            'scenes': [{'at_ms': 0, 'layout': 'fill', 'crops': [[.1, .1, .8, .8]]}],
            'captions': True, 'caption_preset': 'pop', 'video_speed': 1}
    base.update(patch)
    return base


def graph_with(with_audio=True, **kwargs):
    plan = ClipLayoutPlan(shots=[ShotLayout(0, 4000, LayoutType.SCREEN, source='fallback')],
                          source_width=1920, source_height=1080, face_samples=[])
    return build_layout_graph(plan, 1080, 1920, [(0, 4000)], with_audio, **kwargs)


def test_filter_chain_maps_the_two_sliders():
    assert speech_enhancement_filter(0, 0) == '' and speech_enhancement_filter(None, None) == ''
    denoise = speech_enhancement_filter(.5, 0)
    assert denoise.startswith('afftdn=nr=0.455:nf=-25') and 'acompressor' not in denoise
    voice = speech_enhancement_filter(0, 1)
    assert voice.startswith('highpass=f=85,') and 'afftdn' not in voice
    assert 'equalizer=f=320:t=q:w=1.2:g=-3.00' in voice, 'the mud cut deepens with the slider'
    assert 'equalizer=f=3150:t=q:w=2:g=5.00' in voice, 'presence lift tops out at full enhancement'
    assert 'acompressor=threshold=-20dB:ratio=3.20:attack=12:release=180:makeup=6.00' in voice
    both = speech_enhancement_filter(.25, .5)
    assert both.split(',')[0].startswith('afftdn=nr=0.233') and 'equalizer=f=3150' in both
    # Out-of-range values are treated as off rather than poisoning the graph.
    assert speech_enhancement_filter(2, -1) == ''


def test_graph_adds_the_chain_to_speech_only_before_loudnorm():
    off = graph_with(with_audio=True)
    assert 'afftdn' not in off and 'acompressor' not in off, 'absent sliders keep today\'s graph'
    enhanced = graph_with(with_audio=True, speech_denoise=.5, speech_enhance=.8)
    audio = enhanced.split(';')[-1]
    assert 'afftdn=nr=0.455:nf=-25' in audio and 'acompressor' in audio
    speech_at = audio.find('concat=n=1')
    enhancement_at = audio.find('afftdn')
    loudnorm_at = audio.find('loudnorm')
    assert speech_at < enhancement_at < loudnorm_at, 'enhancement sits on the speech, before loudness normalization'


def test_the_chain_never_touches_the_music_bed():
    enhanced = graph_with(with_audio=True, speech_denoise=.6, speech_enhance=.6, music_index=1, music_gain=.3)
    music_part = enhanced.split('music_bed]')[1].split(';')[0]
    assert 'afftdn' not in music_part and 'acompressor' not in music_part


def test_candidate_validation_and_bake_pass_through():
    assert validate_candidate(candidate(speech_denoise=.4, speech_enhance=.9), 4000, 4) is None
    assert validate_candidate(candidate(), 4000, 4) is None
    for patch in [{'speech_denoise': 1.5}, {'speech_enhance': -0.2}, {'speech_denoise': 'high'}]:
        with pytest.raises(ValueError):
            validate_candidate(candidate(**patch), 4000, 4)
    layers = editor_bake_layers(json.loads(json.dumps({})), candidate(speech_denoise=.4, speech_enhance=.9))
    assert layers['speech_denoise'] == .4 and layers['speech_enhance'] == .9
    assert 'speech_denoise' not in editor_bake_layers({}, candidate())
