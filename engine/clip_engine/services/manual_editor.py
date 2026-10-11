"""Review-first projects: suggestions and Jev advice, then exact human-directed exports."""
import asyncio
import json
import math
import os
import re
import tempfile
import time
from contextlib import contextmanager
from uuid import uuid4
from datetime import datetime, timezone
from dataclasses import fields, replace
from pathlib import Path
from clip_engine.error_policy import NoClipCandidatesError

from clip_engine.services.coherence_review import CLIP_QUESTIONS, CUT_QUESTIONS, CoherenceReviewer, check_threshold, dialogue
from clip_engine.services.jev_service import JevService
from clip_engine.services.layout_analyzer import Box, ClipLayoutPlan, ShotLayout, LayoutType, compact_focus_path
from clip_engine.services.layout_renderer import shot_views
from clip_engine.services.rendering_service import RenderRequest, RenderingService, preview_duration_ok
from clip_engine.services import source_cache
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord
from clip_engine.services.media_process import MEDIA_INPUT_OPTIONS, PROBE_TIMEOUT_SECONDS, run_media, validate_video_dimensions


# Fixed failure codes; the only failure detail that crosses the bridge.
EDITOR_ERROR_CODES = frozenset({'duration', 'geometry', 'audio', 'invalid', 'project_changed', 'invalid_edit', 'not_ready',
    'source_missing', 'source_incompatible', 'render_failed', 'scan_too_long', 'review_unavailable', 'engine_unavailable'})


class EditorError(ValueError):
    def __init__(self, code, message=None):
        self.editor_code = code
        super().__init__(message or code)


class SourceReplacementError(EditorError):
    def __init__(self, code):
        self.code = code
        super().__init__(code, 'Source replacement rejected')


@contextmanager
def failure_code(code):
    """Label failures without changing their type or message."""
    try:
        yield
    except Exception as error:
        if getattr(error, 'editor_code', None) not in EDITOR_ERROR_CODES:
            try:
                error.editor_code = code
            except AttributeError:
                pass
        raise


def utf16_prefix(text, limit):
    """At most `limit` UTF-16 units (the editor UI's string length), never half a surrogate pair."""
    units = 0
    for i, char in enumerate(text):
        units += 2 if ord(char) > 0xFFFF else 1
        if units > limit:
            return text[:i]
    return text


def media_name(kind, source_id=None):
    if source_id is not None and (not isinstance(source_id, str) or not re.fullmatch(r'[a-f0-9]{32}', source_id)):
        raise ValueError('Invalid source generation')
    return f'editor-{kind}{"-" + source_id if source_id else ""}.mp4'


def source_info(path):
    try:
        result = run_media(['ffprobe', '-v', 'error', *MEDIA_INPUT_OPTIONS, '-show_streams', '-show_format',
                            '-of', 'json', str(path)], timeout=PROBE_TIMEOUT_SECONDS, check=True)
        data = json.loads(result.stdout)
        video = next(s for s in data['streams'] if s['codec_type'] == 'video')
        width, height = int(video['width']), int(video['height'])
        validate_video_dimensions(width, height)
        if min(width, height) < 2:
            raise ValueError('Invalid editor dimensions')
        duration = float(video.get('duration', data['format'].get('duration', 0))) * 1000
        if not math.isfinite(duration) or duration < 100:
            raise ValueError('Invalid duration')
        rotation = next((s['rotation'] for s in video.get('side_data_list', []) if 'rotation' in s), 0)
        return {'width': width, 'height': height, 'duration': duration, 'rotation': rotation,
                'sar': video.get('sample_aspect_ratio') if video.get('sample_aspect_ratio') not in (None, 'N/A', '0:1') else '1:1',
                'audio': any(s['codec_type'] == 'audio' for s in data['streams'])}
    except Exception as error:
        raise SourceReplacementError('invalid') from error


def reuse_local_source(library, url, destination, report=None):
    """Take the source from disk instead of the network when it is already here.

    Looks at this run's own completed import first, then the copy the job kept in the
    Library's cache, then a sibling run that imported the same video. A candidate that
    doesn't probe is dropped, so a truncated file can never pass as the video.
    """
    if destination.is_symlink():
        return False
    candidates = (destination, source_cache.entry_path(library, url), source_cache.library_copy(library, url))
    for path in candidates:
        if path is None or not source_cache.is_usable(path):
            continue
        try:
            source_info(path)
        except Exception:
            if path == destination:
                try:
                    os.remove(str(destination))
                except OSError:
                    pass
            continue
        if path != destination and not source_cache.copy_into(path, destination,
                lambda copied, size: report and report('scan', 100 * copied / max(1, size), local=True)):
            continue
        if report:
            report('scan', 100, local=True)
        return True
    return False


async def replace_source(run, project, source_id):
    """Prepare immutable media, then switch the project's pointer in one atomic write."""
    source = local_file(run, media_name('source', source_id))
    original = local_file(run, media_name('source', project.get('source_id')))
    old, new = await asyncio.gather(asyncio.to_thread(source_info, original), asyncio.to_thread(source_info, source))
    if abs(old['duration'] - new['duration']) > 100:
        raise SourceReplacementError('duration')
    if (abs((new['width'] / new['height']) / (project['width'] / project['height']) - 1) > .005
            or old['rotation'] != new['rotation'] or old['sar'] != new['sar']):
        raise SourceReplacementError('geometry')
    if old['audio'] != new['audio']:
        raise SourceReplacementError('audio')
    preview = run / media_name('preview', source_id)
    if preview.exists() or preview.is_symlink():
        raise ValueError('Replacement preview already exists')
    with failure_code('render_failed'):
        await RenderingService().capture_framing_source(str(source), str(preview))
    # Recheck immediately before committing. Failed/cancelled generation never touches the project.
    if read_json(run, 'editor-project.json')['revision'] != project['revision']:
        raise EditorError('project_changed', 'Editor project changed')
    project.pop('preview_id', None)
    project['frame_preview'] = True
    # The replacement preview is built from the whole new source.
    project.pop('preview_start_ms', None)
    project.pop('preview_end_ms', None)
    project.update(source_id=source_id, width=new['width'], height=new['height'], revision=project['revision'] + 1)
    for candidate in project['candidates']:
        candidate.pop('camera_scan', None)
        candidate.pop('dismissed_camera_markers', None)
        candidate.pop('baked_hash', None)  # Earlier bakes used the previous source.
        if candidate.get('status') == 'baked':
            candidate['status'] = 'ready'
    # Focus paths belong to the old source geometry.
    (run / 'editor-tracking.json').unlink(missing_ok=True)
    atomic_json(run / 'editor-project.json', project)


def signature(c):
    # Canonical comparison is parsed JSON in the UI (Python keeps .0 floats).
    return json.dumps([c['title'], c['ranges'], [[s['at_ms'], s['layout'], s['crops']] +
        ([s['transition_ms']] if s.get('transition_ms') else []) for s in c['scenes']]], separators=(',', ':'), ensure_ascii=False)


def questions(schema, judgments, threshold=None, policy=None):
    result = []
    for name, question in schema.items():
        judgment = next((j for j in judgments if j and name in j.get('questions', {})), None) or {}
        answer = judgment.get('answers', {}).get(name, {})
        probability = answer.get('noul') if question['type'] == 'noul' else answer.get('probabilities', {}).get('sufficient')
        criteria = question['criteria']
        result.append({'id': name, 'prompt': question['instructions'], 'yes': criteria.get('true', criteria.get('sufficient', '')),
            'no': criteria.get('false', criteria.get('insufficient', '')), 'probability': probability,
            'threshold': check_threshold(name, threshold if threshold is not None else (policy['threshold'] if policy else .75), policy), 'status': judgment.get('status', 'unavailable')})
    return result


async def review_candidate(c, reviewer):
    report = {'moment': {'requires_visual_context': c.get('requires_visual_context', False)}}
    accepted = await reviewer.judge(c['title'], c['ranges'], report, 'candidate')
    attempt = report['coherence']['attempts'][-1]
    cuts = []
    for (_, a), (b, _) in zip(c['ranges'], c['ranges'][1:]):
        if a == b:
            continue
        state = {'title': c['title'], 'interval': [a, b], 'removed_text': dialogue(reviewer.segments, [(a, b)]),
            'before': dialogue(reviewer.segments, [(max(0, a - 15000), a)]),
            'after': dialogue(reviewer.segments, [(b, min(reviewer.duration_ms, b + 15000))]),
            'source_context': reviewer.source_context}
        judgment = await reviewer.service.evaluate(state, CUT_QUESTIONS)
        cuts.append({'interval': [a, b], 'questions': questions(CUT_QUESTIONS, [judgment], reviewer.policy['cut_threshold'], reviewer.policy)})
    accepted = accepted and all(q['probability'] is not None and q['probability'] >= q['threshold'] for cut in cuts for q in cut['questions'])
    c['review'] = {'signature': signature(c), 'reviewed_at': datetime.now(timezone.utc).isoformat(),
        'decision': 'passes' if accepted else 'needs_attention',
        'questions': questions(CLIP_QUESTIONS, [attempt.get('judgment'), attempt.get('policy_judgment')], policy=reviewer.policy), 'cuts': cuts}


def default_crop(w, h, aspect, cx=.5):
    cw, ch = min(1, h * aspect / w), min(1, w / aspect / h)
    return [max(0, min(1 - cw, cx - cw / 2)), (1 - ch) / 2, cw, ch]


