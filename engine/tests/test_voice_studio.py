"""Voiceover Studio: scratch Windows-SAPI previews of a script.

The script (with pronunciations applied) travels through a UTF-8 temp file so
nothing can inject into the PowerShell command; the synthesized wav lands as a
normal editor asset, and its duration is probed for the player.
"""
import json

import pytest

from clip_engine.services.manual_editor import EditorError, voice_preview, voice_sapi_rate, voice_voices


class FakeCompleted:
    def __init__(self, stdout=b'', returncode=0):
        self.stdout, self.returncode = stdout, returncode


def fake_powershell(monkeypatch, tmp_path, calls, wav_bytes=b'x' * 4000):
    from clip_engine.services import manual_editor as module
    monkeypatch.setattr(module, 'audio_duration', lambda path: 3.5)
    def run(command, timeout=None):
        calls.append(command)
        for token in command.split(';'):
            token = token.strip()
            if token.startswith('$s.SetOutputToWaveFile'):
                out = token.split("'", 2)[1]
                (tmp_path / out.rsplit('\\', 1)[-1].rsplit('/', 1)[-1]).write_bytes(wav_bytes)
            if token.startswith('$s.Speak'):
                src = token.split("'", 2)[1]
                for path in tmp_path.glob('.editor-voice-*.txt'):
                    if path.as_posix() in src.replace('/', '\\') or str(path) in src or src.endswith(path.name):
                        calls.append(('SCRIPT', path.read_text(encoding='utf-8-sig')))
        return FakeCompleted()
    monkeypatch.setattr(module, '_run_powershell', run)


def test_rate_maps_onto_the_sapi_scale():
    assert [voice_sapi_rate(0.5), voice_sapi_rate(1), voice_sapi_rate(1.5), voice_sapi_rate(2)] == [-5, 0, 5, 10]
    assert voice_sapi_rate(9) == 10 and voice_sapi_rate(0) == -5


def test_preview_synthesizes_with_voice_rate_and_pronunciations(monkeypatch, tmp_path):
    calls = []
    fake_powershell(monkeypatch, tmp_path, calls)
    events = []
    result = __import__('asyncio').run(voice_preview(tmp_path, {
        'script': 'BridgeClip  launches today. Messi  scores.',
        'voice': 'Microsoft Zira Desktop', 'rate': 1.5,
        'pronunciations': [{'word': 'BridgeClip', 'say': 'Bridge Clip'}, {'word': 'Messi', 'say': 'MEH-see'}]
    }, progress=events.append))
    assert result['asset'].endswith('.wav') and len(result['asset']) == 36
    assert result['duration_ms'] >= 100
    script = next(c[1] for c in calls if c[0] == 'SCRIPT')
    assert 'Bridge Clip launches today. MEH-see scores.' == ' '.join(script.split())
    command = calls[0]
    assert "SelectVoice('Microsoft Zira Desktop')" in command and '$s.Rate = 5' in command
    assert [e['phase'] for e in events] == ['motion'] * len(events)
    assert not list(tmp_path.glob('.editor-voice-*.txt')), 'the script temp file is cleaned up'


def test_pronunciations_are_case_insensitive_and_script_bounds_hold(monkeypatch, tmp_path):
    calls = []
    fake_powershell(monkeypatch, tmp_path, calls)
    __import__('asyncio').run(voice_preview(tmp_path, {
        'script': 'BRIDGECLIP rocks', 'voice': '', 'rate': 1,
        'pronunciations': [{'word': 'bridgeclip', 'say': 'Bridge Clip'}]}))
    script = next(c[1] for c in calls if c[0] == 'SCRIPT')
    assert 'Bridge Clip rocks' == ' '.join(script.split())
    assert "$s.SelectVoice" not in calls[0][-1], 'an empty voice keeps the system default'
    for bad in [{'script': 'short'}, {'script': 'x' * 5001}, {'script': 'valid script here',
                'pronunciations': [{'word': 'a', 'say': ''}]}]:
        with pytest.raises(EditorError):
            __import__('asyncio').run(voice_preview(tmp_path, bad))


