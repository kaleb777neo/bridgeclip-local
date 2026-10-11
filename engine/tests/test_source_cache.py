"""Editor material comes from disk before the network.

An automatic run keeps its downloaded source in the Library's `.source-cache`, so
"Edit this" restores it instead of fetching the same gigabytes again. Reuse needs a
probe that passes, and the cache is bounded by a byte budget.
"""
import asyncio
import json
import os
import time
from pathlib import Path

import pytest

from clip_engine.services import source_cache
from clip_engine.services.manual_editor import run_editor

URL = 'https://www.youtube.com/watch?v=example'


def library(tmp_path):
    root = tmp_path / 'library'
    root.mkdir()
    return root


def blob(size=4096):
    return b'x' * size


def test_entry_path_is_stable_per_url_and_refuses_local_paths(tmp_path):
    root = library(tmp_path)
    first = source_cache.entry_path(root, URL)
    assert first == source_cache.entry_path(root, URL)
    assert first != source_cache.entry_path(root, 'https://www.youtube.com/watch?v=other')
    assert first.parent.name == source_cache.CACHE_DIR_NAME
    assert source_cache.entry_path(root, str(root / 'picked.mp4')) is None
    assert source_cache.entry_path(tmp_path / 'nowhere', URL) is None


def test_retain_moves_the_jobs_download_into_the_cache(tmp_path):
    root = library(tmp_path)
    work = tmp_path / 'work'
    work.mkdir()
    source = work / 'source.mp4'
    source.write_bytes(blob())
    assert source_cache.retain(root, URL, source) is True
    assert not source.exists()
    assert source_cache.entry_path(root, URL).read_bytes() == blob()


def test_retain_copies_when_the_work_folder_is_on_another_drive(tmp_path, monkeypatch):
    root = library(tmp_path)
    work = tmp_path / 'work'
    work.mkdir()
    source = work / 'source.mp4'
    source.write_bytes(blob())
    def cross_device(origin, target):
        raise OSError(18, 'Cross-device link')
    monkeypatch.setattr(source_cache.os, 'rename', cross_device)
    assert source_cache.retain(root, URL, source) is True
    assert source_cache.entry_path(root, URL).read_bytes() == blob()
    assert not list((root / source_cache.CACHE_DIR_NAME).glob('*.moving'))


def test_retain_ignores_a_stub_and_never_loses_the_run(tmp_path):
    root = library(tmp_path)
    source = tmp_path / 'source.mp4'
    source.write_bytes(b'stub')
    assert source_cache.retain(root, URL, source) is False
    assert source.exists()


def test_copy_moves_a_proven_file_into_the_run(tmp_path):
    root = library(tmp_path)
    work = tmp_path / 'work'
    work.mkdir()
    source = work / 'source.mp4'
    source.write_bytes(blob())
    source_cache.retain(root, URL, source)
    run = root / '0b12e729-4a53-4243-95a4-3c8d517e48c3'
    run.mkdir()
    cached = source_cache.entry_path(root, URL)
    progress = []
    assert source_cache.copy_into(cached, run / 'editor-source.mp4',
        lambda copied, total: progress.append((copied, total))) is True
    assert (run / 'editor-source.mp4').read_bytes() == blob()
    assert progress and progress[-1][0] == progress[-1][1]
    # A cache slot holding a folder instead of a file is never a video.
    wrong = source_cache.entry_path(root, 'https://youtu.be/dir')
    wrong.mkdir()
    assert source_cache.is_usable(wrong) is False


def sibling(root, name, url):
    """A run folder that already finished an editor import of `url`."""
    run = root / name
    run.mkdir(parents=True)
    (run / 'job_output.json').write_text(json.dumps({'source_video_url': url}))
    video = run / 'editor-source.mp4'
    video.write_bytes(blob())
    return video


def test_a_sibling_run_with_the_same_video_supplies_the_source(tmp_path):
    root = library(tmp_path)
    video = sibling(root, '0b12e729-4a53-4243-95a4-3c8d517e48c3', URL)
    assert source_cache.library_copy(root, URL).resolve() == video.resolve()
    # Another video is never borrowed, and a hidden folder is not a run.
    assert source_cache.library_copy(root, 'https://youtu.be/other') is None
    assert source_cache.library_copy(root, str(root / 'local.mp4')) is None
    video.parent.rename(root / '.hidden')
    assert source_cache.library_copy(root, URL) is None
    # A run whose import was interrupted leaves nothing usable behind.
    other = sibling(root, '1c2b3a49-6d7e-48f5-9a0b-1c2d3e4f5061', URL)
    other.unlink()
    assert source_cache.library_copy(root, URL) is None