def scenes_from_plan(shots, base_ms, w, h, aspect, fill_only=False):
    """Editor scenes from analyzed shots, plus their per-scene focus paths.

    Each scene keeps one static crop (the view at the shot's midpoint) for the
    UI; the tracking paths are returned separately so a crop edit silently
    overrides them. Returns (scenes, [[scene_at_ms, crops, [[abs_t_ms, cx, cy]]]]).
    `fill_only` collapses two-panel shots onto their presenter: Auto-frame
    promises one tracked vertical frame, never a static split.
    """
    scenes, tracking = [], []
    for j, shot in enumerate(shots[:60]):
        views = shot_views(shot, (shot.start_ms + shot.end_ms) // 2, w, h, 1080, 1920)
        if fill_only and len(views) == 2 and shot.layout == LayoutType.SCREEN_CAM:
            views = [views[1]]  # The camera panel is the person; the screen one is the content.
        elif fill_only:
            views = views[:1]
        normalized = []
        for ((x, y, cw, ch), _) in views[:2]:
            target = aspect * len(views)
            zoom = max(1, min(4, min(1, h * target / w) / max(.01, cw / w)))
            base_w, base_h = min(1, h * target / w) / zoom, min(1, w / target / h) / zoom
            normalized.append([max(0, min(1 - base_w, (x + cw / 2) / w - base_w / 2)), max(0, min(1 - base_h, (y + ch / 2) / h - base_h / 2)), base_w, base_h])
        at_ms = 0 if j == 0 else base_ms + shot.start_ms
        layout = 'split' if len(views) == 2 else 'fit' if shot.layout == LayoutType.SCREEN else 'fill'
        scenes.append({'at_ms': at_ms, 'layout': layout, 'crops': normalized})
        if layout == 'fill' and shot.focus_path and (shot.layout == LayoutType.TALKING_HEAD or fill_only):
            points = [[base_ms + shot.start_ms + int(t), round(cx, 4), round(cy, 4)] for t, cx, cy in compact_focus_path(shot.focus_path)]
            if len(points) > 1:
                tracking.append([at_ms, normalized, points])
    return scenes, tracking


def shots_from_summary(shots):
    """Rebuild the light ShotLayouts scenes_from_plan needs from persisted summaries."""
    boxes = {'screen_box', 'screen_focus', 'cam_box', 'content_box', 'crop_bounds'}
    layouts = {LayoutType.TALKING_HEAD, LayoutType.TWO_SHOT, LayoutType.SCREEN, LayoutType.SCREEN_CAM}
    result = []
    for item in shots:
        if not isinstance(item, dict) or item.get('layout') not in layouts:
            continue
        start, end = item.get('start_ms'), item.get('end_ms')
        if type(start) not in (int, float) or type(end) not in (int, float) or end <= start:
            continue
        def box(key):
            value = item.get(key)
            if isinstance(value, list) and len(value) == 4 and all(type(n) in (int, float) and 0 <= n <= 1 for n in value):
                return Box(*value)
            return None
        focus = [(int(t), float(cx), float(cy)) for t, cx, cy in item.get('focus_path') or []
                 if isinstance(t, (int, float)) and isinstance(cx, (int, float)) and isinstance(cy, (int, float))]
        people = [Box(*p) for p in item.get('people') or [] if isinstance(p, list) and len(p) == 4 and all(type(n) in (int, float) for n in p)]
        result.append(ShotLayout(int(start), int(end), item['layout'], focus_path=focus, people=people,
            **{key: box(key) for key in boxes if box(key) is not None}))
    return result


def write_tracking(run, tracking):
    """Focus paths live beside the project, never in it: UI saves rebuild scenes
    field by field, and an untouched crop is the only thing that re-arms tracking."""
    try:
        with open(Path(run) / 'editor-tracking.json', 'w', encoding='utf8') as handle:
            json.dump(tracking, handle, separators=(',', ':'))
    except OSError:
        pass  # Tracking is an enhancement; a static crop always renders.


def _tracking_store(run):
    try:
        with open(Path(run) / 'editor-tracking.json', encoding='utf8') as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def read_tracking(run, candidate_id):
    entries = _tracking_store(run).get(candidate_id)
    return entries if isinstance(entries, list) else []


def project_keywords(run):
    """The source brief's vocabulary plus the user's Brand Vocabulary (env), for
    keyword highlights that stay consistent across every project's transcript."""
    terms: list[str] = []
    try:
        record = read_json(Path(run), 'source_context.json')
        vocabulary = (record.get('brief') or {}).get('vocabulary') or []
        terms = [str(t).strip().lower() for t in vocabulary if str(t).strip()]
    except (ValueError, KeyError, OSError):
        pass  # No brief: the Brand Vocabulary alone still highlights.
    try:
        brand = json.loads(os.environ.get('BRIDGECLIP_KEYTERMS', '[]'))
    except ValueError:
        brand = []
    if isinstance(brand, list):
        seen = set(terms)
        for term in brand:
            if not isinstance(term, str):
                continue
            text = term.strip().lower()
            if text and text not in seen:
                seen.add(text)
                terms.append(text)
    return terms[:60]


async def prepare_project(request, segments, transcript, download, renderer, reviewer, output_dir, progress):
    if not segments:
        raise NoClipCandidatesError()
    if getattr(request, 'aspect_ratio', '9:16') not in ('9:16', '16:9', '1:1'):
        raise ValueError('The manual editor renders 9:16, 16:9 or 1:1 only')
    w, h = await renderer._get_video_dimensions(download.video_path)
    duration = round(download.metadata.duration_seconds * 1000)
    aspect = {'9:16': 9 / 16, '16:9': 16 / 9, '1:1': 1.0}.get(request.aspect_ratio, 9 / 16)
    project = {'version': 1, 'revision': 0, 'title': utf16_prefix(download.metadata.title or '', 1024), 'width': w, 'height': h,
        'duration_ms': duration, 'aspect_ratio': request.aspect_ratio, 'candidates': [],
        'transcript': [{'start_ms': max(0, min(duration, s.start_time_ms)), 'end_ms': max(0, min(duration, s.end_time_ms)),
                        'text': utf16_prefix(s.text, 20000),
                        **({'speaker': utf16_prefix(str(s.speaker_label), 16)} if getattr(s, 'speaker_label', '') else {})} for s in transcript]}
    keywords = project_keywords(output_dir)
    if keywords:
        project['keywords'] = keywords
    loop = asyncio.get_running_loop()
    from .run_diagnostics import CURRENT
    diagnostics = CURRENT.get()
    import threading
    progress_thread = threading.get_ident()
    total = min(100, len(segments))
    candidate_tracking = {}
    for i, segment in enumerate(segments[:100]):
        progress(f'Analyzing framing for candidate {i + 1} of {total}…', 100 * i / total)
        a, b = max(0, segment.start_time_ms), min(duration, segment.end_time_ms)
        if b - a < 100:
            continue
        if diagnostics:
            diagnostics.candidate(i + 1, total, b - a)
        def layout_progress(detail, percent):
            if diagnostics:
                phase = {'Sampling faces': 'sampling', 'Scanning camera changes': 'camera_scan',
                         'Refining face tracking': 'face_tracking', 'Checking shot layouts': 'vision'}.get(detail, 'sampling')
                diagnostics.phase(phase, percent)
            progress(f'Candidate {i + 1} of {total}: {detail}', 100 * i / total)
        def report_layout(detail, percent):
            if threading.get_ident() == progress_thread:
                layout_progress(detail, percent)
            else:
                loop.call_soon_threadsafe(layout_progress, detail, percent)
        plan = None
        scenes = [{'at_ms': 0, 'layout': 'fit' if request.layout_style == 'fit' else 'fill', 'crops': [default_crop(w, h, aspect)]}]
        tracking, framing = [], None
        # Suggested shot layouts stay editable; no pacing cuts or captions are baked.
        if request.aspect_ratio == '9:16' and request.layout_style != 'fit':
            try:
                plan = await renderer.layout_analyzer.analyze(download.video_path, a, b - a, w, h, request.layout_style,
                    progress=report_layout)
                scenes, tracking = scenes_from_plan(plan.shots, a, w, h, aspect)
                framing = 'tracked'
                if not scenes:
                    scenes = [{'at_ms': 0, 'layout': 'fill', 'crops': [default_crop(w, h, aspect)]}]
                    tracking, framing = [], 'centered'
            except asyncio.CancelledError:
                raise
            except Exception:
                framing = 'centered'  # Centered framing is editable if detection isn't available.
        c = {'id': f'candidate-{i + 1}', 'title': utf16_prefix(segment.summary or f'Clip {i + 1}', 200),
            'ranges': [[a, b]], 'scenes': scenes, 'score': max(0, min(100, segment.virality_score)),
            'requires_visual_context': bool((getattr(segment, 'moment', None) or {}).get('requires_visual_context')),
            'reason': utf16_prefix(getattr(segment, 'reasoning', '') or '', 4000), 'captions': request.include_captions,
            'caption_preset': request.caption_preset, 'video_speed': request.video_speed, 'exports': [], 'review': None,
            'status': 'refining', 'caption_edits': [], 'caption_suppression_ranges': [],
            **({'framing': framing} if framing else {})}
        if tracking:
            candidate_tracking[c['id']] = tracking
        if plan is not None and getattr(plan, 'camera_scan', None):
            c['camera_scan'] = plan.camera_scan
            c['dismissed_camera_markers'] = []
        if diagnostics:
            diagnostics.phase('jev')
        progress(f'Reviewing candidate {i + 1} of {total} with Jev…', 100 * i / total)
        await review_candidate(c, reviewer)
        project['candidates'].append(c)
        if diagnostics:
            diagnostics.phase(None)
    if not project['candidates']:
        raise NoClipCandidatesError()
    write_tracking(output_dir, candidate_tracking)
    progress('Saving source video…', 0, 'saving')
    destination = os.path.join(output_dir, 'editor-source.mp4')
    def move_download():
        # A download in the pipeline's temporary folder is discarded after this
        # run: rename it on the same volume instead of storing a second copy.
        if getattr(download, 'source_type', 'local') == 'local':
            return False
        try:
            if os.stat(download.video_path).st_dev != os.stat(output_dir).st_dev:
                return False
            os.rename(download.video_path, destination)
        except OSError:
            return False
        return True
    # Local inputs are copied: a real copy isolates the project from later
    # changes to (or removal of) the original file.
    def copy_source():
        size, copied = os.path.getsize(download.video_path), 0
        with open(download.video_path, 'rb') as source, open(destination, 'wb') as target:
            while chunk := source.read(8 * 1024 * 1024):
                target.write(chunk)
                copied += len(chunk)
                percent = 100 * copied / max(1, size)
                loop.call_soon_threadsafe(progress, f'Saving source video: {percent:.0f}%', percent, 'saving')
    if not await asyncio.to_thread(move_download):
        await asyncio.to_thread(copy_source)
    os.chmod(destination, 0o600)
    loop = asyncio.get_running_loop()
    await renderer.capture_framing_source(destination, os.path.join(output_dir, 'editor-preview.mp4'),
        progress=lambda percent: loop.call_soon_threadsafe(progress, 'Preparing editor preview…', percent, 'preview'),
        duration_ms=duration)
    project['frame_preview'] = True
    atomic_json(Path(output_dir) / 'editor-project.json', project)
    return project


def default_scenes(w, h, aspect_ratio):
    """A whole-frame starting layout for an imported clip; the user reframes from here."""
    if aspect_ratio == '16:9':
        return [{'at_ms': 0, 'layout': 'fit', 'crops': [default_crop(w, h, 16 / 9)]}]
    return [{'at_ms': 0, 'layout': 'fill', 'crops': [default_crop(w, h, 9 / 16)]}]


# The fast per-reel import pads the focused clip's window so the editor's
# default "clip" timeline zoom (±10 s) still has frames to scrub.
SEGMENT_PREVIEW_PAD_MS = 10_000


def transcript_row(segment, duration):
    """One editor transcript line, clamped to the source, with word timings when
    present so the editor can cut by text. Malformed words are skipped, capped
    at 400 per line."""
    row = {'start_ms': max(0, min(duration, int(round(segment['start_time_ms'])))),
        'end_ms': max(0, min(duration, int(round(segment['end_time_ms'])))),
        'text': utf16_prefix(segment.get('text', ''), 20000)}
    if segment.get('speaker_label'):
        row['speaker'] = utf16_prefix(str(segment['speaker_label']), 16)
    words = []
    for w in (segment.get('words') or [])[:400]:
        if type(w.get('start_time_ms')) not in (int, float) or type(w.get('end_time_ms')) not in (int, float):
            continue
        a = max(0, min(duration, int(round(w['start_time_ms']))))
        b = max(0, min(duration, int(round(w['end_time_ms']))))
        if b < a:
            continue
        words.append({'start_ms': a, 'end_ms': b, 'text': utf16_prefix(str(w.get('word', '')), 64)})
    if words:
        row['words'] = words
    return row


async def create_project(run, config, progress):
    """Reconnect an automatic run's original video and rebuild it as an editable project.

    Automatic runs render clips and keep their download in the Library's source cache,
    and an imported run keeps the whole original, so this normally restores the material
    from disk; only a run whose video was never kept, and is not in the Library anywhere,
    re-fetches it. It writes the same three artifacts a review run produces
    (editor-source.mp4, editor-preview.mp4, editor-project.json) and marks each finished
    clip as already baked, so "Edit this clip" focuses its candidate.

    With `focus_clip` (a clip index) the preview covers only that reel's window plus
    padding — minutes of full-source transcoding become seconds. The window is recorded
    as preview_start_ms/preview_end_ms; "build-preview" or a camera scan replaces it
    with a full-source preview later.
    """
    def report(phase, percent, **extra):
        if progress:
            progress({'phase': phase, 'percent': max(0, min(100, int(percent))), **extra})
    if (run / 'editor-project.json').exists() or (run / 'editor-project.json').is_symlink():
        raise EditorError('invalid', 'This run already has an editor project')
    output = read_json(run, 'job_output.json')
    if output.get('editor_project'):
        raise EditorError('invalid', 'This run already has an editor project')
    clips = [c for c in output.get('clips') or [] if type(c.get('clip_index')) is int]
    if not clips:
        raise EditorError('invalid', 'This run has no clips to edit')
    destination = run / 'editor-source.mp4'
    source = config.get('source') or {}
    kind = source.get('kind')
    if kind == 'url':
        if destination.is_symlink():
            raise EditorError('invalid', 'The editor source is not a regular file')
        library = config.get('library')
        # The bytes are usually already here: this run's own finished import, or the
        # copy the job that made these clips downloaded and used to throw away.
        if not await asyncio.to_thread(reuse_local_source, library, source.get('url'), destination, report):
            if not config.get('allow_download'):
                # Nothing local, and nobody agreed to a download. "Edit this" must not
                # quietly pull gigabytes; main asks the user and asks again with consent.
                raise EditorError('source_missing', 'The original video is not in the Library')
            from clip_engine.services.video_downloader import VideoDownloaderService
            downloader = VideoDownloaderService()
            last = {'at': None, 'bytes': 0}

            def download_progress(detail, percent, downloaded=None, total=None):
                # Bytes and rate feed the import waiting screen's progress bar.
                extra = {}
                now = time.monotonic()
                if downloaded is not None:
                    extra['downloaded_bytes'] = int(downloaded)
                    if last['at'] is not None and downloaded >= last['bytes'] and now - last['at'] > .02:
                        extra['speed'] = int((downloaded - last['bytes']) / (now - last['at']))
                    last.update(at=now, bytes=downloaded)
                if total:
                    extra['total_bytes'] = int(total)
                report('scan', percent if percent is not None else 0, **extra)

            downloader.progress_callback = download_progress
            try:
                await downloader.download_video(url=source['url'], output_dir=str(run), output_filename='editor-source.mp4')
            except Exception as error:
                raise EditorError('source_missing', 'Could not re-download the original video') from error
            if not destination.is_file():
                raise EditorError('source_missing', 'The original video download produced no file')
    elif kind == 'file':
        # Main already streamed the chosen video into editor-source.mp4 under the run lock.
        if not destination.is_file() or destination.is_symlink():
            raise EditorError('source_missing', 'Reconnect the original video first')
    else:
        raise EditorError('invalid', 'Invalid editor import request')
    os.chmod(destination, 0o600)
    with failure_code('render_failed'):
        info = await asyncio.to_thread(source_info, str(destination))
    w, h, duration = info['width'], info['height'], max(1, int(round(info['duration'])))
    metrics = output.get('metrics') or {}
    requested = metrics.get('requested_settings') if isinstance(metrics.get('requested_settings'), dict) else {}
    if requested.get('aspect_ratio') in ('9:16', '16:9', '1:1'):
        aspect_ratio = requested['aspect_ratio']
    else:
        aspect_ratio = '9:16' if h > w else '16:9'
    captions = metrics.get('captions_status') == 'enabled'
    video_speed = requested.get('video_speed') if type(requested.get('video_speed')) in (int, float) and 1 <= requested['video_speed'] <= 2 else 1
    rows = []
    try:
        rows = read_json(run, 'transcript.json').get('segments') or []
    except (ValueError, KeyError):
        pass  # A no-speech run still edits its framing and cuts.
    transcript = [transcript_row(s, duration) for s in rows
                  if type(s.get('start_time_ms')) in (int, float) and type(s.get('end_time_ms')) in (int, float)]
    candidates = []
    # A finished smart job already persisted its framing shots; rebuilding the
    # scenes from them imports the reel with the same speaker tracking the
    # rendered clip has, with no second analysis pass.
    layouts = {}
    for entry in metrics.get('clip_layouts') or []:
        if isinstance(entry, dict) and type(entry.get('clip_index')) is int:
            layouts[entry['clip_index']] = entry
    reuse_layouts = aspect_ratio == '9:16' and requested.get('layout_style') != 'fit'
    candidate_tracking = {}
    for clip in clips:
        a = max(0, min(duration, int(round(clip.get('start_time_ms') or 0))))
        b = max(0, min(duration, int(round(clip.get('end_time_ms') or 0))))
        if b - a < 100:
            continue
        score = clip.get('virality_score')
        scenes, tracking, framing = default_scenes(w, h, aspect_ratio), [], None
        entry = layouts.get(clip['clip_index']) if reuse_layouts else None
        base = entry.get('window_start_ms') if entry else None
        if type(base) in (int, float) and 0 <= base <= duration and entry.get('source_width') == w and entry.get('source_height') == h:
            shots = shots_from_summary(entry.get('shots') or [])
            if shots:
                built, tracking = scenes_from_plan(shots, int(base), w, h, 9 / 16)
                # A scene list the editor validators would reject must never
                # replace the safe centered default.
                if built and built[0]['at_ms'] == 0 and built[-1]['at_ms'] < duration and all(
                        built[i]['at_ms'] < built[i + 1]['at_ms'] for i in range(len(built) - 1)):
                    scenes, framing = built, 'tracked'
                else:
                    tracking = []
        if framing is None and reuse_layouts:
            framing = 'centered'  # No persisted plan (older job): the crop starts centered.
        if tracking:
            candidate_tracking[f'candidate-{clip["clip_index"] + 1}'] = tracking
        candidates.append({'id': f'candidate-{clip["clip_index"] + 1}',
            'title': utf16_prefix(clip.get('summary') or f"Clip {clip['clip_index'] + 1}", 200),
            'ranges': [[a, b]], 'scenes': scenes, 'score': max(0, min(100, float(score) * 10)) if type(score) in (int, float) else 0,
            'requires_visual_context': False, 'reason': '', 'captions': captions, 'caption_preset': 'pop',
            'video_speed': video_speed, 'exports': [clip['clip_index']], 'review': None, 'status': 'baked',
            'caption_edits': [], 'caption_suppression_ranges': [], **({'framing': framing} if framing else {})})
    if not candidates:
        raise EditorError('invalid', 'No clip in this run is long enough to edit')
    write_tracking(run, candidate_tracking)
    project = {'version': 1, 'revision': 0, 'title': utf16_prefix(output.get('source_video_title') or 'Untitled video', 1024),
        'width': w, 'height': h, 'duration_ms': duration, 'aspect_ratio': aspect_ratio, 'candidates': candidates, 'transcript': transcript}
    keywords = project_keywords(run)
    if keywords:
        project['keywords'] = keywords
    # "Edit this" imports transcode only the focused reel's window (+ padding),
    # so editing one reel of a long show does not wait on a full-source preview.
    preview_start, preview_end = 0, duration
    focus_clip = config.get('focus_clip')
    if type(focus_clip) is int and 0 <= focus_clip <= 999:
        focused = next((c for c in candidates if focus_clip in c['exports']), None)
        if focused:
            preview_start = max(0, focused['ranges'][0][0] - SEGMENT_PREVIEW_PAD_MS)
            preview_end = min(duration, focused['ranges'][-1][1] + SEGMENT_PREVIEW_PAD_MS)
            if preview_end - preview_start >= duration - 500:
                preview_start, preview_end = 0, duration
    renderer = RenderingService()
    preview = run / 'editor-preview.mp4'
    if preview.is_symlink():
        raise EditorError('invalid', 'The editor preview is not a regular file')
    if preview.is_file():
        # An interrupted import can leave a truncated final preview. Never trust it: ffprobe the
        # intended length and delete anything incomplete before rebuilding.
        with failure_code('render_failed'):
            if not await asyncio.to_thread(preview_duration_ok, str(preview), preview_end - preview_start):
                preview.unlink()
    if preview_start > 0 or preview_end < duration:
        with failure_code('render_failed'):
            await renderer.capture_framing_source(str(destination), str(preview),
                progress=lambda percent: report('preview', percent), duration_ms=duration,
                start_ms=preview_start, end_ms=preview_end)
        project['preview_start_ms'], project['preview_end_ms'] = preview_start, preview_end
    else:
        with failure_code('render_failed'):
            await renderer.capture_framing_source(str(destination), str(preview),
                progress=lambda percent: report('preview', percent), duration_ms=duration)
        project['frame_preview'] = True
    # Commit the manifest flag last: an interrupted import leaves no half-open project.
    atomic_json(run / 'editor-project.json', project)
    output['editor_project'] = True
    atomic_json(run / 'job_output.json', output)


AUDIO_MAX_BYTES = 120 * 1024 * 1024
AUDIO_MAX_SECONDS = 60 * 60
AUDIO_STAGED = re.compile(r'editor-asset-[a-f0-9]{32}\.[a-z0-9]{2,4}')


def audio_duration(path):
    """Length in seconds of a file's audio; refuses files without a usable track."""
    try:
        result = run_media(['ffprobe', '-v', 'error', *MEDIA_INPUT_OPTIONS, '-show_streams', '-show_format',
                            '-of', 'json', str(path)], timeout=PROBE_TIMEOUT_SECONDS, check=True)
        data = json.loads(result.stdout)
        streams = [s for s in data.get('streams') or [] if s.get('codec_type') == 'audio']
        if not streams:
            raise ValueError('The file has no audio track')
        duration = next((float(s['duration']) for s in streams if s.get('duration')), None)
        if duration is None:
            duration = float((data.get('format') or {}).get('duration') or 0)
        if not math.isfinite(duration) or duration < .1 or duration > AUDIO_MAX_SECONDS:
            raise ValueError('The audio has no readable length or runs longer than an hour')
        return duration
    except Exception as error:
        raise EditorError('invalid', 'That file has no usable audio track') from error


def transcode_audio(source, destination):
    """Normalize any audio or video input to stereo AAC; the only format the editor bakes."""
    run_media(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', str(source), '-vn', '-ac', '2', '-ar', '48000',
               '-c:a', 'aac', '-b:a', '160k', str(destination)], timeout=15 * 60, check=True)
    if destination.stat().st_size > AUDIO_MAX_BYTES:
        raise EditorError('invalid', 'The extracted audio track is too large')