def test_installed_voices_parse_from_json_or_single_string(monkeypatch):  # noqa: no audio involved
    from clip_engine.services import manual_editor as module
    monkeypatch.setattr(module, '_run_powershell',
                        lambda command, timeout: FakeCompleted(stdout=b'["Microsoft Zira Desktop", "Microsoft David Desktop"]'))
    voices = __import__('asyncio').run(voice_voices())
    assert voices == {'voices': ['Microsoft Zira Desktop', 'Microsoft David Desktop']}
    monkeypatch.setattr(module, '_run_powershell', lambda command, timeout: FakeCompleted(stdout=b'"Only One"'))
    assert __import__('asyncio').run(voice_voices()) == {'voices': ['Only One']}
    monkeypatch.setattr(module, '_run_powershell', lambda command, timeout: FakeCompleted(stdout=b''))
    assert __import__('asyncio').run(voice_voices()) == {'voices': []}


# --- Bake path: the narration leaves the scratch zone and reaches the export ---

def vo_candidate(**voiceover):
    from tests.test_music_fades import candidate as music_candidate
    base = music_candidate({'asset': 'a' * 32 + '.mp3', 'gain': .3})
    base['voiceover'] = {
        'script': 'Hello from the baked narration.', 'voice': 'Microsoft Zira Desktop', 'rate': 1,
        'pronunciations': [], 'audio_asset': 'b' * 32 + '.wav', **voiceover}
    return base


def test_voiceover_validates_and_bakes_into_the_render_request(tmp_path):
    from clip_engine.services.manual_editor import editor_bake_layers, validate_candidate
    from tests.test_music_fades import candidate as music_candidate
    vo = {'start_ms': 1500, 'duration_ms': 3500, 'gain': .8}
    validate_candidate(vo_candidate(**vo), 12000)
    (tmp_path / ('editor-asset-' + 'a' * 32 + '.mp3')).write_bytes(b'm')
    (tmp_path / ('editor-asset-' + 'b' * 32 + '.wav')).write_bytes(b'x')
    layers = editor_bake_layers(tmp_path, vo_candidate(**vo))
    assert layers['voiceover'] == {'path': str(tmp_path / ('editor-asset-' + 'b' * 32 + '.wav')), 'gain': .8, 'start_ms': 1500}
    # Defaults: no start/gain fields still bake at 0 and full level.
    plain = editor_bake_layers(tmp_path, vo_candidate())
    assert plain['voiceover']['start_ms'] == 0 and plain['voiceover']['gain'] == 1
    # Absent or asset-less voiceovers bake nothing (scratch previews stay scratch).
    assert 'voiceover' not in editor_bake_layers(tmp_path, music_candidate({'asset': 'a' * 32 + '.mp3', 'gain': .3}))
    assert 'voiceover' not in editor_bake_layers(tmp_path, vo_candidate(audio_asset=None))


def test_voiceover_rejects_bad_assets_levels_and_timing():
    from clip_engine.services.manual_editor import validate_candidate
    for patch in (
        {'audio_asset': 'zz.wav'},
        {'audio_asset': None},
        {'gain': 2.5},
        {'gain': -.5},
        {'start_ms': -100},
        {'start_ms': 600001},
        {'duration_ms': 50},
        {'rate': 3},
        {'script': '   '},
    ):
        with pytest.raises(ValueError, match='[Ii]nvalid voiceover'):
            validate_candidate(vo_candidate(**patch), 12000)


def test_voiceover_bed_mixes_independently_of_music_and_audio_gain():
    from clip_engine.services.layout_renderer import ClipLayoutPlan, LayoutType, ShotLayout, build_layout_graph

    def plan():
        return ClipLayoutPlan(shots=[ShotLayout(0, 10000, LayoutType.SCREEN, source='fallback')],
                              source_width=1920, source_height=1080, face_samples=[])

    plain = build_layout_graph(plan(), 1080, 1920, [(0, 4000)], True)
    assert 'voiceover_bed' not in plain
    vo_only = build_layout_graph(plan(), 1080, 1920, [(0, 4000)], True, voiceover_index=1, voiceover_gain=.8, voiceover_start_ms=1500)
    assert '[1:a:0]' in vo_only and 'volume=0.8' in vo_only and 'adelay=1500:all=1' in vo_only
    assert '[speech_baked][voiceover_bed]amix=inputs=2' in vo_only
    both = build_layout_graph(plan(), 1080, 1920, [(0, 4000)], True, music_index=1, voiceover_index=2, voiceover_start_ms=500)
    assert '[speech_baked][voiceover_bed][music_bed]amix=inputs=3' in both
    # Zero start means no adelay at all.
    at_start = build_layout_graph(plan(), 1080, 1920, [(0, 4000)], True, voiceover_index=1)
    assert 'adelay' not in at_start and '[speech_baked][voiceover_bed]amix=inputs=2' in at_start
