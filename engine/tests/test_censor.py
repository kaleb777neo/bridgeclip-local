"""Auto Censor: masked captions, muted/bleeped speech, and the shared matcher."""
import pytest

from clip_engine.services.layout_renderer import (
    ClipLayoutPlan,
    LayoutType,
    ShotLayout,
    build_layout_graph,
    censor_hit,
    censor_intervals,
    censor_transcript,
    mask_word,
)
from clip_engine.services.manual_editor import editor_bake_layers, validate_candidate
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord


def candidate(**patch):
    base = {'id': 'candidate-1', 'title': 'Clip', 'ranges': [[0, 4000]],
            'scenes': [{'at_ms': 0, 'layout': 'fill', 'crops': [[.1, .1, .8, .8]]}],
            'captions': True, 'caption_preset': 'pop', 'video_speed': 1}
    base.update(patch)
    return base


def plan():
    return ClipLayoutPlan(shots=[ShotLayout(0, 10000, LayoutType.SCREEN, source='fallback')],
                          source_width=1920, source_height=1080, face_samples=[])


def seg(*words):
    built, t = [], 0
    for token in words:
        built.append(TranscriptWord(token, t, t + 200))
        t += 200
    return TranscriptSegment(text=' '.join(w.word for w in built), words=built, start_time_ms=0, end_time_ms=t)


# --- matching and masking -------------------------------------------------

def test_censor_matching_is_exact_stem_plus_inflections():
    stems = ['fuck', 'shit']
    assert censor_hit('fuck', stems) and censor_hit('Fuck!', stems) and censor_hit('FUCKED', stems)
    assert censor_hit('fucking', stems) and censor_hit('shitty', stems)
    # Inflection matching must not swallow longer words.
    assert not censor_hit('class', stems) and not censor_hit('assassin', stems)
    assert not censor_hit('shitake', stems) and not censor_hit('hello', stems)
    assert not censor_hit('***', stems)


def test_mask_word_keeps_punctuation_and_timing_shape():
    stems = ['fuck']
    assert mask_word('fuck', 'asterisk', stems) == '****'
    assert mask_word('Fuck!', 'asterisk', stems) == '****!'
    assert mask_word('fucking', 'first', stems) == 'f******'
    assert mask_word('"damn",', 'first', ['damn']) == '"d***",'
    # Non-matching tokens pass through untouched.
    assert mask_word('hello', 'asterisk', stems) == 'hello'
    assert mask_word('—', 'asterisk', stems) == '—'


def test_censor_transcript_masks_only_censored_words():
    transcript = [seg('what', 'the', 'fuck', 'is', 'this')]
    out = censor_transcript(transcript, {'words': ['fuck'], 'captions': 'asterisk', 'audio': 'mute'})
    assert [w.word for w in out[0].words] == ['what', 'the', '****', 'is', 'this']
    assert out[0].text == 'what the **** is this'
    # Timings never move: the bleep lands exactly under the mask.
    assert [(w.start_time_ms, w.end_time_ms) for w in out[0].words] == [(i * 200, (i + 1) * 200) for i in range(5)]
    first = censor_transcript(transcript, {'words': ['fuck'], 'captions': 'first', 'audio': 'bleep'})
    assert first[0].words[2].word == 'f***'
    # Off/absent config returns the transcript untouched.
    assert censor_transcript(transcript, {'words': ['fuck'], 'captions': 'off', 'audio': 'mute'}) == transcript
    assert censor_transcript(transcript, None) == transcript


def test_censor_intervals_are_output_time_sorted_and_merged():
    transcript = [seg('fuck', 'clean', 'fuck'),
                  TranscriptSegment(text='clean', words=[TranscriptWord('clean', 2000, 2600)], start_time_ms=2000, end_time_ms=2600)]
    spans = censor_intervals(transcript, ['fuck'])
    assert spans == [(0.0, 0.2), (0.4, 0.6)]
    # Adjacent censored words merge into one bleep.
    merged = censor_intervals([seg('fuck', 'shit')], ['fuck', 'shit'])
    assert merged == [(0.0, 0.4)]
    assert censor_intervals(transcript, ['zebra']) == []
    assert censor_intervals(transcript, []) == []


# --- the audio graph ------------------------------------------------------