def _remove_audio_partials(run, token):
    for path in run.glob(f'.editor-audio-{token}.*'):
        try:
            path.unlink()
        except OSError:
            pass


def download_audio(url, run, report):
    """Download a link's audio-only stream through the same guarded stack as source imports.

    Returns (path, title, leftovers): the downloaded file, a cleaned title for the
    library, and the temporary files the caller must remove afterwards.
    """
    import random
    import yt_dlp
    from clip_engine.network_policy import guarded_public_connections
    from clip_engine.services.media_process import guarded_ytdlp_children
    from clip_engine.services.video_downloader import UA_LIST
    deadline = time.monotonic() + 30 * 60
    token = uuid4().hex
    target = run / f'.editor-audio-{token}'

    def hook(item):
        if time.monotonic() > deadline:
            raise EditorError('source_missing', 'The audio download took too long')
        if item.get('status') != 'downloading':
            return
        total = int(item.get('total_bytes') or item.get('total_bytes_estimate') or 0)
        downloaded = int(item.get('downloaded_bytes') or 0)
        if total > AUDIO_MAX_BYTES or downloaded > AUDIO_MAX_BYTES:
            raise EditorError('invalid', 'The audio at this link is too large')
        if total and downloaded:
            report({'phase': 'audio', 'percent': min(99, downloaded / total * 100),
                    'downloaded_bytes': downloaded, 'total_bytes': total})

    opts = {'format': 'bestaudio/best', 'quiet': True, 'noprogress': True, 'no_warnings': True, 'noplaylist': True,
            'socket_timeout': 30, 'retries': 5, 'fragment_retries': 5, 'outtmpl': f'{target}.%(ext)s',
            'progress_hooks': [hook], 'proxy': '', 'external_downloader': 'native', 'hls_prefer_native': True,
            'http_headers': {'User-Agent': random.choice(UA_LIST), 'Accept-Language': 'en-US,en;q=0.9',
                             'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.8,*/*;q=0.7'}}
    try:
        with guarded_ytdlp_children(deadline), guarded_public_connections():
            with yt_dlp.YoutubeDL(opts) as loader:
                info = loader.extract_info(url, download=False)
        duration = float((info or {}).get('duration') or 0)
        if not math.isfinite(duration) or duration < .1 or duration > AUDIO_MAX_SECONDS:
            raise EditorError('invalid', 'This link has no usable audio, or it runs longer than an hour')
        title = ' '.join(str((info or {}).get('title') or '').split())[:120]
        with guarded_ytdlp_children(deadline), guarded_public_connections():
            with yt_dlp.YoutubeDL(opts) as loader:
                loader.download([url])
    except EditorError:
        _remove_audio_partials(run, token)
        raise
    except Exception as error:
        _remove_audio_partials(run, token)
        raise EditorError('source_missing', 'The link could not be downloaded as audio') from error
    files = [path for path in run.glob(f'.editor-audio-{token}.*') if path.is_file()]
    if not files:
        raise EditorError('source_missing', 'The audio download produced no file')
    return files[0], title or 'Imported audio', files


