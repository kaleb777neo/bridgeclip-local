"""The per-reel "Edit this" import: preview only the focused reel's window.

A fast import keys the preview to the focused candidate's time window (its
ranges padded by SEGMENT_PREVIEW_PAD_MS) and records that window in the project
as preview_start_ms/preview_end_ms. "build-preview" and a camera scan later
replace the segment preview with a full-source one and drop the offsets.
"""
import asyncio
import json
import shutil
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from clip_engine.services.manual_editor import run_editor
from clip_engine.services.rendering_service import RenderingService


def automatic_run(tmp_path):
    """A finished automatic run: two clips, no editor project, source streamed in by main."""
    (tmp_path / 'job_output.json').write_text(json.dumps({
        'source_video_title': 'My video', 'editor_project': False, 'total_clips': 2, 'clips': [
            {'clip_index': 0, 's3_url': str(tmp_path / 'clip_00.mp4'), 'duration_ms': 5000, 'start_time_ms': 1000,
             'end_time_ms': 6000, 'virality_score': 0.9, 'layout_type': 'talking_head', 'summary': 'First'},
            {'clip_index': 1, 's3_url': str(tmp_path / 'clip_01.mp4'), 'duration_ms': 4000, 'start_time_ms': 20000,
             'end_time_ms': 24000, 'virality_score': 0.5, 'layout_type': 'screen', 'summary': 'Second'}],
        'metrics': {'requested_settings': {'aspect_ratio': '9:16', 'video_speed': 1}, 'captions_status': 'enabled'}}))
    (tmp_path / 'transcript.json').write_text(json.dumps({'segments': [
        {'start_time_ms': 0, 'end_time_ms': 4000, 'text': 'First line', 'speaker_label': 'S1',
         'words': [{'word': 'First', 'start_time_ms': 0, 'end_time_ms': 2000},
                   {'word': 'line', 'start_time_ms': 2100, 'end_time_ms': 3900},
                   {'word': 'reversed', 'start_time_ms': 5000, 'end_time_ms': 4000},
                   {'word': 'nonsense', 'start_time_ms': 'x', 'end_time_ms': 3000}]},
        {'start_time_ms': 5000, 'end_time_ms': 9000, 'text': 'Second line'}]}))
    (tmp_path / 'editor-source.mp4').write_bytes(b'streamed by main')


def patch_import(monkeypatch, captures=None):
    from clip_engine.services import manual_editor as module
    monkeypatch.setattr(module, 'source_info', lambda path: {'width': 1920, 'height': 1080, 'duration': 30000,
        'rotation': 0, 'sar': '1:1', 'audio': True})

    async def preview(self, src, dest, **kwargs):
        if captures is not None:
            captures.append(dict(kwargs))
        if kwargs.get('progress'):
            kwargs['progress'](100)
        Path(dest).write_bytes(b'preview')

    monkeypatch.setattr(RenderingService, 'capture_framing_source', preview)


def test_fast_import_previews_only_the_focused_reels_window(monkeypatch, tmp_path):
    automatic_run(tmp_path)
    captures = []
    patch_import(monkeypatch, captures)
    asyncio.run(run_editor({'action': 'create-project', 'run': str(tmp_path), 'source': {'kind': 'file'}, 'focus_clip': 1}))
    # The window is the focused candidate's range (20 s – 24 s) padded by 10 s per side.
    assert captures[0]['start_ms'] == 10000 and captures[0]['end_ms'] == 30000
    project = json.loads((tmp_path / 'editor-project.json').read_text())
    assert project['preview_start_ms'] == 10000 and project['preview_end_ms'] == 30000
    assert 'frame_preview' not in project  # No full-source preview exists yet.
    assert json.loads((tmp_path / 'job_output.json').read_text())['editor_project'] is True


def test_a_window_covering_the_source_falls_back_to_a_full_preview(monkeypatch, tmp_path):
    automatic_run(tmp_path)
    captures = []
    patch_import(monkeypatch, captures)
    output = json.loads((tmp_path / 'job_output.json').read_text())
    output['clips'][1] = {**output['clips'][1], 'start_time_ms': 500, 'end_time_ms': 29500}
    (tmp_path / 'job_output.json').write_text(json.dumps(output))
    asyncio.run(run_editor({'action': 'create-project', 'run': str(tmp_path), 'source': {'kind': 'file'}, 'focus_clip': 1}))
    project = json.loads((tmp_path / 'editor-project.json').read_text())
    assert 'start_ms' not in captures[0] and captures[0]['duration_ms'] == 30000
    assert project['frame_preview'] is True and 'preview_start_ms' not in project


