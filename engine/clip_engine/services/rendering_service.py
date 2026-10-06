"""
Rendering Service - FFmpeg rendering with smart framing, pacing and captions.

render_clip pipeline:
  1. Layout plan (9:16): per-shot framing from LayoutAnalyzer.
  2. Pacing: keep intervals from ClipEditor (tight pacing cuts dead air/fillers).
  3. One filter graph: video and audio edited on the same presentation clock.
  4. Captions and title/banner overlays remapped onto the edited timeline.
"""

import asyncio
import copy
import json
import logging
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field, replace
from fractions import Fraction
from typing import Callable, Optional, Union

from PIL import Image, ImageDraw, ImageFont

from clip_engine.config import CaptionStyle, LayoutStyle, get_landscape_dimensions, get_output_dimensions, get_settings
from clip_engine.services.caption_generator import CaptionGeneratorService
from clip_engine.services.clip_editor import (
    Pacing,
    TimeMap,
    compute_keep_intervals,
    reaction_intervals,
    remap_plan,
    remap_segments,
    subtract_intervals,
    window_words,
)
from clip_engine.services.layout_analyzer import ClipLayoutPlan, LayoutAnalyzer, LayoutType, ShotLayout
from clip_engine.services.framing_trace import make_trace, save_trace
from clip_engine.services.editorial_context import window_protection, record_prevented_cuts
from clip_engine.services.editorial_review import review_retained_clip
from clip_engine.services.jev_service import JevService
from clip_engine.services.coherence_review import CoherenceReviewer, CoherenceRejected
from clip_engine.services.media_process import MEDIA_INPUT_OPTIONS, PROBE_TIMEOUT_SECONDS, media_process, run_media, validate_video_dimensions
from clip_engine.services.layout_renderer import (
    AUDIO_FORMAT,
    AUDIO_SYNC,
    CaptionPlacer,
    banner_y,
    build_layout_graph,
    caption_anchor,
    censor_intervals,
    censor_transcript,
    face_zones,
    measured_loudness_filter,
    per_shot_expr,
    title_y,
)
from clip_engine.services.transcription_service import TranscriptSegment
from clip_engine.services.video_speed import scaled_duration_ms, speed_video_filter, validate_video_speed

logger = logging.getLogger(__name__)

# (png_path, x_expr, y_expr) for an image composited over the video, or
# (png_path, x_expr, y_expr, enable_expr, image_filter) for one shown only
# while enable_expr holds, with image_filter (e.g. alpha fades) applied first.
Overlay = Union[tuple[str, str, str], tuple[str, str, str, str, str]]

# Landscape title card: on screen for the opening seconds only (a title
# pinned over a 15 minute episode just covers the video).
LANDSCAPE_TITLE_SHOW_S = (0.4, 5.5)
LANDSCAPE_TITLE_FADE_S = 0.4
# Output frame rates a landscape render keeps from its source (higher is capped).
MAX_OUTPUT_FPS = 60
# Bound raster allocation even when a model ignores the requested title length.
MAX_TITLE_CHARS = 120
# Landscape H.264 bitrates (Mbps) by output height at 30 fps, after
# YouTube's upload recommendations; 60 fps sources get 1.5x.
LANDSCAPE_BITRATE_MBPS = {1080: 12, 1440: 20, 2160: 45}
# Leave room for input/output paths and codec options below Windows' process
# command-line limit. Long edits can contain hundreds of trims and concats.
MAX_INLINE_FILTER_GRAPH_BYTES = 8192


@dataclass
class RenderRequest:
    """Request for rendering a clip."""

    video_path: str
    output_path: str
    start_time_ms: int
    end_time_ms: int
    source_width: int
    source_height: int

    # Word timings drive tight pacing as well as captions, so they are passed
    # even when captions are off.
    transcript_segments: Optional[list[TranscriptSegment]] = None
    include_captions: bool = True
    caption_style: Optional[CaptionStyle] = None
    # Hide only our caption layer in these source-time intervals.
    caption_suppression_ranges_ms: list[tuple[int, int]] = field(default_factory=list)
    # Explicit editor placement overrides automatic per-layout caption anchors.
    caption_y: Optional[float] = None
    # Horizontal caption center as a fraction of output width; None stays centered.
    caption_x: Optional[float] = None

    title_text: Optional[str] = None
    # Off keeps title_text for editorial review but draws no title card.
    include_title: bool = True
    # Planner-chosen punch words highlighted in the captions.
    emphasis_words: list[str] = field(default_factory=list)

    banner_platform: Optional[str] = None
    banner_channel_url: Optional[str] = None

    include_audio: bool = True
    apply_padding: bool = True
    aspect_ratio: str = "9:16"
    # Framing for 9:16 / 1:1 output: auto (smart per-shot), fill or fit.
    layout_style: str = LayoutStyle.AUTO
    # tight: cut dead air and filler words; natural: original timing.
    pacing: str = Pacing.TIGHT
    video_speed: float = 1.0
    # Longform episode (16:9, 5+ min): gentler pacing, SRT sidecar, and the
    # planner's skips (source ms, cut at any pacing) and chapters (source ms).
    longform: bool = False
    skip_ranges_ms: list[tuple[int, int]] = field(default_factory=list)
    chapters: list[tuple[int, str]] = field(default_factory=list)
    debug_capture: bool = False
    progress_callback: Optional[Callable[[str, Optional[float]], None]] = None
    manual_plan: Optional[ClipLayoutPlan] = None
    # Multi-format variant renders: reuse the primary's analyzed plan and
    # pacing time map (window-relative ms) so no vision or LLM call repeats.
    precomputed_plan: Optional[ClipLayoutPlan] = None
    precomputed_time_map: Optional[TimeMap] = field(default=None, repr=False)
    # Exact source-time selections from the manual editor; no automatic pacing,
    # sliver removal or protected-interval restoration may change these cuts.
    manual_ranges_ms: Optional[list[tuple[int, int]]] = None
    # Manual editor bake layers. All optional; absent/empty leaves the render
    # byte-identical to the graph these edits replace.
    # {'path', 'position', 'scale' (of output width), 'opacity'} logo watermark,
    # composited above the captions, title and banner.
    logo: Optional[dict] = None
    # Built-in CTA badges [{kind 'subscribe'|'follow', position, start_ms?, end_ms?}]
    # in source time, drawn with Pillow and composited above the burned layers.
    cta_badges: list[dict] = field(default_factory=list)
    # Uploaded video prepended to the baked clip (re-encoded to match).
    intro_path: Optional[str] = None
    # User intro is prepended by _concat_intro; the outro is appended by _concat_outro.
    outro_path: Optional[str] = None
    # Background music {'path', 'gain' 0–1} mixed under the speech.
    music: Optional[dict] = None
    # Picture inserts [{path, start_ms, end_ms}] in source time.
    brolls: list[dict] = field(default_factory=list)
    # Timed text cards [{text, start_ms, end_ms, position}] in source time.
    text_overlays: list[dict] = field(default_factory=list)
    # Output level of the clip's own audio before any music mix.
    audio_gain: float = 1.0
    # Speech Enhancement (0 = off): FFT denoise amount and voice lift/clarity,
    # applied to the speech before loudness normalization.
    speech_denoise: float = 0.0
    speech_enhance: float = 0.0
    # Auto Censor: {'words': [...], 'captions': 'asterisk'|'first'|'off',
    # 'audio': 'mute'|'bleep'|'off'} — masked captions, muted/bleeped speech.
    censor: Optional[dict] = None
    # AI voiceover bed: {'path', 'gain' 0–2, 'start_ms'} mixed under the
    # speech, independent of audio_gain, on the pre-speed edited clock.
    voiceover: Optional[dict] = None
    # Range Effects [{id, kind, intensity, start_ms, end_ms, region?}] on the
    # final-clock footage, before any overlay or caption.
    range_edits: list[dict] = field(default_factory=list)
    editorial_context: Optional[dict] = None
    editorial_service: Optional[JevService] = field(default=None, repr=False)
    coherence_reviewer: Optional[CoherenceReviewer] = field(default=None, repr=False)


@dataclass
class RenderResult:
    """Result of rendering operation."""

    output_path: str
    file_size_bytes: int
    duration_ms: int  # of the rendered file, after pacing cuts and speed
    removed_ms: int = 0  # dead air / fillers cut by tight pacing
    layout_type: str = "fit"
    layout_shots: list[dict] = field(default_factory=list)
    layout_cost_usd: float = 0.0
    # Which fallback produced the file: None (as planned), "letterbox" (smart
    # framing dropped, pacing kept) or "letterbox_natural" (both dropped).
    render_fallback: Optional[str] = None
    # Chapters as (output ms, title) on the edited timeline.
    chapters: list[tuple[int, str]] = field(default_factory=list)
    # SRT sidecar for longform clips, next to the clip.
    subtitle_path: Optional[str] = None
    output_width: int = 0
    output_height: int = 0
    framing_trace_path: Optional[str] = None
    # Framing plan and time map actually used, so multi-format variant renders
    # of the same segment can reuse them without new vision or LLM cost.
    used_plan: Optional[ClipLayoutPlan] = field(default=None, repr=False)
    used_time_map: Optional[TimeMap] = field(default=None, repr=False)
    # Source time the layout shots' window-relative times start from, so an
    # editor import can map them back onto the original video.
    window_start_ms: int = 0


PREVIEW_TOLERANCE_MS = 2000


def preview_duration_ok(path, expected_ms, tolerance_ms=PREVIEW_TOLERANCE_MS) -> bool:
    """True when ffprobe reads a duration within `tolerance_ms` of the intended transcode length.

    A transcode interrupted mid-run leaves a truncated file; its probed duration falls
    short (or the probe fails outright), so this gates the partial→final rename and the
    reuse of any pre-existing preview.
    """
    try:
        result = run_media(["ffprobe", "-v", "error", *MEDIA_INPUT_OPTIONS, "-show_entries", "format=duration",
                            "-of", "csv=p=0", str(path)], timeout=PROBE_TIMEOUT_SECONDS)
        duration_ms = float(result.stdout.decode(errors="replace").strip()) * 1000
    except Exception as error:
        logger.warning(f"Preview duration probe failed: {type(error).__name__}")
        return False
    return math.isfinite(duration_ms) and abs(duration_ms - float(expected_ms)) <= tolerance_ms


# The 12 animated Lower Third presets (Name Tag / Location), mirrored by
# lowerThirdPresets in src/shared/clip-editor.ts. Rendered as layered ASS
# events: text-extent boxes (BorderStyle=3), full-width band drawings (\p1)
# and accent strips, all sharing one entrance animation per preset.
LOWER_THIRDS = {
    #                  anim   box       band   edge     upper  size  bg        fg        accent    sub
    'name-classic':  dict(anim='rise',  box='fill',    band=False, edge=None,    upper=False, size=.052, bg='#14161c', fg='#ffffff', accent='#1a5fdf', sub=True),
    'name-accent':   dict(anim='fade',  box=None,      band=False, edge='under', upper=False, size=.056, bg='#1a5fdf', fg='#ffffff', accent='#1a5fdf', sub=False),
    'name-side':     dict(anim='slide', box='fill',    band=False, edge='left',  upper=False, size=.052, bg='#14161c', fg='#ffffff', accent='#7c3aed', sub=True),
    'name-two-line': dict(anim='rise',  box='fill',    band=False, edge=None,    upper=False, size=.050, bg='#14161c', fg='#ffffff', accent='#0e7a5f', sub=True),
    'name-clean':    dict(anim='fade',  box=None,      band=False, edge=None,    upper=False, size=.058, bg='#14161c', fg='#ffffff', accent='#1a5fdf', sub=False),
    'name-card':     dict(anim='pop',   box='fill',    band=False, edge='under', upper=False, size=.052, bg='#1c1e26', fg='#ffffff', accent='#1a5fdf', sub=True),
    'loc-pill':      dict(anim='pop',   box='fill',    band=False, edge=None,    upper=True,  size=.046, bg='#b3261e', fg='#ffffff', accent='#b3261e', sub=False),
    'loc-ticker':    dict(anim='slide', box=None,      band=True,  edge=None,    upper=True,  size=.044, bg='#111827', fg='#ffffff', accent='#1a5fdf', sub=False),
    'loc-pin':       dict(anim='fade',  box='fill',    band=False, edge=None,    upper=True,  size=.048, bg='#c2410c', fg='#ffffff', accent='#c2410c', sub=False),
    'loc-banner':    dict(anim='rise',  box=None,      band=True,  edge=None,    upper=True,  size=.052, bg='#0f172a', fg='#ffffff', accent='#f59e0b', sub=True),
    'loc-frame':     dict(anim='fade',  box='fill',    band=False, edge=None,    upper=True,  size=.050, bg='#e5e7eb', fg='#111318', accent='#e5e7eb', sub=False),
    'loc-spotlight': dict(anim='fade',  box=None,      band=True,  edge=None,    upper=True,  size=.048, bg='#050608', fg='#ffffff', accent='#1a5fdf', sub=False),
}
LOWER_THIRD_IDS = frozenset(LOWER_THIRDS)