async def import_audio(run, config, progress):
    """Import a music track from a link or from a file main staged inside the run.

    The track lands as `editor-asset-<id>.m4a` — exactly the shape of an uploaded
    asset — so validation, bake and the sweep treat it like any other upload. Main
    mirrors the file into the cross-project audio library; this side never leaves
    the run folder and never touches the project JSON.
    """
    def report(value):
        if progress:
            progress(value)
    source = config.get('source') or {}
    kind = source.get('kind')
    report({'phase': 'audio', 'percent': 0})
    leftovers: list[Path] = []
    if kind == 'url':
        url = source.get('url')
        if not isinstance(url, str) or not url.startswith(('https://', 'http://')) or len(url) > 2048:
            raise EditorError('invalid', 'Paste a valid audio or video link')
        downloaded, title, leftovers = await asyncio.to_thread(download_audio, url, run, report)
    elif kind == 'file':
        name = source.get('name')
        if not isinstance(name, str) or AUDIO_STAGED.fullmatch(name) is None:
            raise EditorError('invalid', 'Invalid audio import request')
        downloaded = local_file(run, name)
        title = ' '.join(str(config.get('title') or '').split())[:120] or 'Imported audio'
    else:
        raise EditorError('invalid', 'Invalid audio import request')
    duration = await asyncio.to_thread(audio_duration, downloaded)
    asset = f'editor-asset-{uuid4().hex}.m4a'
    destination = run / asset
    try:
        with failure_code('render_failed'):
            await asyncio.to_thread(transcode_audio, downloaded, destination)
        os.chmod(destination, 0o600)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    finally:
        for leftover in leftovers:
            try:
                leftover.unlink()
            except OSError:
                pass
    return {'asset': asset[len('editor-asset-'):], 'title': title, 'duration_ms': max(100, int(round(duration * 1000)))}


VOICE_SCRIPT_MAX = 5000
VOICE_PRON_MAX = 20


def _voice_pronunciations(script, pronunciations):
    """Apply custom pronunciations as literal say-instead-of-word replacements, longest first."""
    import re as _re
    for item in pronunciations:
        word, say = item['word'], item['say']
        script = _re.sub(_re.escape(word), say, script, flags=_re.IGNORECASE)
    return script


def voice_sapi_rate(rate):
    """0.5x–2x onto SAPI's -10..10 rate scale (1x = 0)."""
    clamped = min(2.0, max(0.5, float(rate) if type(rate) in (int, float) else 1.0))
    return int(round((clamped - 1) * 10))


def _run_powershell(command, timeout):
    import subprocess
    result = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', command],
                            capture_output=True, timeout=timeout)
    if result.returncode != 0:
        raise EditorError('render_failed', 'The Windows voice engine failed. Check that at least one voice is installed.')
    return result


async def voice_voices():
    """The installed Windows voices, for the studio's actor picker."""
    import json as _json
    ps = ("Add-Type -AssemblyName System.Speech; "
          "$v = (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | "
          "ForEach-Object { $_.VoiceInfo.Name }; $v | ConvertTo-Json -Compress")
    result = await asyncio.to_thread(_run_powershell, ps, 60)
    try:
        voices = _json.loads(result.stdout.decode('utf-8', errors='replace') or '[]')
    except ValueError:
        voices = []
    if isinstance(voices, str):
        voices = [voices]
    return {'voices': [str(name) for name in voices][:40]}


async def voice_preview(run, config, progress=None):
    """Synthesize a scratch voiceover to `editor-asset-<id>.wav` with Windows SAPI.

    The script (with pronunciations applied) goes through a UTF-8 temp file so
    no quoting can break or inject into the PowerShell command.
    """
    def report(value):
        if progress:
            progress(value)
    if os.name != 'nt':
        raise EditorError('invalid', 'Voice preview needs Windows.')
    script = ' '.join(str(config.get('script') or '').split())
    if not (10 <= len(script) <= VOICE_SCRIPT_MAX):
        raise EditorError('invalid', 'Write a voiceover script between 10 and 5000 characters.')
    pronunciations = config.get('pronunciations') or []
    if not isinstance(pronunciations, list) or len(pronunciations) > VOICE_PRON_MAX:
        raise EditorError('invalid', 'Too many pronunciations')
    cleaned = []
    for item in pronunciations:
        if not isinstance(item, dict):
            raise EditorError('invalid', 'Invalid pronunciation')
        word = ' '.join(str(item.get('word') or '').split())[:40]
        say = ' '.join(str(item.get('say') or '').split())[:120]
        if not word or not say:
            raise EditorError('invalid', 'A pronunciation needs a word and a say-as')
        cleaned.append({'word': word, 'say': say})
    script = _voice_pronunciations(script, cleaned)
    voice = str(config.get('voice') or '')[:80]
    if not re.fullmatch(r"[A-Za-z0-9() .,'\-]{0,80}", voice):
        voice = ''
    sapi_rate = voice_sapi_rate(config.get('rate'))
    report({'phase': 'motion', 'percent': 10})
    script_path = run / f'.editor-voice-{uuid4().hex}.txt'
    script_path.write_text(script, encoding='utf-8-sig')
    out = run / f'editor-asset-{uuid4().hex}.wav'
    ps = ("Add-Type -AssemblyName System.Speech; "
          "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
          f"$s.SetOutputToWaveFile('{str(out)}'); "
          + (f"$s.SelectVoice('{voice}'); " if voice else "")
          + f"$s.Rate = {sapi_rate}; "
          f"$s.Speak((Get-Content -Raw -Encoding UTF8 '{str(script_path)}')); $s.Dispose()")
    try:
        report({'phase': 'motion', 'percent': 30})
        with failure_code('render_failed'):
            await asyncio.to_thread(_run_powershell, ps, 180)
        if not out.is_file() or out.stat().st_size < 1000:
            raise EditorError('render_failed', 'The voice preview produced no audio')
        os.chmod(out, 0o600)
        with failure_code('render_failed'):
            duration = await asyncio.to_thread(audio_duration, out)
    finally:
        script_path.unlink(missing_ok=True)
    report({'phase': 'motion', 'percent': 100})
    return {'asset': out.name[len('editor-asset-'):], 'duration_ms': max(100, int(round(duration * 1000)))}


MOTION_MAX_SHOTS = 8
MOTION_MIN_SHOT_MS, MOTION_MAX_SHOT_MS, MOTION_TOTAL_MS = 500, 8000, 20000
MOTION_MOTIONS = ('none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right')
MOTION_IMAGE_EXTS = frozenset({'png', 'jpg', 'jpeg', 'webp'})
MOTION_VIDEO_EXTS = frozenset({'mp4', 'm4v', 'mov', 'webm'})
MOTION_FADE_S = 0.4


