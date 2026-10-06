"""The editor's "Add audio": a link or a staged file becomes an m4a editor asset.

A link downloads its audio-only stream through the guarded yt-dlp stack and the
file path stays inside the run (main stages picks there first). Both routes
normalize to `editor-asset-<id>.m4a` — the exact shape of an uploaded asset —
and return the reference, a library title and the duration to main.
"""
import asyncio
import contextlib
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from clip_engine.services.manual_editor import EditorError, run_editor


def fake_audio_stack(monkeypatch, *, duration=180.0, title='My Song', probe_streams=None, transcode_size=1024, downloaded_ext='opus'):
    from clip_engine.services import manual_editor as module
    import clip_engine.network_policy as network_policy
    import clip_engine.services.media_process as media_process
    calls = {'ffprobe': [], 'ffmpeg': [], 'ytdlp': [], 'hooks': 0}

    def run(cmd, timeout=None, check=False):
        if cmd[0] == 'ffprobe':
            calls['ffprobe'].append(cmd)
            streams = probe_streams if probe_streams is not None else [{'codec_type': 'audio', 'duration': str(duration)}]
            return SimpleNamespace(stdout=json.dumps({'streams': streams, 'format': {'duration': str(duration)}}))
        calls['ffmpeg'].append(cmd)
        Path(cmd[-1]).write_bytes(b'x' * transcode_size)
        return SimpleNamespace(stdout='')

    monkeypatch.setattr(module, 'run_media', run)

    @contextlib.contextmanager
    def children(deadline=None):
        yield

    monkeypatch.setattr(media_process, 'guarded_ytdlp_children', children)
    monkeypatch.setattr(network_policy, 'guarded_public_connections', contextlib.nullcontext)

    class FakeYoutubeDL:
        def __init__(self, opts):
            self.opts = opts
            calls['ytdlp'].append(opts)

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def extract_info(self, url, download=False):
            calls['ytdlp'].append(('info', url))
            return {'duration': duration, 'title': title}

        def download(self, urls):
            calls['ytdlp'].append(('download', urls))
            for hook in self.opts['progress_hooks']:
                calls['hooks'] += 1
                hook({'status': 'downloading', 'downloaded_bytes': 50, 'total_bytes': 100})
            Path(self.opts['outtmpl'].replace('%(ext)s', downloaded_ext)).write_bytes(b'audio bytes')

    monkeypatch.setitem(sys.modules, 'yt_dlp', SimpleNamespace(YoutubeDL=FakeYoutubeDL, version=SimpleNamespace(__version__='test')))
    return calls


def test_link_import_downloads_audio_and_writes_an_m4a_asset(monkeypatch, tmp_path):
    calls = fake_audio_stack(monkeypatch)
    result = asyncio.run(run_editor({'action': 'import-audio', 'run': str(tmp_path), 'source': {'kind': 'url', 'url': 'https://example.com/song'}}))
    assert re.fullmatch(r'[a-f0-9]{32}\.m4a', result['asset'])
    assert (tmp_path / f"editor-asset-{result['asset']}").read_bytes() == b'x' * 1024
    assert result['title'] == 'My Song' and result['duration_ms'] == 180000
    assert calls['ytdlp'][0]['format'] == 'bestaudio/best'
    assert calls['ytdlp'][0]['outtmpl'].startswith(str(tmp_path / '.editor-audio-'))
    assert ('info', 'https://example.com/song') in calls['ytdlp'] and ('download', ['https://example.com/song']) in calls['ytdlp']
    transcode = calls['ffmpeg'][0]
    assert '-vn' in transcode and transcode[-1] == str(tmp_path / f"editor-asset-{result['asset']}")
    # The raw download is consumed by the transcode and removed; only the asset stays.
    assert not list(tmp_path.glob('.editor-audio-*'))
    assert len([p for p in tmp_path.iterdir() if p.is_file()]) == 1