def test_import_without_a_known_focus_clip_prepares_the_whole_source(monkeypatch, tmp_path):
    automatic_run(tmp_path)
    captures = []
    patch_import(monkeypatch, captures)
    # No focus at all, and a focus that matches no clip: both keep today's full preview.
    asyncio.run(run_editor({'action': 'create-project', 'run': str(tmp_path), 'source': {'kind': 'file'}}))
    assert 'start_ms' not in captures[0] and captures[0]['duration_ms'] == 30000
    (tmp_path / 'editor-project.json').unlink()
    output = json.loads((tmp_path / 'job_output.json').read_text())
    output['editor_project'] = False
    (tmp_path / 'job_output.json').write_text(json.dumps(output))
    asyncio.run(run_editor({'action': 'create-project', 'run': str(tmp_path), 'source': {'kind': 'file'}, 'focus_clip': 5}))
    assert 'start_ms' not in captures[1]
    assert json.loads((tmp_path / 'editor-project.json').read_text())['frame_preview'] is True


def test_build_preview_upgrades_a_partial_preview_to_the_full_source(monkeypatch, tmp_path):
    automatic_run(tmp_path)
    captures = []
    patch_import(monkeypatch, captures)
    phases = []
    asyncio.run(run_editor({'action': 'create-project', 'run': str(tmp_path), 'source': {'kind': 'file'}, 'focus_clip': 1},
        progress=lambda value: phases.append(value['phase'])))
    preview_id = 'c' * 32
    asyncio.run(run_editor({'action': 'build-preview', 'run': str(tmp_path), 'revision': 0, 'preview_id': preview_id},
        progress=lambda value: phases.append(value['phase'])))
    project = json.loads((tmp_path / 'editor-project.json').read_text())
    assert project['revision'] == 1 and project['frame_preview'] is True and project['preview_id'] == preview_id
    assert 'preview_start_ms' not in project and 'preview_end_ms' not in project
    assert (tmp_path / f'editor-preview-{preview_id}.mp4').read_bytes() == b'preview'
    assert (tmp_path / 'editor-preview.mp4').exists()  # Main's sweep removes the stale segment.
    assert 'start_ms' not in captures[-1] and captures[-1]['duration_ms'] == 30000
    assert phases.count('preview') == 2
    # A stale revision is refused: the editor must reload before upgrading.
    with pytest.raises(ValueError) as error:
        asyncio.run(run_editor({'action': 'build-preview', 'run': str(tmp_path), 'revision': 0, 'preview_id': 'd' * 32}))
    assert error.value.editor_code == 'project_changed'


def test_camera_scan_replaces_a_partial_preview_with_a_full_one(monkeypatch, tmp_path):
    automatic_run(tmp_path)
    captures = []
    patch_import(monkeypatch, captures)
    monkeypatch.setattr('clip_engine.services.camera_scan.scan_camera_changes',
        lambda source, a, b, cb: {'frames': [20000.0, 20033.0], 'markers': []})
    asyncio.run(run_editor({'action': 'create-project', 'run': str(tmp_path), 'source': {'kind': 'file'}, 'focus_clip': 1}))
    preview_id = 'b' * 32
    asyncio.run(run_editor({'action': 'scan-cameras', 'run': str(tmp_path), 'revision': 0,
        'candidate_id': 'candidate-2', 'preview_id': preview_id}))
    project = json.loads((tmp_path / 'editor-project.json').read_text())
    assert project['frame_preview'] is True and project['preview_id'] == preview_id
    assert 'preview_start_ms' not in project and 'preview_end_ms' not in project
    assert project['candidates'][1]['camera_scan']['frames'] == [20000.0, 20033.0]
    assert 'start_ms' not in captures[-1] and captures[-1]['duration_ms'] == 30000


def test_fast_import_reports_download_bytes_total_and_speed(monkeypatch, tmp_path):
    automatic_run(tmp_path)
    patch_import(monkeypatch)
    events = []

    class FakeDownloader:
        def __init__(self):
            self.progress_callback = None

        async def download_video(self, url, output_dir, output_filename):
            Path(output_dir, output_filename).write_bytes(b'downloaded')
            callback = self.progress_callback
            callback('Downloading video stream', 10, 1_000_000_000, 2_400_000_000)
            time.sleep(.05)
            callback('Downloading video stream', 50, 1_200_000_000, 2_400_000_000)

    monkeypatch.setattr('clip_engine.services.video_downloader.VideoDownloaderService', FakeDownloader)
    asyncio.run(run_editor({'action': 'create-project', 'run': str(tmp_path),
        'source': {'kind': 'url', 'url': 'https://youtu.be/x'}, 'focus_clip': 0},
        progress=lambda value: events.append(value)))
    downloading = [e for e in events if e['phase'] == 'scan']
    assert downloading[0] == {'phase': 'scan', 'percent': 10, 'downloaded_bytes': 1_000_000_000, 'total_bytes': 2_400_000_000}
    half = downloading[1]
    assert half['percent'] == 50 and half['downloaded_bytes'] == 1_200_000_000 and half['total_bytes'] == 2_400_000_000
    assert 0 < half['speed'] < 1e12  # ≈ 200 MB over the .05 s between callbacks.
    assert 'preview' in [e['phase'] for e in events]