def _motion_plan(run, config):
    """Validate the shot plan against the same caps as src/shared parseMotionPlan,
    and resolve every referenced asset inside the run."""
    plan = config.get('plan') or {}
    shots = plan.get('shots')
    if not isinstance(shots, list) or not 1 <= len(shots) <= MOTION_MAX_SHOTS:
        raise EditorError('invalid', 'The shot plan needs between 1 and 8 shots')
    cleaned, total = [], 0
    for shot in shots:
        if not isinstance(shot, dict) or shot.get('kind') not in ('still', 'video', 'title'):
            raise EditorError('invalid', 'Invalid motion shot')
        duration = shot.get('duration_ms')
        if type(duration) is not int or not MOTION_MIN_SHOT_MS <= duration <= MOTION_MAX_SHOT_MS:
            raise EditorError('invalid', 'Invalid motion shot length')
        total += duration
        if total > MOTION_TOTAL_MS:
            raise EditorError('invalid', 'The motion clip is longer than 20 seconds')
        motion = shot.get('motion')
        if motion not in MOTION_MOTIONS:
            raise EditorError('invalid', 'Invalid motion shot movement')
        if shot['kind'] == 'title':
            text = ' '.join(str(shot.get('text') or '').split())[:120]
            if not text:
                raise EditorError('invalid', 'A title shot has no text')
            cleaned.append({'kind': 'title', 'text': text, 'duration_ms': duration, 'motion': 'none'})
            continue
        ref = shot.get('asset')
        if not isinstance(ref, str) or ASSET_REF.fullmatch(ref) is None:
            raise EditorError('invalid', 'A shot references an invalid asset')
        ext = ref.rsplit('.', 1)[1].lower()
        expected = MOTION_IMAGE_EXTS if shot['kind'] == 'still' else MOTION_VIDEO_EXTS
        if ext not in expected:
            raise EditorError('invalid', 'A shot references the wrong kind of file')
        with failure_code('source_missing'):
            path = local_file(run, f'editor-asset-{ref}')
        cleaned.append({'kind': shot['kind'], 'path': str(path), 'duration_ms': duration,
                        'motion': motion if shot['kind'] == 'still' else 'none'})
    audio_asset = None
    if plan.get('audio') is True:
        ref = config.get('audio_asset')
        if not isinstance(ref, str) or ASSET_REF.fullmatch(ref) is None:
            raise EditorError('invalid', 'The music bed references an invalid asset')
        with failure_code('source_missing'):
            audio_asset = str(local_file(run, f'editor-asset-{ref}'))
    return cleaned, total, audio_asset


def _motion_title_ass(shots, w, h):
    """ASS content with centered fade-in titles over the concatenated (xfade-shortened) timeline."""
    font = max(18, round(h * .06))
    events = []
    start = 0.0

    def clock(seconds):
        cs = max(0, round(seconds * 100))
        return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"

    for shot in shots:
        duration = shot['duration_ms'] / 1000
        if shot['kind'] == 'title':
            text = ''.join(char for char in shot['text'] if char not in '{}\\')
            a = start + MOTION_FADE_S / 2
            b = start + duration - MOTION_FADE_S / 2
            if b > a:
                events.append(f"Dialogue: 0,{clock(a)},{clock(b)},Default,,0,0,0,,"
                              f"{{\\an5\\fad(200,200)}}{text}")
        start += duration - MOTION_FADE_S
    return (f"[Script Info]\nScriptType: v4.00+\nPlayResX: {w}\nPlayResY: {h}\n\n"
            "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
            "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, "
            "Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
            f"Style: Default,Arial,{font},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,5,40,40,40,1\n"
            "\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
            + '\n'.join(events) + '\n')


def _motion_branch(shot, index, w, h, fps):
    """One shot's normalized video branch, ending in [s{index}]."""
    duration = shot['duration_ms'] / 1000
    fit = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1"
    if shot['kind'] == 'title':
        return f"[{index}:v]format=yuv420p,trim=duration={duration:.3f},setpts=PTS-STARTPTS[s{index}]"
    if shot['kind'] == 'video':
        return f"[{index}:v]{fit},fps={fps},format=yuv420p,trim=duration={duration:.3f},setpts=PTS-STARTPTS[s{index}]"
    frames = max(1, round(duration * fps))
    center = "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
    motion = shot['motion']
    if motion == 'zoom-in':
        zoom = f"zoompan=z='min(1+{0.18 / frames:.6f}*on,1.18)':{center}:d=1:s={w}x{h}:fps={fps}"
    elif motion == 'zoom-out':
        zoom = f"zoompan=z='max(1.18-{0.18 / frames:.6f}*on,1.0)':{center}:d=1:s={w}x{h}:fps={fps}"
    elif motion == 'pan-left':
        zoom = f"zoompan=z='1.2':x='(iw-iw/zoom)*(1-on/{frames})':y='(ih-ih/zoom)/2':d=1:s={w}x{h}:fps={fps}"
    elif motion == 'pan-right':
        zoom = f"zoompan=z='1.2':x='(iw-iw/zoom)*(on/{frames})':y='(ih-ih/zoom)/2':d=1:s={w}x{h}:fps={fps}"
    else:
        zoom = f"zoompan=z='1.0':{center}:d=1:s={w}x{h}:fps={fps}"
    return f"[{index}:v]{fit},{zoom},format=yuv420p,trim=duration={duration:.3f},setpts=PTS-STARTPTS[s{index}]"


async def motion_render(run, config, progress=None):
    """Render a reviewed shot plan into `editor-asset-<id>.mp4` — the local Motion Studio generator.

    Stills get their Ken Burns move, reference videos are trimmed, title shots
    become a dark card with centered ASS text, shots join through crossfades,
    and the optional audio reference is trimmed and faded as the bed. The plan
    is small (≤ 8 shots, ≤ 20 s) so one bounded ffmpeg command renders it.
    """
    def report(value):
        if progress:
            progress(value)
    report({'phase': 'motion', 'percent': 4})
    shots, total_ms, audio_asset = _motion_plan(run, config)
    project = read_json(run, 'editor-project.json')
    w, h = (1080, 1920) if project.get('aspect_ratio') != '16:9' else (1920, 1080)
    fps = 30
    title_ass: Path | None = None
    asset = f'editor-asset-{uuid4().hex}.mp4'
    destination = run / asset
    try:
        report({'phase': 'motion', 'percent': 12})
        total_s = total_ms / 1000
        if any(shot['kind'] == 'title' for shot in shots):
            title_ass = run / f'.editor-motion-{uuid4().hex}.ass'
            title_ass.write_text(_motion_title_ass(shots, w, h), encoding='utf-8')
        cmd = ['ffmpeg', '-v', 'error', '-nostdin', '-y']
        index = 0
        for shot in shots:
            if shot['kind'] == 'title':
                cmd += ['-f', 'lavfi', '-i', f"color=c=0x14161C:s={w}x{h}:r={fps}:d={shot['duration_ms'] / 1000:.3f}"]
            else:
                is_still = shot['kind'] == 'still'
                cmd += (['-loop', '1', '-t', f"{shot['duration_ms'] / 1000:.3f}"] if is_still else []) + \
                       ['-protocol_whitelist', 'file,pipe,fd', '-i', shot['path']]
            index += 1
        graph = ';'.join(_motion_branch(shot, i, w, h, fps) for i, shot in enumerate(shots))
        if len(shots) > 1:
            offset, previous = 0.0, 's0'
            for i in range(1, len(shots)):
                offset += shots[i - 1]['duration_ms'] / 1000 - MOTION_FADE_S
                previous = f"x{i}"
                graph += f";[{'x' + str(i - 1) if i > 1 else 's0'}][s{i}]xfade=transition=fade:duration={MOTION_FADE_S:.3f}:offset={offset:.3f}[{previous}]"
        else:
            previous = 's0'
        if title_ass is not None:
            graph += f";[{previous}]ass='{title_ass.as_posix()}'[vtitle]"
            previous = 'vtitle'
        if audio_asset:
            cmd += ['-i', audio_asset]
            graph += f";[{previous}]null[vout];[{index}:a]atrim=duration={total_s:.3f},asetpts=PTS-STARTPTS,afade=t=out:st={max(0.0, total_s - 0.6):.3f}:d=0.6[aout]"
            cmd += ['-filter_complex', graph, '-map', '[vout]', '-map', '[aout]']
        else:
            cmd += ['-filter_complex', graph + f";[{previous}]null[vout]", '-map', '[vout]']
        report({'phase': 'motion', 'percent': 25})
        with failure_code('render_failed'):
            await asyncio.to_thread(run_media, [*cmd, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
                                               '-c:a', 'aac', '-movflags', '+faststart', str(destination)],
                                    timeout=15 * 60, check=True)
        if not destination.is_file() or destination.stat().st_size < 1000:
            raise EditorError('render_failed', 'The motion render produced no file')
        os.chmod(destination, 0o600)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    finally:
        if title_ass is not None:
            title_ass.unlink(missing_ok=True)
    report({'phase': 'motion', 'percent': 100})
    return {'asset': asset[len('editor-asset-'):], 'duration_ms': total_ms}