def ass_color(hex_color: str, alpha: int = 0) -> str:
    """#rrggbb as an ASS style colour &HAABBGGRR (00 = opaque)."""
    value = hex_color.lstrip('#')
    red, green, blue = value[0:2], value[2:4], value[4:6]
    return f'&H{alpha:02X}{blue}{green}{red}'.upper()


TEXT_BOX_FONT_FILES = {
    'montserrat': 'Montserrat-Black.ttf',
    'poppins': 'Poppins-Black.ttf',
    'archivo': 'ArchivoBlack-Regular.ttf',
    'instrument': 'InstrumentSerif-Italic.ttf',
    'jakarta': 'PlusJakartaSans.ttf'
}


def _resolve_box_font(font_family: str):
    from PIL import ImageFont
    name = TEXT_BOX_FONT_FILES.get(font_family, TEXT_BOX_FONT_FILES['montserrat'])
    return os.path.join(os.path.dirname(__file__), '..', '..', 'assets', 'fonts', name)


def _wrap_box_lines(draw, text, font, max_width):
    words, lines, current = text.split(), [], ''
    for word in words:
        candidate = f'{current} {word}'.strip()
        if draw.textlength(candidate, font=font) <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines or ['']


def _hex_rgba(color: str, alpha: int = 255):
    value = color.lstrip('#')
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), alpha)