def test_censor_mutes_and_bleeps_ride_the_speech_chain():
    graph = build_layout_graph(plan(), 1080, 1920, [(0, 4000)], True, censor_mutes=[(0.5, 0.9)], censor_bleep=False)
    assert "volume=0:enable='between(t,0.500,0.900)'" in graph
    assert 'aevalsrc' not in graph and 'censor_tone' not in graph
    # The mute sits on the concatenated speech, before loudnorm and any music mix.
    assert graph.index("volume=0:enable='between(t,0.500,0.900)'") < graph.index('loudnorm')

    bleep = build_layout_graph(plan(), 1080, 1920, [(0, 4000)], True,
                               censor_mutes=[(0.5, 0.9), (1.2, 1.4)], censor_bleep=True)
    assert 'between(t,0.500,0.900)+between(t,1.200,1.400)' in bleep
    assert 'aevalsrc=0.22*sin(2*PI*1000*t):s=48000:' in bleep
    assert '[censor_tone]amix=inputs=2:duration=first:dropout_transition=0:normalize=0' in bleep
    # The tone is gated to the same spans (audible only inside them).
    assert "volume=0:enable='not(" in bleep


def test_censor_absent_keeps_the_graph_byte_identical():
    plain = build_layout_graph(plan(), 1080, 1920, [(0, 4000)], True)
    default = build_layout_graph(plan(), 1080, 1920, [(0, 4000)], True, censor_mutes=None, censor_bleep=False)
    assert plain == default
    assert 'censor' not in plain and 'aevalsrc' not in plain


def test_music_start_offset_trims_the_looped_bed():
    plain = build_layout_graph(plan(), 1080, 1920, [(0, 4000)], True, music_index=1)
    assert 'atrim=start=12.500' not in plain
    offset = build_layout_graph(plan(), 1080, 1920, [(0, 4000)], True, music_index=1,
                                music_start_ms=12500, music_fade_in_ms=1500, music_fade_out_ms=1500)
    music_branch = next((part for part in offset.split(';') if 'music_bed' in part), '')
    assert '[1:a:0]atrim=start=12.500,asetpts=PTS-STARTPTS,' in music_branch
    # Fades stay anchored to the clip start, after the offset trim.
    assert music_branch.index('atrim=start=12.500') < music_branch.index('afade')


# --- candidate validation and bake layers ---------------------------------

def test_candidate_validates_and_bakes_the_censor_config(tmp_path):
    c = candidate(censor={'words': ['Fuck', 'HELL'], 'captions': 'asterisk', 'audio': 'bleep'})
    validate_candidate(c, 12000)
    assert editor_bake_layers(tmp_path, c)['censor'] == {'words': ['Fuck', 'HELL'], 'captions': 'asterisk', 'audio': 'bleep'}

    for patch in (
        {'words': [], 'captions': 'asterisk', 'audio': 'mute'},
        {'words': ['x' * 41], 'captions': 'asterisk', 'audio': 'mute'},
        {'words': ['ok'], 'captions': 'blanked', 'audio': 'mute'},
        {'words': ['ok'], 'captions': 'asterisk', 'audio': 'silence'},
        {'words': ['ok'], 'captions': 'off', 'audio': 'off'},
        {'words': 'fuck', 'captions': 'asterisk', 'audio': 'mute'},
        'fuck',
    ):
        bad = candidate(censor=patch)
        with pytest.raises(ValueError, match='[Ii]nvalid censor'):
            validate_candidate(bad, 12000)
    # Absent censor stays valid.
    validate_candidate(candidate(), 12000)


def test_music_start_validates_and_bakes(tmp_path):
    c = candidate(music={'asset': 'c' * 32 + '.m4a', 'gain': .5, 'start_ms': 45000})
    validate_candidate(c, 12000)
    (tmp_path / f"editor-asset-{c['music']['asset']}").write_bytes(b'x')
    assert editor_bake_layers(tmp_path, c)['music']['start_ms'] == 45000
    assert 'start_ms' not in editor_bake_layers(tmp_path, candidate(music={'asset': 'c' * 32 + '.m4a', 'gain': .5}))['music']
    for start in (600001, -1000, 'chorus'):
        bad = candidate(music={'asset': 'c' * 32 + '.m4a', 'gain': .5, 'start_ms': start})
        with pytest.raises(ValueError, match='Invalid music start'):
            validate_candidate(bad, 12000)