def atomic_json(path, value):
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf8', dir=path.parent, prefix='.editor-', suffix='.tmp', delete=False) as f:
            temp = f.name
            json.dump(value, f, ensure_ascii=False, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        if temp and os.path.exists(temp):
            os.unlink(temp)


def local_file(run, name):
    path = run / name
    if path.is_symlink() or not path.is_file() or path.resolve().parent != run:
        raise ValueError('Editor file is unavailable')
    return path


def read_json(run, name, limit=32 * 1024 * 1024):
    path = local_file(run, name)
    with path.open('rb') as f:
        data = f.read(limit + 1)
    if len(data) > limit:
        raise ValueError('Editor file is too large')
    return json.loads(data)


ASSET_REF = re.compile(r'[a-f0-9]{32}\.[a-z0-9]{2,4}')
OVERLAY_POSITIONS = ('top-left', 'top-right', 'bottom-left', 'bottom-right', 'center')


def _asset_ref(value):
    return isinstance(value, str) and ASSET_REF.fullmatch(value) is not None


def validate_candidate(c, duration, transcript_count=100000):
    """Mirror src/shared/clip-editor.ts parseCandidateEdit. Unknown UI-only fields
    (transcript `speaker`, project `speaker_names`/`keywords`) are ignored."""
    def number(n, lo, hi):
        return type(n) in (float, int) and math.isfinite(n) and lo <= n <= hi
    def time_interval(value):
        if not isinstance(value, (float, int)) or not math.isfinite(value) or not 0 <= value <= duration:
            raise ValueError('Invalid overlay interval')
        return value
    if not isinstance(c.get('title'), str) or not 1 <= len(c['title']) <= 200:
        raise ValueError('Invalid title')
    ranges = c['ranges']
    if not 1 <= len(ranges) <= 24:
        raise ValueError('Invalid cuts')
    previous = 0
    for a, b in ranges:
        if not number(a, previous, duration) or not number(b, a + 100, duration):
            raise ValueError('Invalid cut interval')
        previous = b
    if not 1 <= len(c['scenes']) <= 60 or c['scenes'][0]['at_ms'] != 0:
        raise ValueError('Invalid layouts')
    previous = -1
    for i, s in enumerate(c['scenes']):
        if not number(s['at_ms'], previous + .001, duration) or s['layout'] not in ('fill', 'split', 'fit'):
            raise ValueError('Invalid layout')
        previous = s['at_ms']
        transition = s.get('transition_ms', 0)
        if not number(transition, 0, 5000) or (transition and (transition < 100 or transition != int(transition)
                or i == 0 or s['layout'] == 'fit' or c['scenes'][i - 1]['layout'] != s['layout'])):
            raise ValueError('Invalid layout movement')
        # Absent is the existing crop easing; without movement the TS parser
        # drops the kind, so an inert value here must not reject the edit.
        if s.get('transition_kind') not in (None, 'motion', 'dissolve', 'wipe', 'crossfade', 'crosszoom', 'zoomin', 'zoomout', 'fadein', 'fadeout'):
            raise ValueError('Invalid layout transition kind')
        if len(s['crops']) != (2 if s['layout'] == 'split' else 1):
            raise ValueError('Invalid crops')
        for x, y, w, h in s['crops']:
            if not all(number(n, 0, 1) for n in (x, y, w, h)) or min(w, h) < .01 or x + w > 1.000001 or y + h > 1.000001:
                raise ValueError('Invalid crop')
    if not number(c['video_speed'], 1, 2) or type(c['captions']) is not bool:
        raise ValueError('Invalid export settings')
    # Range Effects: scoped visual edits over the footage.
    edits = c.get('range_edits')
    if edits is not None:
        if not isinstance(edits, list) or len(edits) > 8:
            raise ValueError('Invalid range edits')
        seen = set()
        for e in edits:
            if not isinstance(e, dict) or e.get('kind') not in ('warm', 'cool', 'cinematic', 'bw', 'sharpen', 'soften', 'blur'):
                raise ValueError('Invalid range edit')
            if not isinstance(e.get('id'), str) or re.fullmatch(r'[a-f0-9]{32}', e['id']) is None or e['id'] in seen:
                raise ValueError('Invalid range edit id')
            seen.add(e['id'])
            if not number(e.get('intensity'), .1, 1):
                raise ValueError('Invalid range edit intensity')
            start, end = time_interval(e.get('start_ms')), time_interval(e.get('end_ms'))
            if end - start < 100 or end - start > 300000:
                raise ValueError('Invalid range edit interval')
            if e['kind'] == 'blur':
                region = e.get('region')
                if region is not None and (
                        not isinstance(region, list) or len(region) != 4 or not all(number(v, 0, 1) for v in region)
                        or region[2] < .05 or region[3] < .05 or region[0] + region[2] > 1.000001 or region[1] + region[3] > 1.000001):
                    raise ValueError('Invalid blur region')
            elif e.get('region') is not None:
                raise ValueError('Invalid range edit region')
    # Speech Enhancement sliders: 0 = off, absent is off.
    for key in ('speech_denoise', 'speech_enhance'):
        if c.get(key) is not None and not number(c.get(key), 0, 1):
            raise ValueError('Invalid speech enhancement')
    # Auto Censor: a word list plus how captions/audio process the hits.
    censor = c.get('censor')
    if censor is not None:
        if not isinstance(censor, dict):
            raise ValueError('Invalid censor settings')
        words = censor.get('words')
        if (not isinstance(words, list) or not words or len(words) > 200 or any(
                not isinstance(w, str) or not w.strip() or len(w) > 40 for w in words)):
            raise ValueError('Invalid censor words')
        if censor.get('captions') not in ('asterisk', 'first', 'off') or censor.get('audio') not in ('mute', 'bleep', 'off'):
            raise ValueError('Invalid censor settings')
        if censor['captions'] == 'off' and censor['audio'] == 'off':
            raise ValueError('Invalid censor settings')
    if c.get('auto_reframe') is not None and not isinstance(c.get('auto_reframe'), bool):
        raise ValueError('Invalid auto reframe')
    if c.get('caption_y') is not None and not number(c['caption_y'], .1, .9):
        raise ValueError('Invalid caption position')
    if c.get('caption_x') is not None and not number(c['caption_x'], .1, .9):
        raise ValueError('Invalid caption position')
    # Caption style overrides: applying them onto a scratch style validates every value.
    if c.get('caption_style') is not None:
        from clip_engine.config import CaptionStyle, apply_caption_style_overrides
        apply_caption_style_overrides(CaptionStyle(), c['caption_style'])
    if c.get('status', 'refining') not in ('refining', 'ready', 'baked', 'discarded'):
        raise ValueError('Invalid clip status')
    suppressed = c.get('caption_suppression_ranges', [])
    if not isinstance(suppressed, list) or len(suppressed) > 200:
        raise ValueError('Invalid caption suppression ranges')
    previous = 0
    for interval in suppressed:
        if not isinstance(interval, list) or len(interval) != 2:
            raise ValueError('Invalid caption suppression range')
        a, b = interval
        if not number(a, previous, duration) or not number(b, a + 100, duration):
            raise ValueError('Invalid caption suppression range')
        previous = b
    edits = c.get('caption_edits', [])
    if not isinstance(edits, list) or len(edits) > 2000:
        raise ValueError('Invalid caption edits')
    seen = set()
    for edit in edits:
        if not isinstance(edit, dict):
            raise ValueError('Invalid caption edit')
        index, text = edit.get('segment'), edit.get('text')
        if type(index) is not int or not 0 <= index < transcript_count or index in seen or not isinstance(text, str) or len(text) > 2000:
            raise ValueError('Invalid caption edit')
        if any(ord(char) < 32 and char not in '\t\n\r' for char in text):
            raise ValueError('Invalid caption text')
        seen.add(index)
    # Bake overlays (src/shared/clip-editor.ts parseCandidateEdit).
    if c.get('logo') is not None:
        logo = c['logo']
        if not isinstance(logo, dict) or not _asset_ref(logo.get('asset')) or logo.get('position') not in OVERLAY_POSITIONS \
                or not number(logo.get('scale'), .05, .5) or not number(logo.get('opacity'), .1, 1):
            raise ValueError('Invalid logo')
    if c.get('intro_asset') is not None and not _asset_ref(c['intro_asset']):
        raise ValueError('Invalid intro')
    if c.get('outro_asset') is not None and not _asset_ref(c['outro_asset']):
        raise ValueError('Invalid outro')
    if c.get('music') is not None:
        music = c['music']
        if not isinstance(music, dict) or not _asset_ref(music.get('asset')) or not number(music.get('gain'), 0, 1):
            raise ValueError('Invalid music')
        for key in ('fade_in_ms', 'fade_out_ms'):
            if music.get(key) is not None and not number(music.get(key), 0, 5000):
                raise ValueError('Invalid music fade')
        if music.get('start_ms') is not None and not number(music.get('start_ms'), 0, 600000):
            raise ValueError('Invalid music start')
    brolls = c.get('brolls')
    if brolls is not None:
        if not isinstance(brolls, list) or len(brolls) > 24:
            raise ValueError('Invalid b-rolls')
        spans = []
        for b in brolls:
            if not isinstance(b, dict) or not _asset_ref(b.get('asset')):
                raise ValueError('Invalid b-roll')
            if b.get('layout') not in (None, 'fill', 'pip', 'split'):
                raise ValueError('Invalid b-roll layout')
            if b.get('swap') is not None and (b.get('layout') != 'split' or b.get('swap') is not True):
                raise ValueError('Invalid b-roll layout')
            start, end = time_interval(b.get('start_ms')), time_interval(b.get('end_ms'))
            if end - start < 100:
                raise ValueError('Invalid b-roll interval')
            spans.append((start, end))
        spans.sort()
        if any(spans[i][0] < spans[i - 1][1] for i in range(1, len(spans))):
            raise ValueError('Overlapping b-rolls')
    texts = c.get('text_overlays')
    if texts is not None:
        if not isinstance(texts, list) or len(texts) > 20:
            raise ValueError('Invalid text overlays')
        from clip_engine.services.rendering_service import LOWER_THIRD_IDS
        for item in texts:
            if not isinstance(item, dict) or item.get('position') not in OVERLAY_POSITIONS:
                raise ValueError('Invalid text overlay')
            start, end = time_interval(item.get('start_ms')), time_interval(item.get('end_ms'))
            if end - start < 100:
                raise ValueError('Invalid text overlay interval')
            text = item.get('text')
            # The TS parser clamps display text to 120 UTF-16 units instead of rejecting it.
            text = utf16_prefix(text, 120) if isinstance(text, str) else ''
            if not text.strip() or any(ord(char) < 32 and char != '\n' for char in text):
                raise ValueError('Invalid text overlay content')
            # Lower Third extras mirror src/shared/clip-editor.ts parseCandidateEdit.
            if item.get('preset') is not None:
                if item.get('preset') not in LOWER_THIRD_IDS:
                    raise ValueError('Invalid text overlay preset')
                if item.get('variant', 'solid') not in ('solid', 'color', 'image'):
                    raise ValueError('Invalid text overlay variant')
                color = item.get('color')
                if color is not None and (not isinstance(color, str) or re.fullmatch(r'#[0-9a-fA-F]{6}', color) is None):
                    raise ValueError('Invalid text overlay color')
                sub = item.get('sub')
                if sub is not None:
                    if not isinstance(sub, str):
                        raise ValueError('Invalid text overlay content')
                    sub = utf16_prefix(sub, 120)
                    if any(ord(char) < 32 and char != '\n' for char in sub):
                        raise ValueError('Invalid text overlay content')
                if item.get('image') is not None and not _asset_ref(item.get('image')):
                    raise ValueError('Invalid text overlay image')
    badges = c.get('cta_badges')
    if badges is not None:
        if not isinstance(badges, list) or len(badges) > 10:
            raise ValueError('Invalid CTA badges')
        for badge in badges:
            if not isinstance(badge, dict) or badge.get('kind') not in ('subscribe', 'follow') \
                    or badge.get('position') not in OVERLAY_POSITIONS:
                raise ValueError('Invalid CTA badge')
            start, end = badge.get('start_ms'), badge.get('end_ms')
            if (start is None) != (end is None):
                raise ValueError('Invalid CTA badge interval')
            if start is not None:
                start, end = time_interval(start), time_interval(end)
                if end - start < 100:
                    raise ValueError('Invalid CTA badge interval')
    if c.get('audio_gain') is not None and not number(c['audio_gain'], 0, 2):
        raise ValueError('Invalid audio gain')
    voiceover = c.get('voiceover')
    if voiceover is not None:
        if not isinstance(voiceover, dict) or not isinstance(voiceover.get('script'), str) or not voiceover['script'].strip():
            raise ValueError('Invalid voiceover')
        if not _asset_ref(voiceover.get('audio_asset')):
            raise ValueError('Invalid voiceover audio')
        if not number(voiceover.get('rate'), 0.5, 2) or not number(voiceover.get('gain', 1), 0, 2):
            raise ValueError('Invalid voiceover')
        if not isinstance(voiceover.get('voice'), str) or len(voiceover['voice']) > 80 or not isinstance(voiceover.get('pronunciations'), list) or len(voiceover['pronunciations']) > 20:
            raise ValueError('Invalid voiceover')
        for key, lo, hi in (('start_ms', 0, 600000), ('duration_ms', 100, 600000)):
            if voiceover.get(key) is not None and not number(voiceover.get(key), lo, hi):
                raise ValueError('Invalid voiceover timing')


def caption_transcript(transcript, edits):
    """A per-clip copy for rendering; original evidence and word timing stay intact.

    Corrections with the same word count retain the original word timestamps.
    Added/removed words are spread over the original line's spoken interval.
    """
    overrides = {edit['segment']: edit['text'] for edit in edits}
    result = []
    for index, segment in enumerate(transcript):
        if index not in overrides:
            result.append(replace(segment, words=[replace(w) for w in segment.words]))
            continue
        text = ' '.join(overrides[index].split())
        tokens = text.split()
        if not tokens:
            continue  # An empty correction hides this caption without cutting audio.
        if segment.words and len(tokens) == len(segment.words):
            words = [replace(word, word=text) for word, text in zip(segment.words, tokens)]
        else:
            start = segment.words[0].start_time_ms if segment.words else segment.start_time_ms
            end = segment.words[-1].end_time_ms if segment.words else segment.end_time_ms
            span = max(1, end - start)
            words = [TranscriptWord(word, round(start + i * span / len(tokens)), round(start + (i + 1) * span / len(tokens))) for i, word in enumerate(tokens)]
        result.append(replace(segment, text=text, words=words))
    return result


def scene_motion(c):
    """Resolve incoming crops before trimming the source window or skipping cuts."""
    previous = None
    origin = None
    for scene in c['scenes']:
        duration = scene.get('transition_ms', 0)
        if duration and previous and previous['layout'] == scene['layout'] and scene['layout'] != 'fit':
            p = min(1, (scene['at_ms'] - previous['at_ms']) / previous['transition_ms']) if previous.get('transition_ms') else 1
            ease = p * p * (3 - 2 * p)
            origin = [[a + (b - a) * ease for a, b in zip(start, end)] for start, end in zip(origin, previous['crops'])]
        else:
            origin = scene['crops']
        yield scene, origin
        previous = scene


def _focus_points(tracking, scene, start, end):
    """The scene's tracked focus path in shot-relative time, when the crop is
    still the analyzed one. Any crop edit changes the rect and overrides it."""
    for at_ms, crops, points in tracking or []:
        if at_ms == scene['at_ms'] and crops == scene['crops']:
            rel, last = [], -1
            for t, cx, cy in points:
                if not (isinstance(t, (int, float)) and isinstance(cx, (int, float)) and isinstance(cy, (int, float))):
                    continue
                r = max(0, min(end - start, t - start))
                if r > last:
                    rel.append((r, float(cx), float(cy)))
                    last = r
            return rel
    return []


def manual_plan(project, c, tracking=None):
    if c.get('auto_reframe') is False:
        tracking = None  # Auto Reframe off: the user's crops stand, no speaker follow
    a, b = c['ranges'][0][0], c['ranges'][-1][1]
    shots = []
    for i, (scene, origin) in enumerate(scene_motion(c)):
        start, end = max(a, scene['at_ms']), min(b, c['scenes'][i + 1]['at_ms'] if i + 1 < len(c['scenes']) else b)
        if start >= end:
            continue
        layout = {'split': LayoutType.TWO_SHOT, 'fit': LayoutType.SCREEN, 'fill': LayoutType.TALKING_HEAD}[scene['layout']]
        crops = [] if scene['layout'] == 'fit' else scene['crops']
        duration = scene.get('transition_ms', 0)
        kind = scene.get('transition_kind') if duration else None
        xfade_kinds = {'dissolve': 'fade', 'wipe': 'wipeleft', 'crossfade': 'fade', 'crosszoom': 'circleopen', 'zoomin': 'zoomin', 'zoomout': 'circleclose', 'fadein': 'fadeblack', 'fadeout': 'fadewhite'}
        if kind in xfade_kinds:
            # xfade at the scene boundary instead of crop easing: the shot keeps
            # its full span, and build_layout_graph overlaps the two composed
            # pieces by transition_ms. Adjacent layouts (fill and split) both work;
            # a user cut landing on the boundary falls back to a hard cut.
            shots.append(ShotLayout(start - a, end - a, layout, source='manual', manual_crops=crops,
                manual_from_crops=origin, manual_xfade_ms=duration,
                manual_xfade_kind=xfade_kinds[kind]))
            continue
        motion_end = min(end, scene['at_ms'] + duration)
        if duration and start < motion_end:
            shots.append(ShotLayout(start - a, motion_end - a, layout, source='manual', manual_crops=crops,
                manual_from_crops=origin, manual_transition_start_ms=scene['at_ms'] - a, manual_transition_ms=duration))
            start = motion_end
        if start < end:
            path = _focus_points(tracking, scene, start, end) if scene['layout'] == 'fill' else []
            shots.append(ShotLayout(start - a, end - a, layout, source='manual', manual_crops=crops, manual_focus_path=path))
    return ClipLayoutPlan(shots, project['width'], project['height'])


async def run_editor(config, progress=None):
    from clip_engine.config import get_settings
    from clip_engine.services.editorial_vision import EditorialVision
    settings = get_settings()
    raw_run = Path(config['run'])
    run = raw_run.resolve(strict=True)
    if raw_run.is_symlink() or ('library' in config and run.parent != Path(config['library']).resolve(strict=True)):
        raise ValueError('Editor project is outside the library')
    if config['action'] == 'create-project':
        await create_project(run, config, progress)
        return
    if config['action'] == 'import-audio':
        # Adds an asset file only; no project read, no revision bump, no candidate.
        return await import_audio(run, config, progress)
    if config['action'] == 'voice-voices':
        return await voice_voices()
    if config['action'] == 'voice-preview':
        # Generates a scratch voiceover into a run asset; the project is untouched.
        return await voice_preview(run, config, progress)
    if config['action'] == 'motion-render':
        # Renders a Motion Studio shot plan into a new asset file; the project
        # itself is untouched (the renderer attaches the result as a B-roll).
        return await motion_render(run, config, progress)
    project = read_json(run, 'editor-project.json')
    if project['version'] != 1 or project['revision'] != config['revision']:
        raise EditorError('project_changed', 'The editor project changed. Reopen it and retry.')
    if project.get('media_freed'):
        raise EditorError('source_missing', 'Editor media was freed')
    if config['action'] == 'replace-source':
        source_id = config['source_id']
        if not source_id or source_id == project.get('source_id'):
            raise ValueError('Invalid source generation')
        await replace_source(run, project, source_id)
        return
    if config['action'] == 'build-preview':
        # Replace a fast import's segment preview with a full-source one so the
        # editor can scrub anywhere. Same commit rules as the scan's lazy rebuild.
        def report(phase, percent):
            if progress:
                progress({'phase': phase, 'percent': percent})
        with failure_code('source_missing'):
            source = str(local_file(run, media_name('source', project.get('source_id'))))
        preview_id = config.get('preview_id') or uuid4().hex
        preview = run / media_name('preview', preview_id)
        try:
            with failure_code('render_failed'):
                await RenderingService().capture_framing_source(source, str(preview),
                    progress=lambda percent: report('preview', percent), duration_ms=project['duration_ms'])
            if read_json(run, 'editor-project.json')['revision'] != project['revision']:
                raise EditorError('project_changed', 'Editor project changed')
            project.update(preview_id=preview_id, frame_preview=True)
            project.pop('preview_start_ms', None)
            project.pop('preview_end_ms', None)
            project['revision'] += 1
            atomic_json(run / 'editor-project.json', project)
            preview = None
        finally:
            if preview is not None:
                preview.unlink(missing_ok=True)
        return
    c = next((c for c in project['candidates'] if c['id'] == config['candidate_id']), None)
    if c is None:
        raise EditorError('project_changed', 'Candidate is missing')
    with failure_code('invalid_edit'):
        validate_candidate(c, project['duration_ms'], len(project['transcript']))
    with failure_code('source_missing'):
        source = str(local_file(run, media_name('source', project.get('source_id'))))
    if config['action'] == 'scan-cameras':
        from clip_engine.services.camera_scan import scan_camera_changes
        def report(phase, percent):
            if progress:
                progress({'phase': phase, 'percent': percent})
        try:
            scan = await asyncio.to_thread(scan_camera_changes, source, c['ranges'][0][0], c['ranges'][-1][1],
                                           lambda percent: report('scan', percent))
        except ValueError as error:
            error.editor_code = 'scan_too_long' if 'too long' in str(error) else 'source_incompatible'
            raise
        preview = None
        try:
            # Upgrade old 30-fps proxies once. A new name avoids browser caching
            # and leaves an open preview untouched until the atomic commit.
            if not project.get('frame_preview'):
                preview_id = config.get('preview_id') or uuid4().hex
                preview = run / media_name('preview', preview_id)
                with failure_code('render_failed'):
                    await RenderingService().capture_framing_source(source, str(preview),
                        progress=lambda percent: report('preview', percent), duration_ms=project['duration_ms'])
                project.update(preview_id=preview_id, frame_preview=True)
                project.pop('preview_start_ms', None)  # The rebuilt preview covers the whole source.
                project.pop('preview_end_ms', None)
            if read_json(run, 'editor-project.json')['revision'] != project['revision']:
                raise EditorError('project_changed', 'Editor project changed')
            c['camera_scan'] = scan
            c['dismissed_camera_markers'] = [t for t in c.get('dismissed_camera_markers', [])
                                             if any(abs(t - m['at_ms']) < .01 for m in scan['markers'])]
            project['revision'] += 1
            if len(json.dumps(project).encode('utf8')) > 32 * 1024 * 1024:
                raise ValueError('Editor project is too large')
            atomic_json(run / 'editor-project.json', project)
            preview = None
        finally:
            if preview is not None:
                preview.unlink(missing_ok=True)
        return
    if config['action'] == 'auto-frame':
        if project.get('aspect_ratio') != '9:16':
            raise EditorError('invalid', 'Auto-frame needs a vertical project')
        renderer = RenderingService()
        if not renderer.layout_analyzer.available:
            raise EditorError('engine_unavailable', 'Face tracking is unavailable')
        def report(detail, percent):
            if progress:
                progress({'phase': 'scan', 'percent': percent})
        a, b = c['ranges'][0][0], c['ranges'][-1][1]
        w, h, aspect = project['width'], project['height'], 9 / 16
        with failure_code('source_incompatible'):
            subject = config.get('subject')
            if subject is not None:
                if not isinstance(subject, dict):
                    raise ValueError('Invalid subject hint')
                px, py = subject.get('x'), subject.get('y')
                if not isinstance(px, (int, float)) or not isinstance(py, (int, float)) or not math.isfinite(px) or not math.isfinite(py) or not 0 <= px <= 1 or not 0 <= py <= 1:
                    raise ValueError('Invalid subject hint')
            plan = await renderer.layout_analyzer.analyze(source, a, b - a, w, h, progress=report,
                                                         subject=subject)
        if plan is None:
            raise EditorError('engine_unavailable', 'Face tracking is unavailable')
        # Rebuilt layouts replace manual crops; cuts, captions and review are kept.
        scenes, tracking = scenes_from_plan(plan.shots, a, w, h, aspect, fill_only=True)
        c['scenes'] = scenes or [{'at_ms': 0, 'layout': 'fill', 'crops': [default_crop(w, h, aspect)]}]
        c['framing'] = 'tracked' if scenes else 'centered'
        if getattr(plan, 'camera_scan', None):
            c['camera_scan'] = plan.camera_scan
            c['dismissed_camera_markers'] = [t for t in c.get('dismissed_camera_markers', [])
                if any(abs(t - m['at_ms']) < .01 for m in plan.camera_scan['markers'])]
        if c.get('status') == 'baked':
            c['status'] = 'ready'  # The old bake used the previous layouts.
            c.pop('baked_hash', None)
        store = _tracking_store(run)
        if tracking:
            store[c['id']] = tracking
        else:
            store.pop(c['id'], None)
        if read_json(run, 'editor-project.json')['revision'] != project['revision']:
            raise EditorError('project_changed', 'Editor project changed')
        project['revision'] += 1
        if len(json.dumps(project).encode('utf8')) > 32 * 1024 * 1024:
            raise ValueError('Editor project is too large')
        atomic_json(run / 'editor-project.json', project)
        write_tracking(run, store)
        return
    with failure_code('invalid_edit'):
        rows = read_json(run, 'transcript.json')['segments']
        def timing(item):
            return {**item, 'start_time_ms': round(item['start_time_ms']), 'end_time_ms': round(item['end_time_ms'])}
        # UI-only annotations (a `speaker` label main may merge in) must not
        # break the bake: keep exactly the dataclass fields.
        segment_keys = {f.name for f in fields(TranscriptSegment)} - {'words'}
        word_keys = {f.name for f in fields(TranscriptWord)}
        transcript = [TranscriptSegment(**{k: v for k, v in timing(s).items() if k in segment_keys},
                       words=[TranscriptWord(**{k: v for k, v in timing(w).items() if k in word_keys}) for w in s.get('words', [])]) for s in rows]
    action = config['action']
    if action == 'review':
        with failure_code('review_unavailable'):
            reviewer = CoherenceReviewer(JevService.from_settings(settings, required=True), settings, transcript, project['duration_ms'])
            context = run / 'source_context.json'
            if context.exists():
                from clip_engine.services.source_context import context_for_prompt
                # Read the same bounded brief used in discovery; no new web research.
                reviewer.source_context = context_for_prompt(read_json(run, 'source_context.json'))
            with tempfile.TemporaryDirectory(prefix='.editor-review-', dir=run) as work:
                vision = EditorialVision(settings, source, work, project['duration_ms'])
                reviewer.visual_observer = vision.observe if settings.jev_visual_context else None
                await review_candidate(c, reviewer)
    elif action == 'export':
        if c.get('status', 'refining') != 'ready':
            raise EditorError('not_ready', 'Mark this clip ready before baking it')
        if any(edit['segment'] >= len(transcript) for edit in c.get('caption_edits', [])):
            raise EditorError('invalid_edit', 'Caption source changed')
        output = read_json(run, 'job_output.json')
        # job_output.json is committed before editor-project.json. If the worker
        # was killed in between, this exact edit (same revision) is already in
        # the library: finish that commit instead of rendering a duplicate.
        done = next((x for x in output['clips'] if x.get('editor_candidate') == c['id'] and x.get('editor_revision') == project['revision']
                     and x['clip_index'] not in c['exports'] and (run / f"clip_{x['clip_index']:02d}.mp4").is_file()), None)
        c['exports'].append(done['clip_index'] if done else await export_clip(run, project, c, output, source, transcript))
        c['status'] = 'baked'
        c.pop('baked_hash', None)
    else:
        raise ValueError('Unknown editor action')
    project['revision'] += 1
    atomic_json(run / 'editor-project.json', project)


def editor_bake_layers(run, c):
    """Resolve asset references to RenderRequest bake fields.

    Main copies every uploaded asset into the run folder as `editor-asset-<ref>`;
    a referenced file that is gone fails the export as an invalid edit.
    """
    def asset(ref):
        try:
            return str(local_file(run, f'editor-asset-{ref}'))
        except (ValueError, OSError):
            raise EditorError('invalid_edit', f'Editor asset file is missing: {ref}')
    layers = {}
    if c.get('logo'):
        logo = c['logo']
        layers['logo'] = {'path': asset(logo['asset']), 'position': logo['position'],
                          'scale': logo['scale'], 'opacity': logo['opacity']}
    if c.get('intro_asset'):
        layers['intro_path'] = asset(c['intro_asset'])
    if c.get('outro_asset'):
        layers['outro_path'] = asset(c['outro_asset'])
    if c.get('music'):
        music = c['music']
        layers['music'] = {'path': asset(music['asset']), 'gain': music['gain']}
        for key in ('fade_in_ms', 'fade_out_ms', 'start_ms'):
            if music.get(key) is not None:
                layers['music'][key] = music[key]
    if c.get('brolls'):
        layers['brolls'] = [{'path': asset(b['asset']), 'start_ms': b['start_ms'], 'end_ms': b['end_ms'],
                             **({'layout': b['layout']} if b.get('layout') else {}),
                             **({'swap': True} if b.get('layout') == 'split' and b.get('swap') else {})}
                            for b in sorted(c['brolls'], key=lambda b: b['start_ms'])]
    if c.get('text_overlays'):
        layers['text_overlays'] = []
        for t in sorted(c['text_overlays'], key=lambda t: t['start_ms']):
            layer = {'text': utf16_prefix(t['text'], 120), 'start_ms': t['start_ms'],
                     'end_ms': t['end_ms'], 'position': t['position']}
            # Lower Third extras; the renderer keeps plain cards byte-identical.
            for key in ('preset', 'variant', 'color', 'sub'):
                if t.get(key) is not None:
                    layer[key] = t[key]
            if t.get('preset') and t.get('variant') == 'image' and t.get('image'):
                layer['image'] = asset(t['image'])
            layers['text_overlays'].append(layer)
    if c.get('cta_badges'):
        layers['cta_badges'] = [{'kind': b['kind'], 'position': b['position'],
                                 **({'start_ms': b['start_ms'], 'end_ms': b['end_ms']} if b.get('start_ms') is not None else {})}
                                for b in c['cta_badges']]
    if c.get('range_edits'):
        layers['range_edits'] = [{'id': e['id'], 'kind': e['kind'], 'intensity': e['intensity'],
                                  'start_ms': e['start_ms'], 'end_ms': e['end_ms'],
                                  **({'region': [float(v) for v in e['region']]} if e.get('region') else {})}
                                 for e in sorted(c['range_edits'], key=lambda e: e['start_ms'])]
    if c.get('audio_gain') is not None:
        layers['audio_gain'] = c['audio_gain']
    for key in ('speech_denoise', 'speech_enhance'):
        if c.get(key) is not None:
            layers[key] = c[key]
    if c.get('censor') is not None:
        layers['censor'] = c['censor']
    voiceover = c.get('voiceover')
    if voiceover is not None and voiceover.get('audio_asset'):
        layers['voiceover'] = {
            'path': asset(voiceover['audio_asset']),
            'gain': voiceover.get('gain', 1),
            'start_ms': voiceover.get('start_ms', 0),
        }
    return layers


async def export_clip(run, project, c, output, source, transcript):
    """Render one ready candidate and append it to the library's job output."""
    from clip_engine.config import apply_caption_style_overrides, get_caption_preset
    render_transcript = caption_transcript(transcript, c.get('caption_edits', []))
    caption_style = get_caption_preset(c['caption_preset'])
    if c.get('caption_style'):
        caption_style = apply_caption_style_overrides(caption_style, c['caption_style'])
    next_index = output.get('next_clip_index', 0)
    if type(next_index) is not int or not 0 <= next_index <= 1000:
        raise EditorError('invalid_edit', 'Invalid export sequence')
    index = max(next_index, max((x['clip_index'] for x in output['clips']), default=-1) + 1)
    while (run / f'clip_{index:02d}.mp4').exists() or (run / f'clip_{index:02d}.mp4').is_symlink():
        index += 1
    if index > 999:
        raise EditorError('invalid_edit', 'Too many exports in this project')
    with failure_code('engine_unavailable'):
        renderer = RenderingService()
    a, b = c['ranges'][0][0], c['ranges'][-1][1]
    path = run / f'clip_{index:02d}.mp4'
    if path.exists() or path.is_symlink():
        raise ValueError('Export file already exists')
    # Commit complete renders only; failed/cancelled exports do not change the library.
    with tempfile.TemporaryDirectory(prefix='.editor-export-', dir=run) as work, failure_code('render_failed'):
        result = await renderer.render_clip(RenderRequest(video_path=source, output_path=str(Path(work) / 'clip.mp4'),
            start_time_ms=a, end_time_ms=b, source_width=project['width'], source_height=project['height'],
            transcript_segments=render_transcript, include_captions=c['captions'], caption_style=caption_style,
            caption_suppression_ranges_ms=[tuple(interval) for interval in c.get('caption_suppression_ranges', [])],
            caption_y=c.get('caption_y'),
            caption_x=c.get('caption_x'),
            apply_padding=False, aspect_ratio=project['aspect_ratio'], pacing='natural', video_speed=c['video_speed'],
            manual_ranges_ms=[tuple(interval) for interval in c['ranges']], manual_plan=manual_plan(project, c, read_tracking(run, c['id'])),
            **editor_bake_layers(run, c)))
        os.replace(result.output_path, path)
    output['clips'].append({'clip_index': index, 's3_url': str(path), 'duration_ms': result.duration_ms,
        'start_time_ms': a, 'end_time_ms': b, 'virality_score': c['score'], 'layout_type': result.layout_type,
        'summary': c['title'], 'tags': [], 'render_fallback': None,
        'editor_candidate': c['id'], 'editor_revision': project['revision']})
    output['total_clips'] = len(output['clips'])
    atomic_json(run / 'job_output.json', output)
    return index
