"""Preview completeness validation: an interrupted transcode never becomes the final preview.

capture_framing_source renames X.partial.mp4 to X only after FFmpeg exited 0 and ffprobe reads a
duration within ~2s of the intended length (the full source, or the window of a fast per-reel
preview). create-project re-validates any preview a previous interrupted import left behind and
rebuilds instead of trusting it; a failed rebuild surfaces as render_failed without committing.
"""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import clip_engine.services.rendering_service as rs
from clip_engine.services.manual_editor import run_editor
from clip_engine.services.rendering_service import RenderingService, RenderingError, preview_duration_ok


def stub_renderer(monkeypatch):
    """A RenderingService without a real FFmpeg environment: probes and encoder choice are fixed."""
    renderer = RenderingService.__new__(RenderingService)
    renderer.settings = SimpleNamespace(local_mode=True, ffmpeg_preset='fast', ffmpeg_crf=20)
    renderer._local_cpu_encoder = 'libopenh264'
    monkeypatch.setattr(renderer, '_get_video_dimensions', AsyncMock(return_value=(1920, 1080)), raising=False)
    monkeypatch.setattr(renderer, '_probe_fps', AsyncMock(return_value='30'), raising=False)
    return renderer


def fake_ffmpeg(monkeypatch, renderer, exit_code=0, partial_bytes=b'preview'):
    """Mocked FFmpeg stage: writes the partial file and reports the exit code via _run_cmd."""
    async def run_cmd(cmd, **kwargs):
        Path(cmd[-1]).write_bytes(partial_bytes)
        if exit_code:
            raise RenderingError('Video encoding failed')
    monkeypatch.setattr(renderer, '_run_cmd', run_cmd, raising=False)


def fake_probe(monkeypatch, durations):
    """Mocked ffprobe: answers each format=duration query in order (bytes or Exception)."""
    asked = []
    answers = list(durations)

    def run(cmd, **kwargs):
        asked.append(cmd)
        assert cmd[0] == 'ffprobe'
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return SimpleNamespace(returncode=0, stdout=answer, stderr=b'')
    monkeypatch.setattr(rs, 'run_media', run)
    return asked


# --- preview_duration_ok ----------------------------------------------------------------------

def test_duration_probe_accepts_the_intended_length_within_two_seconds(monkeypatch):
    for stdout, expected in ((b'10.000000\n', 10000), (b'9.9', 10000), (b'11.9', 10000), (b'12.0', 10000)):
        fake_probe(monkeypatch, [stdout])
        assert preview_duration_ok('preview.mp4', expected), stdout


def test_duration_probe_rejects_truncated_broken_and_unreadable_previews(monkeypatch):
    fake_probe(monkeypatch, [b'7.8'])  # 2.2 s short of a 10 s preview.
    assert preview_duration_ok('preview.mp4', 10000) is False
    fake_probe(monkeypatch, [b'0.0'])
    assert preview_duration_ok('preview.mp4', 10000) is False
    for broken in (b'N/A', b'not json'):
        fake_probe(monkeypatch, [broken])
        assert preview_duration_ok('preview.mp4', 10000) is False, broken
    fake_probe(monkeypatch, [OSError('ffprobe missing')])
    assert preview_duration_ok('missing.mp4', 10000) is False


# --- capture_framing_source rename gate -------------------------------------------------------

def test_capture_renames_only_a_probe_verified_partial(monkeypatch, tmp_path):
    renderer = stub_renderer(monkeypatch)
    fake_ffmpeg(monkeypatch, renderer)
    final = tmp_path / 'editor-preview.mp4'
    fake_probe(monkeypatch, [b'10.0'])  # The partial probes at the intended 10 s.
    asyncio.run(renderer.capture_framing_source('source.mp4', str(final), duration_ms=10000))
    assert final.read_bytes() == b'preview'
    assert not Path(str(final) + '.partial.mp4').exists()


def test_capture_keeps_truncated_partial_from_becoming_final(monkeypatch, tmp_path):
    renderer = stub_renderer(monkeypatch)
    fake_ffmpeg(monkeypatch, renderer)
    final = tmp_path / 'editor-preview.mp4'
    fake_probe(monkeypatch, [b'925068.0'])  # Far short of the intended 1 h preview.
    partial = str(final) + '.partial.mp4'
    with pytest.raises(RenderingError, match='incomplete'):
        asyncio.run(renderer.capture_framing_source('source.mp4', str(final), duration_ms=3600000))
    assert not final.exists()
    assert not Path(partial).exists()  # The failed partial is cleaned up, never renamed.


def test_capture_clears_a_stale_partial_before_retrying(monkeypatch, tmp_path):
    renderer = stub_renderer(monkeypatch)
    final = tmp_path / 'editor-preview.mp4'
    Path(str(final) + '.partial.mp4').write_bytes(b'truncated leftover')
    fake_ffmpeg(monkeypatch, renderer)
    fake_probe(monkeypatch, [b'10.0'])
    asyncio.run(renderer.capture_framing_source('source.mp4', str(final), duration_ms=10000))
    assert final.read_bytes() == b'preview'