def test_budget_drops_the_least_recently_used_copies(tmp_path):
    root = library(tmp_path)
    directory = root / source_cache.CACHE_DIR_NAME
    directory.mkdir()
    old, recent = directory / ('a' * 20 + '.mp4'), directory / ('b' * 20 + '.mp4')
    recent.write_bytes(blob())
    old.write_bytes(blob())
    old_mtime = time.time() - 600
    os.utime(str(old), (old_mtime, old_mtime))
    source_cache.enforce_budget(root, budget=len(blob()) + 1)
    assert not old.exists() and recent.exists()
    source_cache.enforce_budget(root, budget=0)
    assert not recent.exists()


def automatic_run(run, url=URL):
    run.mkdir()
    (run / 'job_output.json').write_text(json.dumps({
        'source_video_url': url, 'editor_project': False, 'clips': [
            {'clip_index': 0, 's3_url': str(run / 'clip_00.mp4'), 'duration_ms': 5000, 'start_time_ms': 1000,
             'end_time_ms': 6000, 'virality_score': .9, 'layout_type': 'talking_head', 'summary': 'First'}],
        'metrics': {'requested_settings': {'aspect_ratio': '9:16', 'video_speed': 1}, 'captions_status': 'enabled'}}))
    (run / 'transcript.json').write_text(json.dumps({'segments': [
        {'start_time_ms': 0, 'end_time_ms': 4000, 'text': 'First line'}]}))


def imported_run(tmp_path, monkeypatch):
    """One automatic run plus a downloader that records every network attempt."""
    root = library(tmp_path)
    run = root / '0b12e729-4a53-4243-95a4-3c8d517e48c3'
    automatic_run(run)
    calls = []

    class FakeDownloader:
        def __init__(self):
            self.progress_callback = None

        async def download_video(self, url, output_dir, output_filename):
            calls.append(url)
            Path(output_dir, output_filename).write_bytes(blob())

    monkeypatch.setattr('clip_engine.services.video_downloader.VideoDownloaderService', FakeDownloader)
    from clip_engine.services import manual_editor as module
    monkeypatch.setattr(module, 'source_info', lambda path: {'width': 1920, 'height': 1080, 'duration': 30000,
        'rotation': 0, 'sar': '1:1', 'audio': True})
    from clip_engine.services.rendering_service import RenderingService

    async def preview(self, src, dest, **kwargs):
        Path(dest).write_bytes(b'preview')

    monkeypatch.setattr(RenderingService, 'capture_framing_source', preview)
    return root, run, calls


def request(root, run, **extra):
    return {'action': 'create-project', 'run': str(run), 'library': str(root),
        'source': {'kind': 'url', 'url': URL}, **extra}


def test_an_edit_after_a_run_needs_no_download(monkeypatch, tmp_path):
    root, run, calls = imported_run(tmp_path, monkeypatch)
    cached = source_cache.entry_path(root, URL)
    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_bytes(blob())
    events = []
    asyncio.run(run_editor(request(root, run), progress=lambda value: events.append(value)))
    assert calls == []
    assert (run / 'editor-source.mp4').read_bytes() == blob()
    assert [event for event in events if event['phase'] == 'scan'][0]['local'] is True


def test_a_finished_import_is_never_downloaded_twice(monkeypatch, tmp_path):
    root, run, calls = imported_run(tmp_path, monkeypatch)
    (run / 'editor-source.mp4').write_bytes(blob())
    asyncio.run(run_editor(request(root, run)))
    assert calls == []
    assert not (root / source_cache.CACHE_DIR_NAME).exists()


def test_the_second_run_of_the_same_video_needs_no_download(monkeypatch, tmp_path):
    """One imported copy serves every later run of that video, from disk."""
    root, run, calls = imported_run(tmp_path, monkeypatch)
    imported = root / '1c2b3a49-6d7e-48f5-9a0b-1c2d3e4f5061'
    automatic_run(imported)
    (imported / 'editor-source.mp4').write_bytes(b'y' * 4096)
    events = []
    asyncio.run(run_editor(request(root, run), progress=lambda value: events.append(value)))
    assert calls == []
    assert (run / 'editor-source.mp4').read_bytes() == b'y' * 4096
    assert [event for event in events if event['phase'] == 'scan'][0]['local'] is True