def test_windowed_capture_bounds_the_ffmpeg_read_window(monkeypatch, tmp_path):
    commands = []
    renderer = RenderingService.__new__(RenderingService)
    renderer.settings = SimpleNamespace(local_mode=True, ffmpeg_preset='fast', ffmpeg_crf=20)
    renderer._local_cpu_encoder = 'libopenh264'
    monkeypatch.setattr(renderer, '_get_video_dimensions', AsyncMock(return_value=(1920, 1080)), raising=False)
    monkeypatch.setattr(renderer, '_probe_fps', AsyncMock(return_value='30'), raising=False)

    async def run_cmd(cmd, **kwargs):
        commands.append((cmd, kwargs))
        Path(cmd[-1]).write_bytes(b'')

    monkeypatch.setattr(renderer, '_run_cmd', run_cmd, raising=False)
    monkeypatch.setattr('clip_engine.services.rendering_service.preview_duration_ok', lambda *a, **k: True)
    asyncio.run(renderer.capture_framing_source('in.mp4', str(tmp_path / 'window.mp4'),
        progress=lambda percent: None, start_ms=10000, end_ms=15000))
    cmd, kwargs = commands[-1]
    assert cmd[cmd.index('-ss') + 1] == '10.000000' and cmd[cmd.index('-t') + 1] == '5.000000'
    assert cmd.index('-ss') < cmd.index('-i') and cmd.index('-t') < cmd.index('-i')
    assert kwargs['duration_ms'] == 5000  # Progress percent covers only the window.
    asyncio.run(renderer.capture_framing_source('in.mp4', str(tmp_path / 'full.mp4')))
    assert '-ss' not in commands[-1][0] and '-t' not in commands[-1][0]
    for bad in ({'start_ms': 1000}, {'start_ms': 5000, 'end_ms': 5050}, {'start_ms': -1, 'end_ms': 5000}):
        with pytest.raises(ValueError):
            asyncio.run(renderer.capture_framing_source('in.mp4', str(tmp_path / 'bad.mp4'), **bad))


@pytest.mark.skipif(not (shutil.which('ffmpeg') and shutil.which('ffprobe')),
                    reason='FFmpeg and FFprobe are needed for the windowed preview check')
def test_windowed_preview_decodes_only_the_requested_span(monkeypatch, tmp_path):
    renderer = RenderingService()
    monkeypatch.setattr(renderer.settings, 'local_mode', True)
    renderer._verify_ffmpeg()
    source = tmp_path / 'editor-source.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=30:duration=6',
        '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest',
        *renderer._video_codec_args(160, 90), '-pix_fmt', 'yuv420p', str(source)],
        check=True, capture_output=True, timeout=60)
    out = tmp_path / 'window.mp4'
    asyncio.run(renderer.capture_framing_source(str(source), str(out), start_ms=2000, end_ms=4000))
    probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(out)],
        capture_output=True, text=True, check=True, timeout=30)
    assert 1.6 < float(probe.stdout.strip()) < 2.4, 'a 2-second window of a 6-second source'


def test_import_keeps_word_timings_for_text_cutting(monkeypatch, tmp_path):
    automatic_run(tmp_path)
    patch_import(monkeypatch)
    asyncio.run(run_editor({'action': 'create-project', 'run': str(tmp_path), 'source': {'kind': 'file'}}))
    project = json.loads((tmp_path / 'editor-project.json').read_text())
    first = project['transcript'][0]
    assert first['speaker'] == 'S1'
    assert first['words'] == [{'start_ms': 0, 'end_ms': 2000, 'text': 'First'},
                              {'start_ms': 2100, 'end_ms': 3900, 'text': 'line'}]  # malformed/reversed words dropped
    assert 'words' not in project['transcript'][1]  # a line without words stays wordless
    from clip_engine.services.manual_editor import transcript_row
    row = transcript_row({'start_time_ms': -500, 'end_time_ms': 999999, 'text': 'x' * 20001,
                          'speaker_label': 'S9', 'words': [{'word': 'w', 'start_time_ms': 0, 'end_time_ms': 10}] * 401}, 30000)
    assert row['start_ms'] == 0 and row['end_ms'] == 30000 and len(row['text']) == 20000
    assert row['speaker'] == 'S9' and len(row['words']) == 400  # per-line word cap


def test_brand_vocabulary_merges_into_the_editor_keywords(monkeypatch, tmp_path):
    """The user's Brand Vocabulary rides into every import so keyword highlights
    stay consistent across projects, alongside any source brief vocabulary."""
    from clip_engine.services import manual_editor as module
    (tmp_path / 'source_context.json').write_text(json.dumps({'brief': {'vocabulary': ['Tana', 'Mongeau']}}))
    monkeypatch.setenv('BRIDGECLIP_KEYTERMS', json.dumps(['TANA', 'BridgeClip', 42, '  ']))
    assert module.project_keywords(tmp_path) == ['tana', 'mongeau', 'bridgeclip']
    monkeypatch.setenv('BRIDGECLIP_KEYTERMS', 'not json')
    assert module.project_keywords(tmp_path) == ['tana', 'mongeau']
    (tmp_path / 'source_context.json').unlink()
    monkeypatch.setenv('BRIDGECLIP_KEYTERMS', json.dumps(['BridgeClip']))
    assert module.project_keywords(tmp_path) == ['bridgeclip']