def test_link_import_reports_audio_progress(monkeypatch, tmp_path):
    fake_audio_stack(monkeypatch)
    events = []
    asyncio.run(run_editor({'action': 'import-audio', 'run': str(tmp_path), 'source': {'kind': 'url', 'url': 'https://example.com/song'}},
                           progress=events.append))
    assert events[0] == {'phase': 'audio', 'percent': 0}
    assert {'phase': 'audio', 'percent': 50, 'downloaded_bytes': 50, 'total_bytes': 100} in events
    assert all(e['phase'] == 'audio' for e in events)


def test_a_link_without_usable_audio_is_refused_and_cleans_up(monkeypatch, tmp_path):
    fake_audio_stack(monkeypatch, duration=4000.0)
    with pytest.raises(EditorError) as error:
        asyncio.run(run_editor({'action': 'import-audio', 'run': str(tmp_path), 'source': {'kind': 'url', 'url': 'https://example.com/long'}}))
    assert error.value.editor_code == 'invalid'
    assert not list(tmp_path.glob('.editor-audio-*')) and not list(tmp_path.glob('editor-asset-*'))


def test_non_http_links_never_reach_the_downloader(monkeypatch, tmp_path):
    calls = fake_audio_stack(monkeypatch)
    for url in ['ftp://example.com/song', 'file:///C:/song.mp3', 'https://x/' + 'a' * 2100, 42]:
        with pytest.raises(EditorError) as error:
            asyncio.run(run_editor({'action': 'import-audio', 'run': str(tmp_path), 'source': {'kind': 'url', 'url': url}}))
        assert error.value.editor_code == 'invalid'
    assert calls['ytdlp'] == []


def test_file_import_extracts_audio_from_the_staged_pick(monkeypatch, tmp_path):
    calls = fake_audio_stack(monkeypatch)
    staged = 'editor-asset-' + 'a' * 32 + '.mp4'
    (tmp_path / staged).write_bytes(b'video with audio')
    result = asyncio.run(run_editor({'action': 'import-audio', 'run': str(tmp_path), 'title': '  Podcast   Episode 1  ',
                                     'source': {'kind': 'file', 'name': staged}}))
    assert result['title'] == 'Podcast Episode 1' and result['duration_ms'] == 180000
    assert str(tmp_path / staged) in calls['ffprobe'][0]
    # The staged copy belongs to main; the engine leaves it alone.
    assert (tmp_path / staged).exists()


def test_file_import_only_accepts_staged_asset_names(monkeypatch, tmp_path):
    fake_audio_stack(monkeypatch)
    for name in ['editor-source.mp4', '../editor-asset-' + 'a' * 32 + '.mp4', 'editor-asset-zz.mp4', 42]:
        with pytest.raises(EditorError) as error:
            asyncio.run(run_editor({'action': 'import-audio', 'run': str(tmp_path), 'source': {'kind': 'file', 'name': name}}))
        assert error.value.editor_code == 'invalid'


def test_media_without_an_audio_track_is_refused(monkeypatch, tmp_path):
    fake_audio_stack(monkeypatch, probe_streams=[{'codec_type': 'video', 'duration': '180.0'}])
    staged = 'editor-asset-' + 'b' * 32 + '.mov'
    (tmp_path / staged).write_bytes(b'silent video')
    with pytest.raises(EditorError) as error:
        asyncio.run(run_editor({'action': 'import-audio', 'run': str(tmp_path), 'source': {'kind': 'file', 'name': staged}}))
    assert error.value.editor_code == 'invalid'
    # Only the staged pick remains; no m4a asset was produced.
    assert [q.name for q in tmp_path.glob('editor-asset-*')] == [staged]


def test_an_oversized_extract_is_refused_and_removed(monkeypatch, tmp_path):
    from clip_engine.services import manual_editor as module
    calls = fake_audio_stack(monkeypatch, transcode_size=500)
    monkeypatch.setattr(module, 'AUDIO_MAX_BYTES', 100)
    with pytest.raises(EditorError) as error:
        asyncio.run(run_editor({'action': 'import-audio', 'run': str(tmp_path), 'source': {'kind': 'url', 'url': 'https://example.com/song'}}))
    assert error.value.editor_code == 'invalid'
    assert not list(tmp_path.glob('editor-asset-*')) and not list(tmp_path.glob('.editor-audio-*'))
    assert calls['ffmpeg']