def test_a_truncated_leftover_falls_back_to_the_network(monkeypatch, tmp_path):
    root, run, calls = imported_run(tmp_path, monkeypatch)
    leftover = run / 'editor-source.mp4'
    leftover.write_bytes(blob())
    from clip_engine.services import manual_editor as module
    probed = []

    def media(path):
        # Only the reuse probe sees the leftover; the download that follows is real.
        reject = str(path) == str(leftover) and not probed
        probed.append(str(path))
        if reject:
            raise ValueError('truncated')
        return {'width': 1920, 'height': 1080, 'duration': 30000, 'rotation': 0, 'sar': '1:1', 'audio': True}
    monkeypatch.setattr(module, 'source_info', media)
    asyncio.run(run_editor(request(root, run, allow_download=True)))
    assert calls == [URL]
    assert probed and leftover.read_bytes() == blob()  # The download replaced the corpse.


def test_no_download_without_an_explicit_yes(monkeypatch, tmp_path):
    """An Edit click on a run whose original is gone asks first; it never pulls bytes."""
    root, run, calls = imported_run(tmp_path, monkeypatch)
    events = []
    with pytest.raises(ValueError) as error:
        asyncio.run(run_editor(request(root, run), progress=lambda value: events.append(value)))
    assert error.value.editor_code == 'source_missing'
    assert calls == []
    assert not (run / 'editor-source.mp4').exists()
    assert not [event for event in events if event.get('downloaded_bytes') is not None]


def test_an_unusable_url_never_reaches_the_disk_checks(monkeypatch, tmp_path):
    root, run, calls = imported_run(tmp_path, monkeypatch)
    asyncio.run(run_editor({**request(root, run, allow_download=True), 'source': {'kind': 'url', 'url': 'ftp://nope'}}))
    assert calls == ['ftp://nope']
    assert not (root / source_cache.CACHE_DIR_NAME).exists()


def test_a_finished_run_keeps_its_download_for_the_editor(monkeypatch, tmp_path):
    """The job's temp source lands in the Library cache instead of the recycle bin."""
    from types import SimpleNamespace
    from clip_engine.config import get_settings
    from clip_engine.services import ai_clipping_pipeline as pipeline_module
    from clip_engine.services.ai_clipping_pipeline import AIClippingPipeline, ClippingJobRequest
    from clip_engine.services.rendering_service import RenderingService, RenderResult
    from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord, TranscriptionResult

    settings = pipeline_module.get_settings()
    library = tmp_path / 'library'
    library.mkdir()
    monkeypatch.setattr(settings, 'local_mode', True)
    monkeypatch.setattr(settings, 'local_output_dir', str(library))
    monkeypatch.setattr(settings.__class__, 'temp_directory', property(lambda self: str(tmp_path / 'work')))
    monkeypatch.setattr(RenderingService, '_verify_ffmpeg', lambda self: None)
    pipeline = AIClippingPipeline()
    pipeline.local_mode = True

    async def download(url, output_dir):
        source = Path(output_dir, 'source.mp4')
        source.write_bytes(blob())
        return SimpleNamespace(video_path=str(source), source_type='youtube', file_size_bytes=source.stat().st_size,
            metadata=SimpleNamespace(title='Talk', duration_seconds=60.0, width=1920, height=1080, description='',
                uploader=None))

    async def transcribe(video_path, work_dir, keyterms=None, **_range):
        return TranscriptionResult(segments=[TranscriptSegment(0, 800, 'hello', words=[TranscriptWord('hello', 0, 800)])],
            full_text='hello')

    async def render(request):
        from clip_engine.services.clip_editor import TimeMap
        from clip_engine.services.layout_analyzer import ClipLayoutPlan, LayoutType, ShotLayout
        Path(request.output_path).write_bytes(b'mp4')
        return RenderResult(output_path=request.output_path, file_size_bytes=3, duration_ms=60_000,
            layout_type='talking_head', layout_cost_usd=0.0,
            used_plan=ClipLayoutPlan(shots=[ShotLayout(0, 60_000, LayoutType.TALKING_HEAD, source='fallback')],
                source_width=1920, source_height=1080, face_samples=[]),
            used_time_map=TimeMap([(0, 60_000)], 60_000))

    monkeypatch.setattr(pipeline.video_downloader, 'download_video', download)
    monkeypatch.setattr(pipeline.transcription_service, 'transcribe', transcribe)
    monkeypatch.setattr(pipeline.rendering_service, 'render_clip', render)
    result = asyncio.run(pipeline.process_video(ClippingJobRequest(video_url=URL, job_id='retained',
        workflow='captions-only', aspect_ratio='9:16', include_captions=False, include_title=False)))
    assert result.status.value == 'completed'
    assert not (tmp_path / 'work' / 'retained').exists()
    cached = source_cache.entry_path(library, URL)
    assert cached.read_bytes() == blob()
    assert not (library / 'retained' / 'source.mp4').exists()