class RenderingService:
    """
    Service for rendering clips using FFmpeg.

    Renders 9:16 vertical clips with per-shot smart framing (speaker crop,
    stacked splits, screen + webcam, or letterbox) and ASS caption burning.
    """

    def __init__(self):
        self.settings = get_settings()
        self.caption_generator = CaptionGeneratorService()
        self.layout_analyzer = LayoutAnalyzer()
        self._verify_ffmpeg()
        self._font_path = self._resolve_font()
        self._fonts_dir = self._resolve_fonts_dir()

    def _resolve_font(self) -> str:
        """Find Montserrat Black font, falling back to ExtraBold then Liberation Sans Bold."""
        candidates = [
            os.path.join(os.path.dirname(__file__), "..", "..", "assets", "fonts", "Montserrat-Black.ttf"),
            os.path.join("/app", "assets", "fonts", "Montserrat-Black.ttf"),
            os.path.join(os.path.dirname(__file__), "..", "..", "assets", "fonts", "Montserrat-ExtraBold.ttf"),
            os.path.join("/app", "assets", "fonts", "Montserrat-ExtraBold.ttf"),
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        ]
        for p in candidates:
            resolved = os.path.abspath(p)
            if os.path.isfile(resolved):
                logger.info(f"Using font: {resolved}")
                return resolved
        return "Sans"

    @staticmethod
    def _resolve_fonts_dir() -> Optional[str]:
        """Bundled caption fonts. libass only sees fonts it is pointed at: without
        this, captions fall back to a system face (Helvetica, DejaVu) whatever
        the preset asks for."""
        for p in (
            os.path.join(os.path.dirname(__file__), "..", "..", "assets", "fonts"),
            os.path.join("/app", "assets", "fonts"),
        ):
            resolved = os.path.abspath(p)
            if os.path.isdir(resolved):
                return resolved
        logger.warning("Caption fonts directory not found; captions will use system fonts")
        return None

    def _verify_ffmpeg(self):
        """Verify ffmpeg is available."""
        if not shutil.which("ffmpeg"):
            raise RuntimeError("ffmpeg not found in PATH")
        if self.settings.local_mode and sys.platform != "darwin":
            encoders = run_media(["ffmpeg", "-hide_banner", "-encoders"], timeout=10, check=True).stdout.decode("utf-8", errors="replace")
            self._local_cpu_encoder = next((name for name in ("libopenh264", "libx264") if re.search(rf"\b{name}\b", encoders)), None)
            if self._local_cpu_encoder is None:
                raise RuntimeError("FFmpeg needs a CPU H.264 encoder (OpenH264 or x264)")
        logger.info("FFmpeg available")

    def _video_codec_args(self, out_w: int = 1080, out_h: int = 1920, fps: str = "30") -> list[str]:
        """Use the bundled LGPL encoders in BridgeClip; retain server encoding.

        Keyframes every 2 s keep long clips seekable. Landscape bitrates scale
        with resolution and frame rate (VideoToolbox is bitrate-driven).
        """
        rate = float(Fraction(fps))
        gop = ["-g", str(max(1, round(rate * 2)))]
        if self.settings.local_mode and sys.platform == "darwin":
            # VideoToolbox otherwise requires a free hardware encoder. Allow
            # Apple's software fallback on Intel VMs and Macs with a busy GPU.
            if out_w > out_h:
                mbps = LANDSCAPE_BITRATE_MBPS.get(out_h, 12) * (1.5 if rate > 31 else 1)
                return ["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-profile:v", "high", "-b:v", f"{mbps:g}M", *gop]
            return ["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", "8M", *gop]
        if self.settings.local_mode and getattr(self, "_local_cpu_encoder", "libopenh264") == "libopenh264":
            # The Windows/Linux LGPL distribution includes OpenH264, not x264.
            # A CPU encoder also works on machines without an NVIDIA/Intel GPU.
            mbps = LANDSCAPE_BITRATE_MBPS.get(out_h, 12) if out_w > out_h else 8
            if rate > 31:
                mbps *= 1.5
            return ["-c:v", "libopenh264", "-b:v", f"{mbps:g}M", *gop]
        return ["-c:v", "libx264", "-preset", self.settings.ffmpeg_preset,
                "-crf", str(self.settings.ffmpeg_crf), *gop]

    async def capture_framing_source(self, video_path: str, output_path: str, *, progress=None, duration_ms=None,
                                     start_ms=None, end_ms=None) -> None:
        """One uncropped preview per captured run, on the original source clock.

        A fast per-reel import passes `start_ms`/`end_ms` to transcode only that
        window; the caller then records the offset (the output timeline restarts
        at 0) so seeks stay on the source clock.
        """
        width, height = await self._get_video_dimensions(video_path)
        scale = min(1, 1280 / width, 720 / height)
        out_w, out_h = max(2, int(width * scale / 2) * 2), max(2, int(height * scale / 2) * 2)
        fps = await self._probe_fps(video_path)
        # A framing preview, not an export: about 3 Mbps at 720p30 (4.5 at
        # 60 fps) keeps an hour of source near 1.4 GB rather than 5-8 GB.
        mbps = round(max(1, 3 * out_w * out_h / (1280 * 720)) * (1.5 if float(Fraction(fps)) > 31 else 1), 1)
        codec = self._video_codec_args(out_w, out_h, fps)
        if "-b:v" in codec:
            codec[codec.index("-b:v") + 1] = f"{mbps:g}M"
        else:
            codec += ["-maxrate", f"{mbps:g}M", "-bufsize", f"{2 * mbps:g}M"]
        window = []
        if start_ms is not None or end_ms is not None:
            if start_ms is None or end_ms is None:
                raise ValueError('Preview window needs both start and end')
            a, b = float(start_ms), float(end_ms)
            if not (math.isfinite(a) and math.isfinite(b)) or a < 0 or b - a < 100:
                raise ValueError('Invalid preview window')
            # Input options, like the export path: seek before -i and bound the
            # source read, instead of decoding and discarding the whole file.
            window = ["-accurate_seek", "-ss", f"{a / 1000:.6f}", "-t", f"{(b - a) / 1000:.6f}"]
            duration_ms = b - a  # Progress percent covers only the transcoded window.
        temporary = output_path + ".partial.mp4"
        # The intended final length: the window for a fast per-reel preview, the
        # caller's source duration otherwise, or the probed source when unknown.
        expected_ms = duration_ms if duration_ms is not None else (await self._probe_duration_ms(video_path) or None)
        try:
            if os.path.isfile(temporary):
                # Left by an interrupted run: FFmpeg's -n would refuse to start over it.
                os.remove(temporary)
            cmd = [
                "ffmpeg", "-nostdin", "-v", "error", "-n", *window, *MEDIA_INPUT_OPTIONS, "-i", video_path,
                "-map", "0:v:0", "-map", "0:a:0?", "-vf",
                f"scale={out_w}:{out_h},setsar=1",
                "-fps_mode", "passthrough", "-enc_time_base", "1:1000000",
                *codec, "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-af", AUDIO_SYNC, "-b:a", "96k", "-movflags", "+faststart", temporary,
            ]
            if progress is None:
                await self._run_cmd(cmd)
            else:
                await self._run_cmd(cmd, progress=progress, duration_ms=duration_ms)
            # Complete only when FFmpeg exited 0 and the file probes to the intended length:
            # a truncated transcode must never become the final preview.
            if expected_ms is not None and not await asyncio.to_thread(
                    preview_duration_ok, temporary, expected_ms):
                raise RenderingError("Editor preview transcode is incomplete")
            os.chmod(temporary, 0o600)
            os.replace(temporary, output_path)
        finally:
            if os.path.isfile(temporary):
                os.remove(temporary)

    @staticmethod
    def _capture_preview_progress(cmd, duration_ms, progress, check=True):
        """Read FFmpeg's machine progress without exposing paths or stderr."""
        if not isinstance(duration_ms, (int, float)) or not math.isfinite(duration_ms) or duration_ms <= 0:
            raise ValueError('Invalid preview duration')
        reported = 0
        progress(0)
        cmd = [cmd[0], '-progress', 'pipe:1', '-stats_period', '0.5', *cmd[1:]]
        with media_process(cmd) as (process, stderr):
            while raw := process.stdout.readline(1025):
                if len(raw) > 1024:
                    raise RenderingError('Invalid preview progress')
                if raw.startswith(b'out_time_us='):
                    try:
                        percent = max(0, min(99, int(int(raw.split(b'=', 1)[1]) / (duration_ms * 1000) * 100)))
                    except ValueError:
                        continue  # FFmpeg can report N/A before the first frame.
                    if percent > reported:
                        reported = percent
                        progress(percent)
        result = subprocess.CompletedProcess(cmd, process.returncode, b'', bytes(stderr))
        if result.returncode:
            if check: raise RenderingError('Video encoding failed')
        else:
            progress(100)
        return result

    async def render_clip(self, request: RenderRequest) -> RenderResult:
        """
        Render a clip in the requested aspect ratio.

        9:16 (vertical): Smart framing per shot (see LayoutAnalyzer), or the
            blurred-background letterbox for the "fit" style / as a fallback.
        1:1 (square): The same smart-framing path on a square canvas.
        16:9 (landscape): Whole frame at the source's resolution (1080p-4K)
            and frame rate, over a blurred fill when the source isn't 16:9.
        """
        validate_video_speed(request.video_speed)
        os.makedirs(os.path.dirname(request.output_path), exist_ok=True)

        duration_ms = request.end_time_ms - request.start_time_ms
        if duration_ms <= 0:
            raise RenderingError("Invalid clip duration")

        is_landscape = request.aspect_ratio == "16:9"

        source_w = request.source_width
        source_h = request.source_height

        actual_width, actual_height = await self._get_video_dimensions(request.video_path)
        if actual_width > 0 and actual_height > 0:
            source_w = actual_width
            source_h = actual_height

        if is_landscape:
            target_width, target_height = get_landscape_dimensions(source_w, source_h)
            fps = await self._probe_fps(request.video_path)
        else:
            target_width, target_height = get_output_dimensions(request.aspect_ratio)
            fps = await self._probe_fps(request.video_path) if request.manual_plan is not None else "30"

        logger.info(
            f"Rendering clip: {request.start_time_ms}ms-{request.end_time_ms}ms, "
            f"output={target_width}x{target_height}@{fps} ({request.aspect_ratio}"
            f"{', longform' if request.longform else ''}), include_audio={request.include_audio}"
        )

        if request.apply_padding:
            window_start_ms, window_ms = self._compute_padded_range(request.start_time_ms, duration_ms)
        else:
            window_start_ms, window_ms = request.start_time_ms, duration_ms

        if request.progress_callback:
            request.progress_callback('Analyzing framing and camera changes', None)
        plan: Optional[ClipLayoutPlan] = None
        if request.manual_plan is not None:
            plan = request.manual_plan
        elif request.precomputed_plan is not None:
            plan = request.precomputed_plan
        elif not is_landscape:
            plan = await self._plan_layout(request, source_w, source_h, window_start_ms, window_ms)
        analyzed = plan is not None
        # Pacing needs to know what's on screen even when the framing doesn't
        # use it (Classic style, 16:9 output): a silent screen demo isn't dead air.
        pacing_plan = plan
        if pacing_plan is None and (is_landscape or request.layout_style == LayoutStyle.FIT) and self._paces(request):
            pacing_plan = await self._content_plan(request, source_w, source_h, window_start_ms, window_ms)
        if request.debug_capture and pacing_plan is None:
            pacing_plan = await self._content_plan(request, source_w, source_h, window_start_ms, window_ms)
        # Faces seen while analyzing, kept by every fallback so captions still
        # stay off them.
        face_samples = pacing_plan.face_samples if pacing_plan is not None else []
        if plan is None:
            plan = ClipLayoutPlan(
                shots=[ShotLayout(0, window_ms, LayoutType.SCREEN, source="style")],
                source_width=source_w, source_height=source_h, face_samples=face_samples,
            )

        if request.manual_plan is not None:
            ranges = request.manual_ranges_ms
            if not ranges or any(start < window_start_ms or end > window_start_ms + window_ms or end <= start or
                                 (i > 0 and start < ranges[i - 1][1]) for i, (start, end) in enumerate(ranges)):
                raise RenderingError('Manual rendering requires valid selected intervals')
            time_map = TimeMap([(a - window_start_ms, b - window_start_ms) for a, b in ranges], window_ms)
            natural_map = time_map
        elif request.precomputed_time_map is not None:
            if request.precomputed_time_map.window_ms != window_ms:
                raise RenderingError('Precomputed time map does not match the render window')
            time_map = request.precomputed_time_map
            natural_map = time_map
        else:
            skips = self._window_skips(request, window_start_ms, window_ms)
            keeps = self._keep_intervals(request, pacing_plan, window_start_ms, window_ms)
            protected = window_protection(request.editorial_context or {}, window_start_ms, window_ms)
            # Existing audio-event protection must survive explicit skips too.
            protected += reaction_intervals(request.transcript_segments or [], window_start_ms, window_ms)
            if request.editorial_context is not None:
                baseline = self._keep_intervals(replace(request, editorial_context=None), pacing_plan, window_start_ms, window_ms)
                record_prevented_cuts(request.editorial_context, baseline, skips, protected, window_start_ms, window_ms, pacing_plan)
            time_map = TimeMap(subtract_intervals(keeps, skips, protected, window_ms), window_ms)
            # Natural timing still honours the planner's skips: they're edit
            # decisions, not pacing.
            natural_map = TimeMap(subtract_intervals([(0, window_ms)], skips, protected, window_ms), window_ms)
            if request.coherence_reviewer:
                time_map = await request.coherence_reviewer.audit_edit(request.title_text, time_map,
                    window_start_ms, window_ms, request.editorial_context, pacing_plan)
                natural_map = TimeMap([(0, window_ms)], window_ms)
        smart = analyzed and not plan.is_letterbox_only
        # Variant renders reuse the primary's plan; its vision cost was booked
        # with the primary, so variants report zero.
        vision_cost = 0.0 if request.precomputed_plan is not None else (plan.vision_cost_usd if analyzed else 0.0)

        # Longform audio gets two-pass (linear) loudness normalization.
        loudness_filter = None
        if request.longform and request.include_audio and await self._has_audio(request.video_path):
            loudness_filter = await self._measure_loudness(request.video_path, window_start_ms, window_ms)

        # A layout or pacing edge case must not cost the clip. Fallback ladder:
        # as planned -> letterbox with the same cuts -> letterbox at natural
        # timing (a pacing edge case can be what failed, so cuts go last).
        letterbox = ClipLayoutPlan(
            shots=[ShotLayout(0, window_ms, LayoutType.SCREEN, source="fallback")],
            source_width=source_w, source_height=source_h, face_samples=face_samples,
        )
        ladder: list[tuple[ClipLayoutPlan, TimeMap, Optional[str]]] = [(plan, time_map, None)]
        if smart and request.manual_plan is None:
            ladder.append((letterbox, time_map, "letterbox"))
        if time_map.keeps != natural_map.keeps and request.manual_plan is None:
            ladder.append((letterbox, natural_map, "letterbox_natural"))

        render_fallback: Optional[str] = None
        attempted_plan = plan
        attempts = []
        for step, (step_plan, step_map, fallback) in enumerate(ladder):
            if request.coherence_reviewer and step_map.keeps != time_map.keeps:
                source_keeps = [(window_start_ms + a, window_start_ms + b) for a, b in step_map.keeps]
                if not await request.coherence_reviewer.judge(request.title_text, source_keeps, request.editorial_context, 'render_fallback'):
                    request.editorial_context['coherence']['status'] = 'rejected'
                    raise CoherenceRejected('Clip omitted: rendering fallback failed coherence review.')
            try:
                await self._render_edit(
                    request, step_plan, step_map, window_start_ms, window_ms,
                    target_width, target_height, is_landscape, fps, loudness_filter,
                )
            except Exception as e:
                attempts.append({"fallback": fallback, "status": "failed", "failure": "render_failed"})
                # Any failure (FFmpeg, or a bug building the graph, captions or
                # overlays) moves down the ladder; only the last step raises.
                if step == len(ladder) - 1:
                    raise
                logger.warning(
                    f"Render failed, retrying as {ladder[step + 1][2]}: {e}",
                    exc_info=not isinstance(e, RenderingError),
                )
                continue
            plan, time_map, render_fallback = step_plan, step_map, fallback
            attempts.append({"fallback": fallback, "status": "rendered", "failure": None})
            break
        if render_fallback:
            smart, analyzed = False, False

        file_size = os.path.getsize(request.output_path)
        removed_ms = time_map.removed_ms
        final_duration_ms = scaled_duration_ms(time_map.output_ms, request.video_speed)
        if request.intro_path or request.outro_path:
            # The intro/outro were concatenated onto the finished file inside
            # _render_edit; report the real post-concat duration.
            probed = await self._probe_duration_ms(request.output_path)
            if probed:
                final_duration_ms = probed
        chapters = self._output_chapters(request, window_start_ms, time_map)
        subtitle_path = await self._write_subtitles(request, window_start_ms, time_map)
        if request.editorial_context is not None:
            if request.editorial_service is not None:
                retained = remap_segments(request.transcript_segments or [], window_start_ms, time_map)
                await review_retained_clip(request.editorial_service, request.title_text, retained, request.editorial_context)
            request.editorial_context['retained_source'] = [[window_start_ms + a, window_start_ms + b] for a, b in time_map.keeps]
        trace_path = None
        if request.debug_capture or (request.editorial_context and request.editorial_service and request.editorial_service.enabled):
            trace_path = request.output_path + ".framing.json"
            try:
                trace = make_trace(request, pacing_plan, attempted_plan, plan, time_map, window_start_ms,
                                   window_ms, target_width, target_height, fps, attempts, self.settings)
                await asyncio.to_thread(save_trace, trace_path, trace)
            except Exception:
                logger.warning("Framing trace could not be saved")
                trace_path = None
        logger.info(
            f"Clip rendered: {request.output_path} ({file_size / 1024 / 1024:.1f} MB, "
            f"{scaled_duration_ms(time_map.output_ms, request.video_speed) / 1000:.1f}s at {request.video_speed:g}x"
            + (f", pacing removed {removed_ms / 1000:.1f}s in {time_map.cut_count} cuts" if removed_ms else "")
            + (f", fallback={render_fallback}" if render_fallback else "")
            + ")"
        )
        return RenderResult(
            output_path=request.output_path,
            file_size_bytes=file_size,
            duration_ms=final_duration_ms,
            removed_ms=removed_ms,
            layout_type=plan.dominant_layout if smart else "fit",
            layout_shots=[shot.summary() for shot in plan.shots] if analyzed else [],
            # Vision calls made for the plan are paid for even if a fallback rendered.
            layout_cost_usd=vision_cost,
            render_fallback=render_fallback,
            chapters=chapters,
            subtitle_path=subtitle_path,
            output_width=target_width,
            output_height=target_height,
            framing_trace_path=trace_path,
            used_plan=plan,
            used_time_map=time_map,
            window_start_ms=window_start_ms,
        )

    @staticmethod
    def _window_skips(request: RenderRequest, window_start_ms: int, window_ms: int) -> list[tuple[int, int]]:
        """The planner's skips in window time, clipped to the window."""
        skips = []
        for start, end in request.skip_ranges_ms:
            s, e = max(0, start - window_start_ms), min(window_ms, end - window_start_ms)
            if e > s:
                skips.append((s, e))
        return skips

    @staticmethod
    def _output_chapters(
        request: RenderRequest, window_start_ms: int, time_map: TimeMap,
    ) -> list[tuple[int, str]]:
        """Chapters moved onto the edited timeline; the first starts at 0."""
        chapters: list[tuple[int, str]] = []
        for t_ms, title in request.chapters:
            out = scaled_duration_ms(time_map.to_output_clamped(max(0, t_ms - window_start_ms)), request.video_speed)
            if chapters and out - chapters[-1][0] < 10_000:
                continue  # YouTube needs 10 s+ per chapter
            if out < scaled_duration_ms(time_map.output_ms, request.video_speed) - 10_000:
                chapters.append((out, title))
        if chapters:
            chapters[0] = (0, chapters[0][1])
        return chapters

    async def _write_subtitles(
        self, request: RenderRequest, window_start_ms: int, time_map: TimeMap,
    ) -> Optional[str]:
        """SRT sidecar on the edited timeline, for longform uploads."""
        if not (request.longform and request.transcript_segments):
            return None
        try:
            segments = remap_segments(request.transcript_segments, window_start_ms, time_map)
            for segment in segments:
                for item in [segment, *segment.words]:
                    item.start_time_ms = window_start_ms + scaled_duration_ms(item.start_time_ms - window_start_ms, request.video_speed)
                    item.end_time_ms = max(item.start_time_ms + 1, window_start_ms + scaled_duration_ms(item.end_time_ms - window_start_ms, request.video_speed))
            path = os.path.splitext(request.output_path)[0] + ".srt"
            return self.caption_generator.generate_srt(
                segments, window_start_ms, window_start_ms + scaled_duration_ms(time_map.output_ms, request.video_speed), path,
            )
        except Exception as e:
            logger.warning(f"Subtitle sidecar failed; the clip is unaffected: {e}")
            return None

    # Input options for extra filter-graph inputs.
    LOOP_IMAGE = ['-loop', '1', '-protocol_whitelist', 'file,pipe,fd']
    PLAIN_FILE = ['-protocol_whitelist', 'file,pipe,fd']
    LOOP_AUDIO = ['-stream_loop', '-1', '-protocol_whitelist', 'file,pipe,fd']
    IMAGE_EXTENSIONS = frozenset({'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'avif'})

    async def _render_edit(
        self,
        request: RenderRequest,
        plan: ClipLayoutPlan,
        time_map: TimeMap,
        window_start_ms: int,
        window_ms: int,
        target_width: int,
        target_height: int,
        is_landscape: bool,
        fps: str = "30",
        loudness_filter: Optional[str] = None,
    ) -> None:
        """Build the graph, captions and overlays for one edit and run FFmpeg."""
        has_audio = request.include_audio and await self._has_audio(request.video_path)
        out_plan = remap_plan(plan, time_map)
        overlays = self._overlays(request, out_plan, target_width, target_height, is_landscape, time_map, window_start_ms)
        # Extra input order: generated overlay PNGs (title, banner, brand), b-rolls, music, voiceover.
        brolls = list(request.brolls or [])
        music = request.music if has_audio and request.music and request.music.get('gain', 1) > 0 else None
        voiceover = request.voiceover if has_audio and request.voiceover and request.voiceover.get('path') else None
        music_index = 1 + len(overlays) + len(brolls) if music else None
        voiceover_index = (music_index + 1 if music_index is not None else 1 + len(overlays) + len(brolls)) if voiceover else None
        # Auto Censor audio: output-time word intervals on the same clock the
        # captions use; the bleep needs actual spans, so silence stays silence.
        censor_mutes, censor_bleep = None, False
        censor = request.censor if has_audio else None
        if censor and censor.get('audio', 'off') != 'off' and request.transcript_segments:
            censor_mutes = censor_intervals(
                remap_segments(request.transcript_segments, window_start_ms, time_map),
                censor.get('words', []))
            censor_bleep = censor.get('audio') == 'bleep' and bool(censor_mutes)
            if not censor_mutes:
                censor_mutes = None
        graph = build_layout_graph(
            plan, target_width, target_height, time_map.keeps, has_audio, landscape=is_landscape,
            fps=fps, loudness_filter=loudness_filter,
            video_speed=request.video_speed,
            audio_gain=request.audio_gain, music_index=music_index,
            speech_denoise=request.speech_denoise, speech_enhance=request.speech_enhance,
            music_gain=music['gain'] if music else 1.0,
            music_fade_in_ms=music.get('fade_in_ms', 0) if music else 0,
            music_fade_out_ms=music.get('fade_out_ms', 0) if music else 0,
            music_start_ms=music.get('start_ms', 0) if music else 0,
            censor_mutes=censor_mutes, censor_bleep=censor_bleep,
            voiceover_index=voiceover_index,
            voiceover_gain=voiceover.get('gain', 1) if voiceover else 1.0,
            voiceover_start_ms=voiceover.get('start_ms', 0) if voiceover else 0,
        )
        caption_path = await self._generate_captions(
            request, target_width, target_height, window_start_ms, time_map, out_plan, is_landscape, plan,
        )
        graph += self._caption_graph(caption_path, request.caption_suppression_ranges_ms, window_start_ms, time_map)
        # Burn captions and animate framing/overlays on the edited source clock,
        # then speed up the entire composited picture to match the tempo audio.
        # Editor b-rolls and text cards land on the final (sped-up) clock so
        # their timing is exact; they end at [out].
        baking = bool(brolls or request.text_overlays)
        filter_complex, png_paths = self._compose_overlays(
            graph, overlays, speed_video_filter(request.video_speed, fps),
            output_label='pre_bake' if baking else 'out',
        )
        extra_inputs: list = [(path, self.LOOP_IMAGE) for path in png_paths]
        if baking:
            stage, stage_inputs = self._bake_stage(
                request, brolls, time_map, window_start_ms, target_width, target_height, fps,
                first_index=1 + len(overlays),
            )
            filter_complex += stage
            extra_inputs += stage_inputs
        if music:
            extra_inputs.append((music['path'], self.LOOP_AUDIO))
        if voiceover:
            extra_inputs.append((voiceover['path'], self.PLAIN_FILE))

        try:
            await self._run_ffmpeg_complex(
                input_path=request.video_path,
                output_path=request.output_path,
                start_time_ms=window_start_ms,
                duration_ms=window_ms,
                filter_complex=filter_complex,
                audio_label="[aout]" if has_audio else None,
                extra_inputs=extra_inputs if extra_inputs else None,
                fps=fps,
                output_size=(target_width, target_height),
                output_duration_ms=scaled_duration_ms(time_map.output_ms, request.video_speed),
                **({'progress': lambda percent: request.progress_callback('Rendering video', percent)} if request.progress_callback else {}),
            )
        finally:
            # Only generated rasters are disposable; logo/b-roll/music/intro
            # files are user assets owned by main.
            for path in png_paths:
                try:
                    os.remove(path)
                except OSError:
                    pass

        if not os.path.isfile(request.output_path):
            raise RenderingError("Render failed: output file not created")
        if request.intro_path:
            await self._concat_intro(request, target_width, target_height, fps, has_audio)
        if request.outro_path:
            await self._concat_outro(request, target_width, target_height, fps, has_audio)

    # Brand overlays sit this many output pixels from the frame edge.
    BRAND_MARGIN_PX = 34
    # Shared x/y expressions per corner; W/H resolve against the composited frame.
    BRAND_POSITIONS = {
        'top-left': (str(BRAND_MARGIN_PX), str(BRAND_MARGIN_PX)),
        'top-right': (f'W-w-{BRAND_MARGIN_PX}', str(BRAND_MARGIN_PX)),
        'bottom-left': (str(BRAND_MARGIN_PX), f'H-h-{BRAND_MARGIN_PX}'),
        'bottom-right': (f'W-w-{BRAND_MARGIN_PX}', f'H-h-{BRAND_MARGIN_PX}'),
        'center': ('(W-w)/2', '(H-h)/2'),
    }

    @classmethod
    def _brand_positions(cls, margin_px: int) -> dict:
        """Corner positions at a custom inset, for safe-zone brand placement."""
        m = str(margin_px)
        return {
            'top-left': (m, m),
            'top-right': (f'W-w-{m}', m),
            'bottom-left': (m, f'H-h-{m}'),
            'bottom-right': (f'W-w-{m}', f'H-h-{m}'),
            'center': ('(W-w)/2', '(H-h)/2'),
        }

    @classmethod
    def _brand_margin_px(cls, margin, target_width: int) -> int:
        """An overlay's safe-zone inset (fraction of output width) in pixels."""
        if isinstance(margin, (int, float)) and not isinstance(margin, bool) and 0 <= margin <= 0.5:
            return max(8, round(target_width * margin))
        return cls.BRAND_MARGIN_PX

    def _brand_overlays(self, request: RenderRequest, target_width: int, target_height: int,
                        time_map: TimeMap, window_start_ms: int, font_size: int) -> list[Overlay]:
        """Logo watermark and CTA badges, appended after title/banner so they sit on top.

        The enable expressions of timed badges run on the edited (pre-speed)
        clock, the same one the overlay chain composites on.
        """
        overlays: list[Overlay] = []
        logo = request.logo if request.logo and request.logo.get('path') else None
        if logo:
            path = self._logo_overlay_image(logo['path'], request, target_width)
            positions = self._brand_positions(self._brand_margin_px(logo.get('margin'), target_width))
            x, y = positions.get(logo.get('position'), positions['top-left'])
            try:
                width = max(2, round(target_width * float(logo['scale'])))
            except (KeyError, TypeError, ValueError):
                width = max(2, round(target_width * 0.1))
            chain = f'scale=w={width}:h=-2:flags=lanczos'
            opacity = logo.get('opacity', 1)
            if isinstance(opacity, (int, float)) and opacity < 1:
                chain += f',format=rgba,colorchannelmixer=aa={max(.1, float(opacity)):.3g}'
            overlays.append((path, x, y, '1', chain))
        for i, badge in enumerate(request.cta_badges or []):
            kind = badge.get('kind')
            if kind not in ('subscribe', 'follow'):
                continue
            spans = []
            if badge.get('start_ms') is not None:
                spans = self._mapped_spans(badge['start_ms'], badge['end_ms'], window_start_ms, time_map, 1.0)
                if not spans:
                    continue  # The whole interval was cut; draw nothing and consume no input.
            path = self._badge_overlay_image(kind, font_size, os.path.join(
                os.path.dirname(request.output_path),
                f'badge-{kind}-{i}-{request.start_time_ms}-{request.end_time_ms}.png',
            ))
            x, y = self._brand_positions(self._brand_margin_px(badge.get('margin'), target_width)).get(
                badge.get('position'), self.BRAND_POSITIONS['bottom-right'])
            if spans:
                enable = '+'.join(f'between(t,{s:.3f},{e:.3f})' for s, e in spans)
                overlays.append((path, x, y, enable, 'null'))
            else:
                overlays.append((path, x, y))
        return overlays

    def _logo_overlay_image(self, source: str, request: RenderRequest, target_width: int) -> str:
        """Normalize a user logo to a PNG we can blend.

        Always regenerated: the overlay chain deletes its rasters after FFmpeg
        runs, and a JPEG or palette PNG has no alpha to fade, which the opacity
        slider needs. The user's asset in the run folder is never touched.
        """
        path = os.path.join(
            os.path.dirname(request.output_path),
            f"logo-{request.start_time_ms}-{request.end_time_ms}.png",
        )
        try:
            with Image.open(source) as image:
                image.convert('RGBA').save(path, 'PNG')
        except Exception as error:
            raise RenderingError('The logo image could not be read') from error
        return path

    CTA_BADGE_LABELS = {'subscribe': 'SUBSCRIBE', 'follow': 'FOLLOW'}
    # YouTube red and the Instagram purple→orange gradient, as (from, to) corners.
    CTA_BADGE_COLORS = {'subscribe': ((255, 0, 0, 255), (224, 0, 0, 255)),
                        'follow': ((131, 58, 180, 255), (252, 170, 56, 255))}

    def _badge_overlay_image(self, kind: str, font_size: int, path: str) -> str:
        """Draw a SUBSCRIBE / FOLLOW badge as a transparent PNG.

        Pillow like the channel banner: the bundled static FFmpeg has no
        drawtext, so text filters fail there.
        """
        text = self.CTA_BADGE_LABELS[kind]
        try:
            font = ImageFont.truetype(self._font_path, font_size)
        except Exception:
            font = ImageFont.load_default()
        bbox = ImageDraw.Draw(Image.new('RGBA', (1, 1))).textbbox((0, 0), text, font=font)
        text_w, text_h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        pad_x, pad_y = round(font_size * .55), round(font_size * .35)
        width, height = text_w + pad_x * 2, text_h + pad_y * 2
        first, last = self.CTA_BADGE_COLORS[kind]
        badge = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        gradient = Image.new('RGB', (width, height))
        gradient_draw = ImageDraw.Draw(gradient)
        for x in range(width):
            stop = x / max(1, width - 1)
            gradient_draw.line((x, 0, x, height), fill=tuple(
                round(a + (b - a) * stop) for a, b in zip(first[:3], last[:3])))
        mask = Image.new('L', (width, height), 0)
        ImageDraw.Draw(mask).rounded_rectangle([(0, 0), (width - 1, height - 1)], radius=height // 2, fill=255)
        badge.paste(gradient, (0, 0), mask)
        draw = ImageDraw.Draw(badge)
        origin = ((width - text_w) // 2 - bbox[0], (height - text_h) // 2 - bbox[1])
        draw.text((origin[0] + 2, origin[1] + 2), text, font=font, fill=(0, 0, 0, 96))
        draw.text(origin, text, font=font, fill=(255, 255, 255, 255))
        badge.save(path, 'PNG')
        return path

    def _mapped_spans(self, start_ms: int, end_ms: int, window_start_ms: int, time_map: TimeMap, speed: float):
        """A source-time interval as final-clock second spans; [] if fully cut.

        The same mapping caption suppression uses: source → kept-output time
        (each user cut shifts and shortens the interval), then ÷ video_speed
        because this stage runs after the speed filter.
        """
        a, b = start_ms - window_start_ms, end_ms - window_start_ms
        spans = []
        offset = 0
        for ks, ke in time_map.keeps:
            s, e = max(a, ks), min(b, ke)
            if e > s:
                spans.append(((offset + s - ks) / 1000 / speed, (offset + e - ks) / 1000 / speed))
            offset += ke - ks
        return spans

    def _bake_stage(self, request: RenderRequest, brolls: list, time_map: TimeMap, window_start_ms: int,
                    out_w: int, out_h: int, fps: str, first_index: int) -> tuple[str, list]:
        """B-roll inserts and timed text cards over the sped-up picture.

        Consumes [pre_bake] and emits [out]; enable expressions and ASS events
        run on the final output clock. Returns the graph suffix and its extra
        inputs (path, input options).
        """
        parts: list[str] = []
        specs: list = []
        cur = '[pre_bake]'
        index = first_index
        # Range Effects land on the footage before any overlay, on the final clock.
        for effect in getattr(request, 'range_edits', None) or []:
            spans = self._mapped_spans(effect['start_ms'], effect['end_ms'], window_start_ms, time_map,
                                       request.video_speed)
            if not spans:
                continue
            enable = '+'.join(f'between(t,{s:.3f},{e:.3f})' for s, e in spans)
            cur = self._range_edit_chain(cur, effect, enable, index)
            index += 1
        for roll in brolls:
            spans = self._mapped_spans(roll['start_ms'], roll['end_ms'], window_start_ms, time_map,
                                       request.video_speed)
            if not spans:
                specs.append((roll['path'], self.LOOP_IMAGE if self._is_image_asset(roll['path']) else self.PLAIN_FILE))
                index += 1
                continue  # The interval was cut; the input keeps its index.
            enable = '+'.join(f'gte(t,{s:.3f})*lt(t,{e:.3f})' for s, e in spans)
            fit = f"scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h},setsar=1"
            is_image = self._is_image_asset(roll['path'])
            if is_image:
                full, placement = fit, ""
            else:
                # A video insert plays from its own start inside the first
                # span; its audio is simply not mapped (muted).
                full = f"{fit},fps={fps},setpts=PTS-STARTPTS+{spans[0][0]:.3f}/TB"
                placement = ":repeatlast=0"
            specs.append((roll['path'], self.LOOP_IMAGE if is_image else self.PLAIN_FILE))
            layout = roll.get('layout') if roll.get('layout') in ('pip', 'split') else 'fill'
            if layout == 'split' and out_h <= out_w:
                layout = 'fill'  # Split stacks vertically; landscape keeps fill.
            if layout == 'pip':
                # The B-roll plays behind while the speaker shrinks into a
                # corner window: two overlays over a split of the footage.
                win_w, win_h = round(out_w * .38 / 2) * 2, round(out_h * .30 / 2) * 2
                margin = round(out_w * .04)
                speaker = f"scale={win_w}:{win_h}:force_original_aspect_ratio=increase,crop={win_w}:{win_h},setsar=1"
                parts.append(f";{cur}split=2[spkbase{index}][spksrc{index}]")
                parts.append(f";[{index}:v]{full}[broll{index}]")
                parts.append(f";[spkbase{index}][broll{index}]overlay=0:0{placement}:enable='{enable}'[pipbg{index}]")
                parts.append(f";[spksrc{index}]{speaker}[spkwin{index}]")
                parts.append(f";[pipbg{index}][spkwin{index}]overlay={out_w - win_w - margin}:{out_h - win_h - round(margin * 1.6)}:enable='{enable}'[baked{index}]")
            elif layout == 'split':
                # Speaker and B-roll stack top/bottom; swap flips the stack.
                swap = bool(roll.get('swap'))
                half_h = round(out_h / 4) * 2
                half = f"scale={out_w}:{half_h}:force_original_aspect_ratio=increase,crop={out_w}:{half_h},setsar=1"
                half_broll = half if is_image else f"{half},fps={fps},setpts=PTS-STARTPTS+{spans[0][0]:.3f}/TB"
                parts.append(f";{cur}split=2[spkbase{index}][spksrc{index}]")
                parts.append(f";[spksrc{index}]{half}[spkhalf{index}]")
                parts.append(f";[{index}:v]{half_broll}[brollhalf{index}]")
                top, bottom = (f"brollhalf{index}", f"spkhalf{index}") if swap else (f"spkhalf{index}", f"brollhalf{index}")
                parts.append(f";[spkbase{index}][{top}]overlay=0:0:enable='{enable}'[splittop{index}]")
                parts.append(f";[splittop{index}][{bottom}]overlay=0:{half_h}:enable='{enable}'[baked{index}]")
            else:
                parts.append(f";[{index}:v]{full}[broll{index}]")
                parts.append(f";{cur}[broll{index}]overlay=0:0{placement}:enable='{enable}'[baked{index}]")
            cur = f'[baked{index}]'
            index += 1
        styled_boxes: list[tuple[dict, list]] = []
        for box in request.text_overlays or []:
            if not box.get('style'):
                continue
            spans = self._mapped_spans(box['start_ms'], box['end_ms'], window_start_ms, time_map,
                                       request.video_speed)
            if not spans:
                continue
            card_path = os.path.join(os.path.dirname(request.output_path),
                                     f"text-box-{len(styled_boxes)}-{box['start_ms']}.png")
            card = self._build_text_box_card(box, out_w, out_h, card_path)
            styled_boxes.append((box, [card, spans]))
        if styled_boxes:
            stacks: dict = {}
            for box, (card, spans) in styled_boxes:
                position = box.get('position') or 'bottom-left'
                stack = stacks.get(position, 0)
                stacks[position] = stack + 1
                x, y = self._text_box_anchor(position, out_w, out_h, card['width'], card['height'], stack)
                enable = '+'.join(f'between(t,{s:.3f},{e:.3f})' for s, e in spans)
                specs.append((card['path'], self.LOOP_IMAGE))
                parts.append(f";{cur}[{index}:v]overlay={x}:{y}:enable='{enable}'[baked{index}]")
                cur = f'[baked{index}]'
                index += 1
        if request.text_overlays:
            # 'image'-variant Lower Thirds: the user's picture becomes the band
            # behind the text, drawn before the ASS text (which skips its rect).
            for item in request.text_overlays:
                if not (item.get('preset') and item.get('variant') == 'image' and item.get('image')):
                    continue
                band = self.lower_third_band(item['preset'], item.get('position', 'bottom-left'), out_w, out_h)
                spans = self._mapped_spans(item['start_ms'], item['end_ms'], window_start_ms, time_map,
                                           request.video_speed)
                if not band or not spans:
                    continue
                enable = '+'.join(f'gte(t,{s:.3f})*lt(t,{e:.3f})' for s, e in spans)
                specs.append((item['image'], self.LOOP_IMAGE))
                strip = (f"scale={out_w}:{band[1]}:force_original_aspect_ratio=increase,"
                         f"crop={out_w}:{band[1]},colorchannelmixer=aa=.88")
                parts.append(f";[{index}:v]{strip}[ltband{index}]")
                parts.append(f";{cur}[ltband{index}]overlay=0:{band[0]}:enable='{enable}'[baked{index}]")
                cur = f'[baked{index}]'
                index += 1
            ass_path = self._text_overlay_ass(request, out_w, out_h, time_map, window_start_ms)
            parts.append(f";{cur}{self._caption_filter(ass_path)}[baked_text]")
            cur = '[baked_text]'
        parts.append(f";{cur}null[out]")
        return ''.join(parts), specs

    @classmethod
    @staticmethod
    def _range_edit_chain(cur: str, effect: dict, enable: str, index: int) -> str:
        """One Range Effect as graph parts; consumes `cur`, emits [rge{index}].

        Color filters carry the timeline `enable` themselves; the region blur
        crops the region, blurs it, and overlays it back while enabled.
        """
        kind, intensity = effect['kind'], effect['intensity']
        out = f'rge{index}'
        if kind == 'blur':
            x, y, w, h = effect.get('region') or (0.0, 0.0, 1.0, 1.0)
            return (''.join([
                f';{cur}split=2[rgebase{index}][rgesrc{index}]',
                f';[rgesrc{index}]crop=iw*{w:.4f}:ih*{h:.4f}:iw*{x:.4f}:ih*{y:.4f},gblur=sigma={6 + 18 * intensity:.1f}[rgeblur{index}]',
                f";[rgebase{index}][rgeblur{index}]overlay=iw*{x:.4f}:ih*{y:.4f}:enable='{enable}'[{out}]"
            ]))
        if kind == 'warm':
            filters = (f'colorbalance=rs={.28 * intensity:.3f}:bs={-.28 * intensity:.3f},'
                       f'hue=s={1 + .25 * intensity:.3f}')
        elif kind == 'cool':
            filters = (f'colorbalance=rs={-.22 * intensity:.3f}:bs={.28 * intensity:.3f},'
                       f'hue=s={1 + .15 * intensity:.3f}')
        elif kind == 'cinematic':
            # An S-curve for contrast (the LGPL way; `eq` is GPL-only), plus muted colors.
            filters = (f"curves=all='0/0 {0.5 - .05 * intensity:.3f}/{0.5 - .08 * intensity:.3f} 1/1',"
                       f'hue=s={1 - .18 * intensity:.3f}')
        elif kind == 'bw':
            filters = f'hue=s={max(0.0, 1 - intensity):.3f}'
        elif kind == 'sharpen':
            filters = f'unsharp=5:5:{.4 + 1.6 * intensity:.2f}:5:5:0'
        else:  # soften
            filters = f'gblur=sigma={1 + 5 * intensity:.2f}'
        return f";{cur}{filters}:enable='{enable}'[{out}]"

    @classmethod
    def _is_image_asset(cls, path: str) -> bool:
        return os.path.splitext(path)[1].lower().lstrip('.') in cls.IMAGE_EXTENSIONS

    @staticmethod
    def lower_third_band(preset: str, position: str, out_w: int, out_h: int):
        """Full-width band rect (y, height) for band presets; None otherwise.

        Shared by the ASS drawings and the 'image' variant's overlay input in
        the bake graph, so the picture band and the text sit on one strip.
        """
        spec = LOWER_THIRDS.get(preset)
        if not spec or not spec['band']:
            return None
        height = max(48, round(out_h * (.15 if spec['sub'] else .12)))
        if position in ('top-left', 'top-right'):
            y = round(out_h * .07)
        elif position == 'center':
            y = round(out_h * .60)
        else:
            y = out_h - height - round(out_h * .07)
        return y, height

    def _lower_third_events(self, item: dict, spans: list, out_w: int, out_h: int, positions: dict, styles: dict) -> list:
        """One Lower Third overlay as layered ASS lines: band/edge drawings behind, text in front.

        Every layer of an overlay shares the preset's entrance animation so the
        whole card moves together. The 'image' variant skips the drawn band —
        the bake graph overlays the user's picture on the same strip instead.
        """
        spec = LOWER_THIRDS[item['preset']]
        variant = item.get('variant') or 'solid'
        font = max(14, round(out_h * spec['size']))
        line = round(font * 1.3)
        margin = max(8, round(out_w * .04))
        an, x, y = positions.get(item.get('position'), (5, out_w // 2, out_h // 2))
        def clean(value):
            text = ''.join(char for char in str(value) if char not in '{}\\').replace('\n', ' ').strip()
            return text.upper() if spec['upper'] else text
        main = clean(item['text'])
        if not main:
            return []
        sub = clean(item.get('sub') or '') if spec['sub'] else ''
        accent = item['color'] if variant == 'color' and item.get('color') else spec['accent']
        background = item['color'] if variant == 'color' and item.get('color') else spec['bg']
        band = self.lower_third_band(item['preset'], item.get('position', 'bottom-left'), out_w, out_h)
        image_band = band and variant == 'image' and bool(item.get('image'))

        def anim_tag(px, py):
            if spec['anim'] == 'rise':
                return f'\\move({px},{py},{px},{py - round(out_h * .035)},0,260)\\fad(220,180)'
            if spec['anim'] == 'slide':
                return f'\\move({px + round(out_w * .07)},{py},{px},{py},0,280)\\fad(240,180)'
            if spec['anim'] == 'pop':
                return f'\\pos({px},{py})\\fscx72\\fscy72\\t(0,200,\\fscx100\\fscy100)\\fad(130,150)'
            return f'\\pos({px},{py})\\fad(220,180)'

        def rect(start, end, px, py, width, height, color, alpha=0):
            return (f"Dialogue: 0,{self._ass_time(start)},{self._ass_time(end)},Default,,0,0,0,,"
                    f"{{\\p1\\pos({px},{py}){anim_tag(px, py)}\\1c{ass_color(color, alpha)}}}"
                    f"m 0 0 l {width} 0 {width} {height} 0 {height}{{\\p0}}")

        events = []
        if band and not image_band:
            y_band, h_band = band
            alpha = 0x30 if item['preset'] == 'loc-spotlight' else 0
            an, x, y = (4, margin, y_band + h_band // 2) if an in (1, 4, 7) \
                else (6, out_w - margin, y_band + h_band // 2) if an in (3, 6, 9) \
                else (5, out_w // 2, y_band + h_band // 2)
            for s, e in spans:
                events.append(rect(s, e, 0, y_band, out_w, h_band, background, alpha))
        elif spec['edge'] == 'under':
            for s, e in spans:
                events.append(rect(s, e, x, y + round(font * .28), round(out_w * .16), max(4, round(out_h * .007)), accent))
        elif spec['edge'] == 'left':
            rows = 2 if sub else 1
            tab_w, pad = max(6, round(out_w * .011)), max(3, round(font * .28))
            for s, e in spans:
                events.append(rect(s, e, x - tab_w - pad, y - rows * line - pad, tab_w, rows * line + 2 * pad, accent))
        main_style = self._lower_third_style(styles, item['preset'], 'main' if not (band and image_band) else 'image', background)
        sub_style = self._lower_third_style(styles, item['preset'], 'sub', background) if sub else None
        for s, e in spans:
            tag = anim_tag(x, y)
            events.append(f"Dialogue: 1,{self._ass_time(s)},{self._ass_time(e)},{main_style},,0,0,0,,{{\\an{an}{tag}}}{main}")
            if sub and sub_style:
                # Bottom anchors grow upward: the secondary line stacks above the main one.
                sub_y = y - line if an in (1, 4) else y + line
                events.append(f"Dialogue: 1,{self._ass_time(s)},{self._ass_time(e)},{sub_style},,0,0,0,,"
                              f"{{\\an{an}{anim_tag(x, sub_y)}}}{sub}")
        return events

    def _lower_third_style(self, styles: dict, preset: str, role: str, background: str) -> str:
        """Register (once) and return the ASS style name for a preset/role/background."""
        name = f'LT-{preset}-{role}-{background.lstrip("#")}'
        if name not in styles:
            styles[name] = (preset, role, background)
        return name

    def _lower_third_style_line(self, name: str, preset: str, role: str, background: str,
                                out_w: int, out_h: int, margin: int) -> str:
        spec = LOWER_THIRDS[preset]
        font = max(12, round(out_h * spec['size'] * (.62 if role == 'sub' else 1)))
        outline = max(2, round(font * .06))
        if spec['box'] == 'fill':
            # BorderStyle=3: an opaque text-extent box in the preset's background;
            # Outline doubles as the box padding around the text.
            pad = max(6, round(font * .22))
            return (f"Style: {name},Arial,{font},{ass_color(spec['fg'])},&H000000FF,{ass_color(spec['fg'])},"
                    f"{ass_color(background)},-1,0,0,0,100,100,0,0,3,{pad},0,5,{margin},{margin},{margin},1")
        # Text carries a black outline for readability over footage and picture bands.
        return (f"Style: {name},Arial,{font},{ass_color(spec['fg'])},&H000000FF,&H00000000,&H80000000,"
                f"-1,0,0,0,100,100,0,0,1,{outline},0,5,{margin},{margin},{margin},1")

    def _build_text_box_card(self, item: dict, out_w: int, out_h: int, path: str) -> dict:
        """One styled text box as a rounded-card PNG (font/size/color/radius/padding/align)."""
        from PIL import Image, ImageDraw, ImageFont
        style = item['style']
        text = ''.join(char for char in item['text'] if char not in '{}\\').strip()
        if not text:
            raise RenderingError('A styled text box has no text')
        size_px = max(14, round(out_h * style['size']))
        font = ImageFont.truetype(_resolve_box_font(style['font']), size_px)
        measure = ImageDraw.Draw(Image.new('RGBA', (4, 4)))
        pad = round(size_px * 0.45 * style['padding'])
        max_width = round(out_w * .88) - pad * 2
        lines = _wrap_box_lines(measure, text, font, max_width)
        widths = [measure.textlength(line, font=font) for line in lines]
        text_w, text_h = round(max(widths)), round(len(lines) * size_px * 1.28)
        card_w, card_h = text_w + pad * 2, text_h + pad * 2
        card = Image.new('RGBA', (card_w, card_h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(card)
        draw.rounded_rectangle([(0, 0), (card_w - 1, card_h - 1)], radius=round(style['radius'] * (out_w / 1080)),
                               fill=_hex_rgba(style['background'], 235))
        y = pad
        for line, width in zip(lines, widths):
            x = pad if style['align'] == 'left' else card_w - pad - width if style['align'] == 'right' else (card_w - width) // 2
            draw.text((x, y), line, font=font, fill=_hex_rgba(style['color']))
            y += round(size_px * 1.28)
        card.save(path, 'PNG')
        # Anchor + stack offset resolve later; the card only carries its size.
        return {'path': path, 'width': card_w, 'height': card_h}

    def _text_box_anchor(self, position: str, out_w: int, out_h: int, card_w: int, card_h: int, stack: int):
        margin = max(10, round(out_w * .04))
        x = margin if 'left' in position else out_w - card_w - margin if 'right' in position else (out_w - card_w) // 2
        y = margin if position.startswith('top') else out_h - card_h - margin if position.startswith('bottom') else (out_h - card_h) // 2
        # Same-anchor boxes stack vertically so several can share the screen.
        return x, y + stack * (card_h + round(out_h * .015))

    def _text_overlay_ass(self, request: RenderRequest, out_w: int, out_h: int, time_map: TimeMap,
                          window_start_ms: int) -> str:
        """Editor text cards and Lower Thirds as one ASS file on the final clock.

        Plain cards keep one clean style (bold white, black outline); Lower Third
        presets add layered animated events. ASS keeps unicode safe where the
        static FFmpeg builds have no drawtext.
        """
        font = max(16, round(out_h * .05))
        margin = max(8, round(out_w * .04))
        positions = {
            'top-left': (7, margin, margin), 'top-right': (9, out_w - margin, margin),
            'bottom-left': (1, margin, out_h - margin), 'bottom-right': (3, out_w - margin, out_h - margin),
            'center': (5, out_w // 2, out_h // 2),
        }
        events, styles = [], {}
        for item in request.text_overlays:
            spans = self._mapped_spans(item['start_ms'], item['end_ms'], window_start_ms, time_map,
                                       request.video_speed)
            if not spans:
                continue
            if item.get('preset') in LOWER_THIRD_IDS:
                events.extend(self._lower_third_events(item, spans, out_w, out_h, positions, styles))
                continue
            if item.get('style'):
                continue  # Styled text boxes render as generated card overlays in the bake stage.
            text = ''.join(char for char in item['text'] if char not in '{}\\')
            text = text.replace('\n', '\\N').strip()
            if not text:
                continue
            an, x, y = positions.get(item.get('position'), (5, out_w // 2, out_h // 2))
            for s, e in spans:
                events.append(f"Dialogue: 0,{self._ass_time(s)},{self._ass_time(e)},Default,,0,0,0,,{{\\an{an}"
                              f"\\pos({x},{y})}}{text}")
        path = os.path.join(
            os.path.dirname(request.output_path),
            f"text-overlays-{request.start_time_ms}-{request.end_time_ms}.ass",
        )
        outline = max(2, round(font * .06))
        with open(path, 'w', encoding='utf-8') as f:
            f.write("[Script Info]\nScriptType: v4.00+\nPlayResX: {}\nPlayResY: {}\nWrapStyle: 0\n\n"
                    .format(out_w, out_h))
            f.write("[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
                    "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, "
                    "Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n")
            f.write(f"Style: Default,Arial,{font},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,"
                    f"0,0,1,{outline},0,5,{margin},{margin},{margin},1\n")
            for name, (preset, role, background) in sorted(styles.items()):
                f.write(self._lower_third_style_line(name, preset, role, background, out_w, out_h, margin) + '\n')
            f.write("\n[Events]\n"
                    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
            f.write('\n'.join(events) + '\n')
        return path

    @staticmethod
    def _ass_time(seconds: float) -> str:
        cs = max(0, round(seconds * 100))
        return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"

    async def _concat_intro(self, request: RenderRequest, out_w: int, out_h: int, fps: str, main_audio: bool) -> None:
        """Prepend the intro video: re-encode it onto the clip's size/fps/SAR
        and audio layout, then concat in one command (the baked part keeps its
        already-normalized audio; no loudnorm is applied to the pair)."""
        intro, main = request.intro_path, request.output_path
        intro_ms = await self._probe_duration_ms(intro)
        if not intro_ms:
            raise RenderingError("Could not read the intro video")
        intro_audio = await self._has_audio(intro)
        main_ms = await self._probe_duration_ms(main)
        graph = (
            f"[0:v]fps={fps},scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,"
            f"pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[intro_v];"
            f"[1:v]fps={fps},setsar=1,format=yuv420p[main_v];"
        )
        if intro_audio:
            graph += (f"[0:a]{AUDIO_FORMAT},{AUDIO_SYNC},apad,atrim=end={intro_ms / 1000:.3f},"
                      f"asetpts=PTS-STARTPTS,asettb=1/48000[intro_a];")
        else:
            graph += f"anullsrc=r=48000:cl=stereo:d={intro_ms / 1000:.3f},asettb=1/48000[intro_a];"
        if main_audio:
            graph += f"[1:a]{AUDIO_FORMAT},asettb=1/48000,asetpts=N[main_a];"
        else:
            graph += f"anullsrc=r=48000:cl=stereo:d={main_ms / 1000:.3f},asettb=1/48000[main_a];"
        graph += "[intro_v][intro_a][main_v][main_a]concat=n=2:v=1:a=1[vout][aout]"
        with_audio = main_audio or intro_audio
        temporary = main + ".intro.partial.mp4"
        cmd = [
            "ffmpeg", "-nostdin", "-v", "error", "-y",
            *MEDIA_INPUT_OPTIONS, "-i", intro,
            *MEDIA_INPUT_OPTIONS, "-i", main,
            "-filter_complex", graph,
            "-map", "[vout]",
            *self._video_codec_args(out_w, out_h, fps),
            "-pix_fmt", "yuv420p", "-r", fps, "-movflags", "+faststart",
        ]
        if with_audio:
            cmd += ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]
        else:
            cmd.append("-an")
        cmd.append(temporary)
        try:
            await self._run_cmd(cmd)
            if not os.path.isfile(temporary):
                raise RenderingError("Intro concat produced no file")
            os.replace(temporary, main)
        finally:
            if os.path.isfile(temporary):
                os.remove(temporary)

    async def _concat_outro(self, request: RenderRequest, out_w: int, out_h: int, fps: str, main_audio: bool) -> None:
        """Append the outro video: re-encode it onto the clip's size/fps/SAR and
        audio layout, then concat in one command (the main keeps its
        already-normalized audio; no loudnorm on the pair)."""
        outro, main = request.outro_path, request.output_path
        outro_ms = await self._probe_duration_ms(outro)
        if not outro_ms:
            raise RenderingError("Could not read the outro video")
        outro_audio = await self._has_audio(outro)
        main_ms = await self._probe_duration_ms(main)
        graph = (
            f"[0:v]fps={fps},setsar=1,format=yuv420p[main_v];"
            f"[1:v]fps={fps},scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,"
            f"pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[outro_v];"
        )
        if main_audio:
            graph += f"[0:a]{AUDIO_FORMAT},asettb=1/48000,asetpts=N[main_a];"
        else:
            graph += f"anullsrc=r=48000:cl=stereo:d={main_ms / 1000:.3f},asettb=1/48000[main_a];"
        if outro_audio:
            graph += f"[1:a]{AUDIO_FORMAT},apad,atrim=end={outro_ms / 1000:.3f},asetpts=PTS-STARTPTS,asettb=1/48000[outro_a];"
        else:
            graph += f"anullsrc=r=48000:cl=stereo:d={outro_ms / 1000:.3f},asettb=1/48000[outro_a];"
        graph += "[main_v][main_a][outro_v][outro_a]concat=n=2:v=1:a=1[vout][aout]"
        with_audio = main_audio or outro_audio
        temporary = main + ".outro.partial.mp4"
        cmd = [
            "ffmpeg", "-nostdin", "-v", "error", "-y",
            *MEDIA_INPUT_OPTIONS, "-i", main,
            *MEDIA_INPUT_OPTIONS, "-i", outro,
            "-filter_complex", graph,
            "-map", "[vout]",
            *self._video_codec_args(out_w, out_h, fps),
            "-pix_fmt", "yuv420p", "-r", fps, "-movflags", "+faststart",
        ]
        if with_audio:
            cmd += ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]
        else:
            cmd.append("-an")
        cmd.append(temporary)
        try:
            await self._run_cmd(cmd)
            if not os.path.isfile(temporary):
                raise RenderingError("Outro concat produced no file")
            os.replace(temporary, main)
        finally:
            if os.path.isfile(temporary):
                os.remove(temporary)

    async def _probe_duration_ms(self, path: str) -> int:
        cmd = ["ffprobe", "-v", "error", *MEDIA_INPUT_OPTIONS, "-show_entries", "format=duration",
               "-of", "csv=p=0", path]
        try:
            result = await asyncio.to_thread(run_media, cmd, timeout=PROBE_TIMEOUT_SECONDS)
            return max(0, int(round(float(result.stdout.decode().strip()) * 1000)))
        except Exception as e:
            logger.warning(f"Duration probe failed for {os.path.basename(path)}: {e}")
            return 0

    async def _plan_layout(
        self,
        request: RenderRequest,
        source_w: int,
        source_h: int,
        window_start_ms: int,
        window_ms: int,
    ) -> Optional[ClipLayoutPlan]:
        """Analyze the render window's shots. None means use the letterbox."""
        if request.layout_style == LayoutStyle.FIT:
            return None
        try:
            return await self.layout_analyzer.analyze(
                request.video_path, window_start_ms, window_ms, source_w, source_h, request.layout_style,
                **({"capture": True} if request.debug_capture else {}),
                **({'progress': lambda detail, percent: request.progress_callback(
                    detail if percent is None else f'{detail} {percent}%', None)} if request.progress_callback else {}),
            )
        except Exception as e:
            logger.warning(f"Layout analysis failed, falling back to letterbox: {e}", exc_info=True)
            return None

    async def _content_plan(
        self,
        request: RenderRequest,
        source_w: int,
        source_h: int,
        window_start_ms: int,
        window_ms: int,
    ) -> Optional[ClipLayoutPlan]:
        """Heuristic shot analysis for pacing only (no paid vision call). None if unavailable.

        Pacing needs to know what is on screen, not exact camera cuts, so the
        every-frame camera scan is skipped (16:9 output, Classic style).
        """
        try:
            return await self.layout_analyzer.analyze(
                request.video_path, window_start_ms, window_ms, source_w, source_h, LayoutStyle.AUTO, vision=False,
                precise=False, **({"capture": True} if request.debug_capture else {}),
            )
        except Exception as e:
            logger.warning(f"Content analysis for pacing failed; using the default pause limit: {e}", exc_info=True)
            return None

    @staticmethod
    def _paces(request: RenderRequest) -> bool:
        """Whether tight pacing will cut anything (it needs word timings)."""
        return request.pacing == Pacing.TIGHT and bool(request.transcript_segments)

    @staticmethod
    def _keep_intervals(
        request: RenderRequest,
        plan: Optional[ClipLayoutPlan],
        window_start_ms: int,
        window_ms: int,
    ) -> list[tuple[int, int]]:
        """Window intervals to keep. `plan` is None when shot content is unknown."""
        if not RenderingService._paces(request):
            return [(0, window_ms)]
        words = window_words(request.transcript_segments, window_start_ms, window_ms)
        protected = reaction_intervals(request.transcript_segments, window_start_ms, window_ms)
        protected += window_protection(request.editorial_context or {}, window_start_ms, window_ms)
        return compute_keep_intervals(words, window_ms, plan, protected, longform=request.longform)

    def _overlays(
        self,
        request: RenderRequest,
        out_plan: ClipLayoutPlan,
        target_width: int,
        target_height: int,
        is_landscape: bool,
        time_map: TimeMap,
        window_start_ms: int,
    ) -> list[Overlay]:
        """Title card and channel banner, positioned per shot on the output timeline.

        Editor brand overlays (logo watermark, CTA badges) come last so they
        composite above the burned captions, title and banner.
        """
        src_w, src_h = out_plan.source_width, out_plan.source_height
        overlays: list[Overlay] = []
        # Landscape overlays were sized for 1080p; scale them with the output.
        scale = target_height / 1080 if is_landscape else 1.0
        title = self._title_overlay_image(request, target_width, scale)
        if title:
            path, _, height = title
            if is_landscape:
                show_from, show_to = LANDSCAPE_TITLE_SHOW_S
                fade = LANDSCAPE_TITLE_FADE_S
                overlays.append((
                    path, "(W-w)/2", f"{round(40 * scale)}",
                    f"between(t,{show_from},{show_to})",
                    f"format=rgba,fade=t=in:st={show_from}:d={fade}:alpha=1,"
                    f"fade=t=out:st={show_to - fade}:d={fade}:alpha=1",
                ))
            else:
                overlays.append((path, "(W-w)/2", per_shot_expr(out_plan, [
                    title_y(s, src_w, src_h, target_width, target_height, height) for s in out_plan.shots
                ])))
        banner = self._banner_overlay_image(request, round(28 * scale) if is_landscape else 34)
        if banner:
            if is_landscape:
                overlays.append((banner[0], f"W-w-{round(20 * scale)}", f"H-h-{round(16 * scale)}"))
            else:
                overlays.append((banner[0], "(W-w)/2", per_shot_expr(out_plan, [
                    banner_y(s, src_w, src_h, target_width, target_height) for s in out_plan.shots
                ])))
        overlays += self._brand_overlays(request, target_width, target_height, time_map, window_start_ms,
                                         round(28 * scale) if is_landscape else 34)
        return overlays

    def _caption_graph(
        self, caption_path: Optional[str], suppressed: list[tuple[int, int]],
        window_start_ms: int, time_map: TimeMap,
    ) -> str:
        """Cover our captions with the clean frame during source-time exclusions.

        Keeping ASS on its original clock preserves karaoke, animation and linger
        across suppression boundaries. Speed is applied to this composite later.
        """
        intervals = []
        if caption_path:
            for a, b in suppressed:
                a = time_map.to_output_clamped(a - window_start_ms)
                b = time_map.to_output_clamped(b - window_start_ms)
                if b > a:
                    if intervals and a <= intervals[-1][1]:
                        intervals[-1] = (intervals[-1][0], max(b, intervals[-1][1]))
                    else:
                        intervals.append((a, b))
        caption_filter = self._caption_filter(caption_path)
        if not intervals:
            return ";[base]" + caption_filter + "[captioned]"
        # FFmpeg's expression parser rejects long addition chains (100 terms
        # on supported builds). Bound each enable expression independently while
        # drawing ASS once, so animation and linger keep their original clock.
        groups = [intervals[i:i + 32] for i in range(0, len(intervals), 32)]
        clean = ''.join(f'[caption_clean_{i}]' for i in range(len(groups)))
        graph = (f";[base]split={len(groups) + 1}[caption_input]{clean}"
                 f";[caption_input]{caption_filter}[caption_drawn_0]")
        for i, group in enumerate(groups):
            enabled = '+'.join(f'gte(t,{a / 1000:.3f})*lt(t,{b / 1000:.3f})' for a, b in group)
            output = 'captioned' if i == len(groups) - 1 else f'caption_drawn_{i + 1}'
            graph += f";[caption_drawn_{i}][caption_clean_{i}]overlay=enable='{enabled}':format=auto[{output}]"
        return graph

    def _caption_filter(self, caption_path: Optional[str]) -> str:
        """`ass=` filter for the caption file, or a no-op."""
        if caption_path and os.path.isfile(caption_path):
            ass = f"ass={self._escape_filter_path(caption_path)}"
            if self._fonts_dir:
                ass += f":fontsdir={self._escape_filter_path(self._fonts_dir)}"
            return ass
        return "null"

    @staticmethod
    def _compose_overlays(graph: str, overlays: list[Overlay], video_filter: str = "null",
                          output_label: str = "out") -> tuple[str, list[str]]:
        """Append image overlays to a graph ending in [captioned]; output is [out].

        Returns the full filter_complex and the extra input paths, in input
        order (the video is input 0, overlays follow).
        """
        if not overlays:
            return f"{graph};[captioned]{video_filter}[{output_label}]", []
        parts = [graph]
        current = "captioned"
        for index, overlay in enumerate(overlays, start=1):
            _, x_expr, y_expr = overlay[:3]
            label = "composited" if index == len(overlays) else f"ov{index}"
            image, enable = f"[{index}:v]", ""
            if len(overlay) == 5:
                enable_expr, image_filter = overlay[3], overlay[4]
                parts.append(f"[{index}:v]{image_filter}[img{index}]")
                image, enable = f"[img{index}]", f":enable='{enable_expr}'"
            parts.append(
                f"[{current}]{image}overlay=x='{x_expr}':y='{y_expr}':shortest=1{enable}[{label}]"
            )
            current = label
        parts.append(f"[composited]{video_filter}[{output_label}]")
        return ";".join(parts), [overlay[0] for overlay in overlays]

    def _title_overlay_image(
        self, request: RenderRequest, target_width: int, scale: float = 1.0,
    ) -> Optional[tuple[str, int, int]]:
        """Render the title card PNG. Returns (path, width, height) or None."""
        if not (request.include_title and request.title_text):
            return None
        path = os.path.join(
            os.path.dirname(request.output_path),
            f"title-{request.start_time_ms}-{request.end_time_ms}.png",
        )
        result = self._build_title_card(request.title_text, target_width, 0, path, scale)
        if not result:
            return None
        return path, result["width"], result["height"]

    async def _generate_captions(
        self,
        request: RenderRequest,
        target_width: int,
        target_height: int,
        window_start_ms: int,
        time_map: TimeMap,
        out_plan: ClipLayoutPlan,
        is_landscape: bool,
        plan: Optional[ClipLayoutPlan] = None,
    ) -> Optional[str]:
        """ASS captions on the edited timeline, positioned per shot (9:16).

        With the window-time `plan`, each caption group also moves off any
        face it would cover (see CaptionPlacer).
        """
        if not (request.include_captions and request.transcript_segments):
            return None
        segments = remap_segments(request.transcript_segments, window_start_ms, time_map)
        if not segments:
            return None
        # Auto Censor masks the caption text on the output clock; the word
        # timings stay intact, so the bleep intervals line up with the masks.
        segments = censor_transcript(segments, request.censor)

        anchors = None
        if not is_landscape:
            src_w, src_h = out_plan.source_width, out_plan.source_height
            anchors = []
            for shot in out_plan.shots:
                alignment, y = caption_anchor(shot, src_w, src_h, target_width, target_height)
                anchors.append((shot.end_ms, alignment, y))
            anchors[-1] = (10**9, anchors[-1][1], anchors[-1][2])

        placer = None
        if request.caption_y is not None:
            if type(request.caption_y) not in (int, float) or not .1 <= request.caption_y <= .9:
                raise ValueError('Invalid caption position')
            anchors = [(10**9, 5, round(target_height * request.caption_y))]
        elif anchors and plan is not None:
            zones = face_zones(plan, time_map, target_width, target_height)
            if zones:
                placer = CaptionPlacer(anchors, zones, target_width, target_height)
        # A manual horizontal center rides either branch: anchors or the placer
        # still choose the Y, the pin just moves off the center line. Absent
        # caption_x keeps today's centered pin byte-identical.
        anchor_x: Optional[int] = None
        if request.caption_x is not None:
            if type(request.caption_x) not in (int, float) or not .1 <= request.caption_x <= .9:
                raise ValueError('Invalid caption position')
            anchor_x = round(target_width * request.caption_x)

        caption_path = os.path.join(
            os.path.dirname(request.output_path),
            f"clip-{request.start_time_ms}-{request.end_time_ms}.ass",
        )
        style = request.caption_style
        if is_landscape:
            style = self._landscape_caption_style(style or self.settings.get_caption_style(), target_height)
        return await self.caption_generator.generate_captions(
            transcript_segments=segments,
            clip_start_ms=window_start_ms,
            clip_end_ms=window_start_ms + time_map.output_ms,
            output_path=caption_path,
            caption_style=style,
            output_width=target_width,
            output_height=target_height,
            anchors=anchors,
            anchor_x=anchor_x,
            emphasis_words=request.emphasis_words,
            placer=placer,
        )

    # Pixel-sized caption style fields, scaled together for landscape output.
    _CAPTION_PIXEL_FIELDS = (
        "font_size", "outline_width", "shadow_blur", "shadow_offset", "shadow_spread",
        "highlight_box_padding", "glow_radius", "glow_blur", "line_box_padding", "letter_spacing",
    )

    @classmethod
    def _landscape_caption_style(cls, style: CaptionStyle, out_h: int) -> CaptionStyle:
        """The preset resized for a 16:9 frame.

        Presets are tuned for 1080x1920, where an 84 px line is ~4% of the
        height; on 1080p landscape it would be ~8%. Scale to ~5% of the height
        and show longer phrases, which reads like subtitles across a long
        episode instead of flashing 3-word bursts.
        """
        scaled = copy.copy(style)
        factor = out_h / 1080 * 0.65
        for name in cls._CAPTION_PIXEL_FIELDS:
            value = getattr(style, name, None)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                setattr(scaled, name, max(0, round(value * factor)) if value else value)
        scaled.max_words_per_line = max(style.max_words_per_line, 6)
        return scaled

    async def _probe_fps(self, video_path: str) -> str:
        """Source frame rate as an FFmpeg rational, capped at MAX_OUTPUT_FPS.

        Keeps 24/25/30/60 fps sources at their own rate (resampling 24 fps
        film to 30 judders; 60 fps gameplay loses its smoothness). "30" when
        the probe fails or returns nonsense.
        """
        cmd = [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=avg_frame_rate,r_frame_rate", "-of", "json",
            "-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "mov,matroska,webm,avi,flv,mpegts", video_path,
        ]
        try:
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None, lambda: run_media(cmd, timeout=PROBE_TIMEOUT_SECONDS),
            )
            stream = json.loads(result.stdout or b"{}").get("streams", [{}])[0]
            for key in ("avg_frame_rate", "r_frame_rate"):
                raw = stream.get(key, "0/0")
                num, _, den = raw.partition("/")
                if not den or int(den) == 0 or int(num) == 0:
                    continue
                rate = Fraction(int(num), int(den))
                if 10 <= rate <= MAX_OUTPUT_FPS + 0.5:
                    return f"{rate.numerator}/{rate.denominator}" if rate.denominator != 1 else str(rate.numerator)
                if rate > MAX_OUTPUT_FPS:
                    return str(MAX_OUTPUT_FPS)
        except Exception as e:
            logger.warning(f"Failed to probe frame rate, using 30 fps: {e}")
        return "30"

    async def _measure_loudness(self, video_path: str, start_ms: int, duration_ms: int) -> Optional[str]:
        """First loudnorm pass over the render window; returns the linear
        second-pass filter, or None to fall back to single-pass."""
        cmd = [
            "ffmpeg", "-nostdin", "-nostats", "-hide_banner", "-nostats", "-ss", f"{start_ms / 1000:.3f}",
            "-t", f"{duration_ms / 1000:.3f}",
            "-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "mov,matroska,webm,avi,flv,mpegts", "-i", video_path,
            "-map", "0:a:0", "-vn", "-af",
            f"{AUDIO_FORMAT},{AUDIO_SYNC},loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json",
            "-f", "null", "-",
        ]
        try:
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None, lambda: run_media(cmd),
            )
            text = result.stderr.decode(errors="replace")
            # The source's metadata is printed before loudnorm's report, so use
            # the last block. A pattern spanning "input_i" backtracks
            # quadratically on crafted metadata.
            blocks = [block for block in re.findall(r"\{[^{}]*\}", text) if '"input_i"' in block]
            if result.returncode != 0 or not blocks:
                raise ValueError("no loudnorm measurement in output")
            loudness = measured_loudness_filter(json.loads(blocks[-1]))
            if loudness:
                logger.info("Two-pass loudness normalization enabled for this clip")
            return loudness
        except Exception as e:
            logger.warning(f"Loudness measurement failed; using single-pass normalization: {e}")
            return None

    async def _has_audio(self, video_path: str) -> bool:
        """Whether the source has an audio stream (the graph maps [0:a] only if so)."""
        cmd = [
            "ffprobe", "-v", "error", "-select_streams", "a",
            "-show_entries", "stream=index", "-of", "csv=p=0",
            "-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "mov,matroska,webm,avi,flv,mpegts", video_path,
        ]
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, lambda: run_media(cmd, timeout=PROBE_TIMEOUT_SECONDS))
        if result.returncode != 0:
            raise RenderingError("Could not verify the source audio track")
        return bool(result.stdout.strip())

    def _build_title_card(
        self,
        title_text: str,
        target_width: int,
        overlay_y: int,
        output_path: str,
        scale: float = 1.0,
    ) -> Optional[dict]:
        """Generate a rounded-rect PNG with title text and return positioning info."""
        # The planner is asked for 2-7 words; a runaway model title would
        # otherwise be rasterized at full length (a 20k character title is a
        # 1.4M px wide image and hundreds of MB before FFmpeg rejects it).
        clean = " ".join(title_text.split())[:MAX_TITLE_CHARS]

        if not clean:
            return None

        words = clean.split()

        if len(words) < 2:
            words = (words * 2)[:2]
        elif len(words) > 7:
            words = words[:7]

        if len(words) <= 3:
            lines = [" ".join(words)]
        else:
            mid = (len(words) + 1) // 2
            lines = [" ".join(words[:mid]), " ".join(words[mid:])]

        font_size = round(42 * scale)
        pad_x = round(28 * scale)
        pad_y = round(20 * scale)
        line_spacing = int(font_size * 1.35)
        corner_radius = round(16 * scale)

        try:
            font = ImageFont.truetype(self._font_path, font_size)
        except Exception:
            font = ImageFont.load_default()

        temp_img = Image.new("RGBA", (1, 1))
        temp_draw = ImageDraw.Draw(temp_img)

        line_widths = []
        for line in lines:
            bbox = temp_draw.textbbox((0, 0), line, font=font)
            line_widths.append(bbox[2] - bbox[0])

        max_text_w = max(line_widths)
        text_block_h = font_size + max(0, len(lines) - 1) * line_spacing

        img_w = max_text_w + pad_x * 2
        img_h = text_block_h + pad_y * 2

        img = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)

        draw.rounded_rectangle(
            [(0, 0), (img_w - 1, img_h - 1)],
            radius=corner_radius,
            fill=(255, 255, 255, 242),
        )

        for i, line in enumerate(lines):
            bbox = temp_draw.textbbox((0, 0), line, font=font)
            tw = bbox[2] - bbox[0]
            x = (img_w - tw) // 2
            y = pad_y + i * line_spacing
            draw.text((x, y), line, font=font, fill=(0, 0, 0, 255))

        img.save(output_path, "PNG")

        bar_center = overlay_y // 2
        card_y = max(10, bar_center - img_h // 2)

        return {"y": card_y, "width": img_w, "height": img_h}

    def _banner_overlay_image(self, request: RenderRequest, font_size: int) -> Optional[tuple[str, int, int]]:
        """Render the channel URL banner as a transparent PNG.

        Drawn with Pillow rather than FFmpeg's drawtext: the static FFmpeg
        builds BridgeClip ships (6.1+) omit drawtext, which made any render with
        a banner fail.

        Returns (path, width, height) or None when no banner is configured.
        """
        if not (request.banner_platform and request.banner_channel_url):
            return None
        text = request.banner_channel_url.upper().strip()
        path = os.path.join(
            os.path.dirname(request.output_path),
            f"banner-{request.start_time_ms}-{request.end_time_ms}.png",
        )
        try:
            font = ImageFont.truetype(self._font_path, font_size)
        except Exception:
            font = ImageFont.load_default()
        bbox = ImageDraw.Draw(Image.new("RGBA", (1, 1))).textbbox((0, 0), text, font=font)
        shadow = 2
        width = bbox[2] - bbox[0] + shadow + 4
        height = bbox[3] - bbox[1] + shadow + 4
        image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        origin = (2 - bbox[0], 2 - bbox[1])
        draw.text((origin[0] + shadow, origin[1] + shadow), text, font=font, fill=(0, 0, 0, 128))
        draw.text(origin, text, font=font, fill=(255, 255, 255, 255))
        image.save(path, "PNG")
        return path, width, height

    async def _get_video_dimensions(self, video_path: str) -> tuple[int, int]:
        """Get actual video dimensions using ffprobe."""
        cmd = [
            "ffprobe",
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=s=x:p=0",
            "-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "mov,matroska,webm,avi,flv,mpegts",
            video_path,
        ]
        try:
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None,
                lambda: run_media(cmd, timeout=PROBE_TIMEOUT_SECONDS)
            )
            dims = result.stdout.decode().strip().split("x")
            width, height = int(dims[0]), int(dims[1])
            validate_video_dimensions(width, height)
            return width, height
        except Exception as e:
            logger.warning(f"Failed to probe video dimensions: {e}")
            return 0, 0

    async def _run_ffmpeg_complex(
        self,
        input_path: str,
        output_path: str,
        start_time_ms: int,
        duration_ms: int,
        filter_complex: str,
        audio_label: Optional[str] = None,
        extra_inputs: Optional[list[str]] = None,
        fps: str = "30",
        output_size: tuple[int, int] = (1080, 1920),
        output_duration_ms: Optional[int] = None,
        progress=None,
    ) -> None:
        """Run FFmpeg over the render window [start, start + duration) with a filter graph.

        The graph must output [out] and, when `audio_label` is given, that audio label.
        """
        start_sec = start_time_ms / 1000
        duration_sec = duration_ms / 1000

        cmd = [
            "ffmpeg", "-nostdin", "-nostats",
            "-y",
            "-accurate_seek",
            "-ss", f"{start_sec:.6f}",
            # Input option: bound the source read to the window. (After -i it
            # would apply to the next input - the looped title image - and the
            # source would be read past the window.)
            "-t", f"{duration_sec:.6f}",
            "-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "mov,matroska,webm,avi,flv,mpegts",
            "-i", input_path,
        ]

        for extra in (extra_inputs or []):
            # Legacy plain paths loop images; (path, options) tuples carry
            # per-input options (-loop for stills, -stream_loop for music...).
            if isinstance(extra, tuple):
                path, options = extra
                cmd.extend([*options, '-i', path])
            else:
                cmd.extend(["-loop", "1", "-protocol_whitelist", "file,pipe,fd", "-i", extra])

        cmd.extend([
            "-filter_complex", filter_complex,
            "-map", "[out]",
            # MP4 edit lists account for AAC priming and reordered video.
            # make_zero shifts presentation time by encoder delay, moving the
            # media away from captions and the edit's zero-based clock.
            *self._video_codec_args(output_size[0], output_size[1], fps),
            "-pix_fmt", "yuv420p",
            "-r", fps,
            "-movflags", "+faststart",
        ])

        if audio_label:
            cmd.extend(["-map", audio_label, "-c:a", "aac", "-b:a", "192k"])
        else:
            cmd.append("-an")

        if extra_inputs:
            cmd.append("-shortest")

        cmd.append(output_path)

        try:
            if progress:
                await self._run_cmd(cmd, progress=progress, duration_ms=output_duration_ms or duration_ms)
            else:
                await self._run_cmd(cmd)
            await self._validate_output_timing(
                output_path, output_duration_ms if output_duration_ms is not None else duration_ms,
                fps, bool(audio_label),
            )
        except RenderingError:
            # A failed validation enters the existing fallback ladder. Never
            # leave the failed export looking like a completed clip.
            try:
                os.remove(output_path)
            except OSError:
                pass
            raise

    async def _validate_output_timing(
        self, output_path: str, duration_ms: int, fps: str, with_audio: bool,
    ) -> None:
        """Check the encoded presentation clock before publishing an export.

        This catches missing/truncated tracks and mux/encoder timing shifts,
        including gaps inside audio whose overall start/end times look valid.
        Content-level lip sync is covered by decoded flash/beep regressions;
        stream metadata alone cannot detect an already out-of-sync source.
        """
        cmd = [
            "ffprobe", "-v", "error", *MEDIA_INPUT_OPTIONS,
            "-show_entries", "stream=codec_type,start_time,duration", "-of", "json", output_path,
        ]
        try:
            result = await asyncio.to_thread(run_media, cmd, timeout=PROBE_TIMEOUT_SECONDS)
            if result.returncode != 0:
                raise ValueError("probe failed")
            streams = json.loads(result.stdout)["streams"]
            expected = duration_ms / 1000
            for kind in (["video", "audio"] if with_audio else ["video"]):
                matches = [s for s in streams if s.get("codec_type") == kind]
                if len(matches) != 1:
                    raise ValueError(f"missing or ambiguous {kind} track")
                start = float(matches[0]["start_time"])
                duration = float(matches[0]["duration"])
                # One video frame, plus one AAC packet for audio, plus mux rounding.
                # Audio can only end as precisely as the last frame it plays under.
                frame = 1 / float(Fraction(fps))
                tolerance = (frame if kind == "video" else frame + 1024 / 48000) + 0.003
                if not (math.isfinite(start) and math.isfinite(duration) and duration > 0):
                    raise ValueError(f"invalid {kind} timing")
                if abs(start) > 0.003 or abs(start + duration - expected) > tolerance:
                    logger.warning(
                        "Export %s timing rejected: start=%.6fs, duration=%.6fs, expected=%.6fs, tolerance=%.6fs",
                        kind, start, duration, expected, tolerance,
                    )
                    raise ValueError(f"{kind} timing differs from the edit")
            if with_audio:
                await asyncio.to_thread(self._validate_audio_packets, output_path)
            logger.info("Export timing verified: %.3fs at %s fps, audio=%s", expected, fps, with_audio)
        except Exception as exc:
            raise RenderingError("Export timing validation failed; the clip was not saved") from exc

    @staticmethod
    def _validate_audio_packets(output_path: str) -> None:
        """Verify the continuous 48 kHz AAC clock, with bounded memory.

        MP4 can hide a PTS jump by extending the preceding packet's duration;
        compare against AAC's 1024 samples as well as adjacent timestamps.
        The final packet may be shorter and the priming packet may start
        before zero. Neither should shift the audible presentation clock.
        """
        cmd = [
            "ffprobe", "-v", "error", *MEDIA_INPUT_OPTIONS,
            "-select_streams", "a:0", "-show_entries",
            "packet=pts_time,duration_time:packet_side_data=",
            "-of", "compact=p=0:nk=0", output_path,
        ]
        packet_seconds = 1024 / 48000
        tolerance = 1 / 48000 + 0.000002  # One sample plus probe rounding.
        previous = None
        with media_process(cmd, timeout=PROBE_TIMEOUT_SECONDS) as (process, _):
            while line := process.stdout.readline(512):
                fields = dict(part.split(b"=", 1) for part in line.strip().split(b"|") if b"=" in part)
                start = float(fields[b"pts_time"])
                duration = float(fields[b"duration_time"])
                if not (math.isfinite(start) and math.isfinite(duration) and 0 < duration <= packet_seconds + tolerance):
                    raise ValueError("invalid AAC packet duration")
                if previous is not None and abs(start - previous - packet_seconds) > tolerance:
                    raise ValueError("discontinuous AAC packet timestamps")
                previous = start
        if process.returncode != 0 or previous is None:
            raise ValueError("could not verify AAC packet timestamps")

    def _compute_padded_range(self, start_time_ms: int, duration_ms: int) -> tuple[int, int]:
        """Compute padded start and duration for consistent A/V trimming."""
        audio_padding_ms = self.settings.audio_padding_ms
        if audio_padding_ms <= 0:
            return start_time_ms, duration_ms

        adjusted_start_ms = max(0, start_time_ms - audio_padding_ms)
        start_adjustment = start_time_ms - adjusted_start_ms
        adjusted_duration_ms = duration_ms + start_adjustment + audio_padding_ms
        return adjusted_start_ms, adjusted_duration_ms

    async def _run_cmd(self, cmd: list[str], *, progress=None, duration_ms=None) -> None:
        """Run a command asynchronously."""
        logger.debug(f"Running: {' '.join(cmd[:10])}...")

        reported = -1

        def report_progress(percent):
            # File-option compatibility retries belong to the same render.
            # Do not emit a second initial zero when an older FFmpeg retries.
            nonlocal reported
            if percent > reported:
                reported = percent
                progress(percent)

        def execute(command):
            return self._capture_preview_progress(command, duration_ms, report_progress, check=False) if progress else run_media(command)

        def invoke():
            # Keep the script inside the worker: cancelling the await does not
            # stop run_media's thread, so the file must outlive that thread.
            try:
                graph_index = cmd.index("-filter_complex")
            except ValueError:
                return execute(cmd)
            graph = cmd[graph_index + 1]
            if len(graph.encode("utf-8")) <= MAX_INLINE_FILTER_GRAPH_BYTES:
                return execute(cmd)

            script_path = None
            try:
                # NamedTemporaryFile creates a private file. Close it before
                # FFmpeg opens it, which is required on Windows.
                with tempfile.NamedTemporaryFile(
                    mode="w", encoding="utf-8", suffix=".ffgraph",
                    prefix="bridgeclip-filter-", delete=False,
                ) as script:
                    script_path = script.name
                    script.write(graph)
                script_cmd = cmd.copy()
                script_cmd[graph_index:graph_index + 2] = ["-/filter_complex", script_path]
                result = execute(script_cmd)
                # FFmpeg 6 (Ubuntu 24.04) predates file-backed option values;
                # FFmpeg 9 removed the older script option. Retry only when the
                # first option itself is unknown, before any render can start.
                if result.returncode != 0:
                    stderr = result.stderr or b""
                    if (b"Unrecognized option '/filter_complex'." in stderr and
                            b"Error splitting the argument list: Option not found" in stderr):
                        script_cmd[graph_index] = "-filter_complex_script"
                        result = execute(script_cmd)
                return result
            finally:
                if script_path is not None:
                    os.remove(script_path)

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            invoke,
        )

        if result.returncode != 0:
            error_msg = result.stderr.decode()[-1000:] if result.stderr else "Unknown error"
            raise RenderingError(f"FFmpeg failed: {error_msg}")

    @staticmethod
    def _escape_filter_path(path: str) -> str:
        """Escape a file path for use as a filter option inside a filtergraph.

        FFmpeg strips one layer of escaping when it splits the graph ([ ] , ;
        ' \\ and edge whitespace are special there) and another when the filter
        parses its options (: separates them, = ends a leading option name,
        ' and \\ quote), so the path is escaped for both levels. Quoting once
        (the old form) left a path with ' or : able to end the filename early
        and feed the rest of the path to the filter's other options.
        """
        if sys.platform == "win32":
            path = path.replace("\\", "/")
        option = re.sub(r"([\\':=\s])", r"\\\1", path)
        return re.sub(r"([\\'\[\],;\s])", r"\\\1", option)


class RenderingError(Exception):
    """Exception raised when rendering fails."""
    pass