def test_capture_never_renames_after_a_failing_ffmpeg(monkeypatch, tmp_path):
    renderer = stub_renderer(monkeypatch)
    fake_ffmpeg(monkeypatch, renderer, exit_code=1)
    final = tmp_path / 'editor-preview.mp4'
    with pytest.raises(RenderingError):
        asyncio.run(renderer.capture_framing_source('source.mp4', str(final), duration_ms=10000))
    assert not final.exists()
    assert not Path(str(final) + '.partial.mp4').exists()


def test_windowed_preview_validates_against_the_window_not_the_source(monkeypatch, tmp_path):
    renderer = stub_renderer(monkeypatch)
    fake_ffmpeg(monkeypatch, renderer)
    asked = fake_probe(monkeypatch, [b'5.0'])
    final = tmp_path / 'editor-preview.mp4'
    asyncio.run(renderer.capture_framing_source('source.mp4', str(final), duration_ms=3600000,
        start_ms=20000, end_ms=25000))
    # The 5 s window of a 1 h source passes: the intended length is the window, not the cap.
    assert final.read_bytes() == b'preview'
    assert len(asked) == 1


# --- create-project trust-on-open validation --------------------------------------------------

def automatic_run(tmp_path):
    (tmp_path / 'job_output.json').write_text(json.dumps({
        'source_video_title': 'My video', 'editor_project': False, 'total_clips': 2, 'clips': [
            {'clip_index': 0, 's3_url': str(tmp_path / 'clip_00.mp4'), 'duration_ms': 5000, 'start_time_ms': 1000,
             'end_time_ms': 6000, 'virality_score': 0.9, 'layout_type': 'talking_head', 'summary': 'First'},
            {'clip_index': 1, 's3_url': str(tmp_path / 'clip_01.mp4'), 'duration_ms': 4000, 'start_time_ms': 20000,
             'end_time_ms': 24000, 'virality_score': 0.5, 'layout_type': 'screen', 'summary': 'Second'}],
        'metrics': {'requested_settings': {'aspect_ratio': '9:16', 'video_speed': 1}, 'captions_status': 'enabled'}}))
    (tmp_path / 'transcript.json').write_text(json.dumps({'segments': []}))
    (tmp_path / 'editor-source.mp4').write_bytes(b'streamed by main')


def patch_import(monkeypatch, captures, preview_ok=True):
    from clip_engine.services import manual_editor as module
    monkeypatch.setattr(module, 'source_info', lambda path: {'width': 1920, 'height': 1080, 'duration': 30000,
        'rotation': 0, 'sar': '1:1', 'audio': True})
    verdicts = []

    def duration_ok(path, expected_ms, *args, **kwargs):
        verdicts.append((str(path), expected_ms))
        return preview_ok

    async def preview(self, src, dest, **kwargs):
        captures.append(dict(kwargs))
        Path(dest).write_bytes(b'fresh preview')

    monkeypatch.setattr(module, 'preview_duration_ok', duration_ok)
    monkeypatch.setattr(RenderingService, 'capture_framing_source', preview)
    return verdicts


def test_create_project_drops_a_truncated_leftover_preview_before_rebuilding(monkeypatch, tmp_path):
    automatic_run(tmp_path)
    leftover = tmp_path / 'editor-preview.mp4'
    leftover.write_bytes(b'truncated 925MB leftover')
    captures = []
    verdicts = patch_import(monkeypatch, captures, preview_ok=False)
    asyncio.run(run_editor({'action': 'create-project', 'run': str(tmp_path), 'source': {'kind': 'file'}}))
    assert verdicts == [(str(leftover), 30000)]  # Validated against the source duration first.
    assert len(captures) == 1  # Rebuilt instead of trusting the existing file.
    assert (tmp_path / 'editor-preview.mp4').read_bytes() == b'fresh preview'
    assert (tmp_path / 'editor-project.json').exists()


def test_create_project_reuses_the_validation_but_still_rebuilds_a_complete_leftover(monkeypatch, tmp_path):
    automatic_run(tmp_path)
    leftover = tmp_path / 'editor-preview.mp4'
    leftover.write_bytes(b'complete-looking preview')
    captures = []
    verdicts = patch_import(monkeypatch, captures, preview_ok=True)
    asyncio.run(run_editor({'action': 'create-project', 'run': str(tmp_path), 'source': {'kind': 'file'}}))
    assert len(verdicts) == 1 and len(captures) == 1
    # The uncommitted leftover predates this run's source, so only a fresh build is trusted.
    assert (tmp_path / 'editor-preview.mp4').read_bytes() == b'fresh preview'


def test_create_project_fails_clearly_when_the_rebuild_breaks(monkeypatch, tmp_path):
    automatic_run(tmp_path)
    truncated = tmp_path / 'editor-preview.mp4'
    truncated.write_bytes(b'truncated')

    def fail(self, src, dest, **kwargs):
        raise RenderingError('Editor preview transcode is incomplete')

    patch_import(monkeypatch, [], preview_ok=False)
    monkeypatch.setattr(RenderingService, 'capture_framing_source', fail)
    with pytest.raises(RenderingError) as error:
        asyncio.run(run_editor({'action': 'create-project', 'run': str(tmp_path), 'source': {'kind': 'file'}}))
    assert error.value.editor_code == 'render_failed'
    assert not truncated.exists()  # The invalid leftover is gone, not half-trusted.
    assert not (tmp_path / 'editor-project.json').exists()
    assert json.loads((tmp_path / 'job_output.json').read_text())['editor_project'] is not True
