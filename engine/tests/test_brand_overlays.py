"""Brand overlays (Faza A): logo watermark and built-in CTA badges.

Covers the browser-parser mirror in validate_candidate, asset resolution in
editor_bake_layers, the RenderRequest passthrough of the export path, the
Pillow-drawn rasters (the bundled static FFmpeg has no drawtext) and the
filter-graph shape of the composite. One real-FFmpeg smoke test is gated on
TEST_FFMPEG like test_clip_editor.py.
"""

import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from clip_engine.services.clip_editor import TimeMap
from clip_engine.services.manual_editor import EditorError, editor_bake_layers, run_editor, validate_candidate
from clip_engine.services.rendering_service import RenderRequest, RenderingError, RenderingService
from tests.test_manual_editor import candidate, export_fixture, write_assets

TEST_FFMPEG = os.environ.get("TEST_FFMPEG") or shutil.which("ffmpeg")


# ---------------------------------------------------------------------------
# validate_candidate mirrors parseCandidateEdit (src/shared/clip-editor.ts)
# ---------------------------------------------------------------------------

def test_cta_badges_validate_like_the_browser_parser():
    validate_candidate({**candidate(), 'cta_badges': [
        {'kind': 'subscribe', 'position': 'bottom-right'},
        {'kind': 'follow', 'position': 'top-left', 'start_ms': 1000, 'end_ms': 3000},
    ]}, 12000)


@pytest.mark.parametrize('badges,match', [
    ([{'kind': 'like', 'position': 'top-left'}], 'CTA badge'),
    ([{'kind': 'subscribe', 'position': 'middle'}], 'CTA badge'),
    (['subscribe'], 'CTA badge'),
    ([{'kind': 'subscribe', 'position': 'center', 'start_ms': 1000}], 'interval'),
    ([{'kind': 'subscribe', 'position': 'center', 'end_ms': 3000}], 'interval'),
    ([{'kind': 'subscribe', 'position': 'center', 'start_ms': 1000, 'end_ms': 1050}], 'interval'),
    ([{'kind': 'subscribe', 'position': 'center', 'start_ms': 11000, 'end_ms': 13000}], 'interval'),
    ([{'kind': 'subscribe', 'position': c} for c in ('top-left', 'top-right', 'bottom-left', 'bottom-right',
                                                     'center', 'top-left', 'top-right', 'bottom-left',
                                                     'bottom-right', 'center', 'top-left')], 'CTA badges'),
])
def test_invalid_cta_badges_fail_before_rendering(badges, match):
    with pytest.raises(ValueError, match=match):
        validate_candidate({**candidate(), 'cta_badges': badges}, 12000)


# ---------------------------------------------------------------------------
# Bake layers: passthrough and the export RenderRequest
# ---------------------------------------------------------------------------

def test_bake_layers_pass_logo_and_badges_through(tmp_path):
    c = {**candidate(),
         'logo': {'asset': 'a' * 32 + '.png', 'position': 'top-right', 'scale': .3, 'opacity': 1},
         'cta_badges': [{'kind': 'follow', 'position': 'center', 'start_ms': 2000, 'end_ms': 4000},
                        {'kind': 'subscribe', 'position': 'top-left'}]}
    write_assets(tmp_path, [c['logo']['asset']])
    layers = editor_bake_layers(tmp_path, c)
    assert layers['logo']['path'] == str(tmp_path / f"editor-asset-{'a' * 32}.png")
    assert layers['cta_badges'] == [
        {'kind': 'follow', 'position': 'center', 'start_ms': 2000, 'end_ms': 4000},
        {'kind': 'subscribe', 'position': 'top-left'}]
    assert 'cta_badges' not in editor_bake_layers(tmp_path, candidate())
    with pytest.raises(EditorError) as error:
        editor_bake_layers(tmp_path, {**candidate(), 'logo': {'asset': 'f' * 32 + '.png', 'position': 'center',
                                                              'scale': .2, 'opacity': 1}})
    assert error.value.editor_code == 'invalid_edit'


def test_export_passes_logo_and_badges_to_the_render_request(monkeypatch, tmp_path):
    from clip_engine.services.rendering_service import RenderResult
    captured = {}
    async def render(self, request):
        captured['request'] = request
        Path(request.output_path).write_bytes(b'clip')
        return RenderResult(request.output_path, 10, 5600, layout_type='two_shot')
    config = export_fixture(tmp_path, monkeypatch, render)
    project = json.loads((tmp_path / 'editor-project.json').read_text())
    c = project['candidates'][0]
    c['logo'] = {'asset': 'a' * 32 + '.png', 'position': 'top-right', 'scale': .3, 'opacity': .5}
    c['cta_badges'] = [{'kind': 'subscribe', 'position': 'bottom-right'},
                       {'kind': 'follow', 'position': 'center', 'start_ms': 2000, 'end_ms': 4000}]
    (tmp_path / 'editor-project.json').write_text(json.dumps(project))
    write_assets(tmp_path, [c['logo']['asset']])
    asyncio.run(run_editor(config))
    request = captured['request']
    assert request.logo == {'path': str(tmp_path / f"editor-asset-{'a' * 32}.png"),
                            'position': 'top-right', 'scale': .3, 'opacity': .5}
    assert request.cta_badges == c['cta_badges']
    assert (tmp_path / 'clip_00.mp4').read_bytes() == b'clip'


# ---------------------------------------------------------------------------
# Pillow rasters
# ---------------------------------------------------------------------------

def raster_renderer(tmp_path):
    renderer = RenderingService.__new__(RenderingService)
    renderer._font_path = renderer._resolve_font()
    renderer._fonts_dir = str(tmp_path)
    return renderer


@pytest.mark.parametrize('kind', ['subscribe', 'follow'])
def test_badge_png_is_a_pill_with_white_text(tmp_path, kind):
    renderer = raster_renderer(tmp_path)
    with Image.open(renderer._badge_overlay_image(kind, 34, str(tmp_path / 'badge.png'))) as opened:
        image = opened.convert('RGBA')
    width, height = image.size
    assert height < width  # horizontal pill, not a square
    assert image.getpixel((0, 0))[3] == 0  # outside the rounded rect is transparent
    # 6px inside the left edge: past the corner radius, before the label padding.
    left = image.getpixel((6, height // 2))
    right = image.getpixel((width - 7, height // 2))
    assert left[3] > 200
    if kind == 'subscribe':
        assert left[0] > 180 and left[1] < 60 and left[2] < 60  # YouTube red
        assert right[:3] == left[:3] or abs(right[0] - left[0]) < 40  # near-solid 255→224
    else:
        # Instagram purple → orange: the pill's two sides differ on every channel.
        assert all(abs(left[i] - right[i]) > 40 for i in range(3))
    center = image.crop((width // 4, 0, width * 3 // 4, height)).getdata()
    assert any(p[0] > 200 and p[1] > 200 and p[2] > 200 and p[3] > 200 for p in center)  # white label

def test_badge_size_scales_with_the_font(tmp_path):
    renderer = raster_renderer(tmp_path)
    small = Image.open(renderer._badge_overlay_image('subscribe', 12, str(tmp_path / 's.png'))).size
    large = Image.open(renderer._badge_overlay_image('subscribe', 48, str(tmp_path / 'l.png'))).size
    assert large[0] > small[0] and large[1] > small[1]


def test_logo_is_rewritten_as_rgba_png_without_touching_the_asset(tmp_path):
    renderer = raster_renderer(tmp_path)
    out_dir = tmp_path / 'work'
    out_dir.mkdir()
    request = RenderRequest(str(tmp_path / 'source.mp4'), str(out_dir / 'clip.mp4'), 0, 4000, 640, 360)
    jpeg = tmp_path / 'logo.jpg'
    Image.new('RGB', (16, 8), (255, 0, 0)).save(jpeg)
    original = jpeg.read_bytes()
    path = renderer._logo_overlay_image(str(jpeg), request, 640)
    assert path == str(out_dir / 'logo-0-4000.png')
    with Image.open(path) as converted:
        assert converted.mode == 'RGBA'
        r, g, b, a = converted.getpixel((8, 4))
        assert r > 200 and g < 60 and b < 60 and a == 255  # JPEG needs no alpha; lossy colors tolerate slack
    assert jpeg.read_bytes() == original  # the user's asset is never rewritten
    (tmp_path / 'broken.png').write_bytes(b'not an image')
    with pytest.raises(RenderingError, match='logo'):
        renderer._logo_overlay_image(str(tmp_path / 'broken.png'), request, 640)


# ---------------------------------------------------------------------------
# Filter-graph shape (pure strings; no FFmpeg needed)
# ---------------------------------------------------------------------------

def brand_request(tmp_path):
    logo = tmp_path / 'user-logo.png'
    Image.new('RGBA', (8, 8), (255, 0, 0, 255)).save(logo)
    return RenderRequest(str(tmp_path / 'source.mp4'), str(tmp_path / 'clip.mp4'), 0, 6000, 1920, 1080,
        logo={'path': str(logo), 'position': 'bottom-left', 'scale': .1, 'opacity': .4},
        cta_badges=[{'kind': 'follow', 'position': 'center', 'start_ms': 1000, 'end_ms': 4000}])


def test_brand_overlays_composite_after_captions_on_the_edited_clock(tmp_path):
    renderer = raster_renderer(tmp_path)
    request = brand_request(tmp_path)
    time_map = TimeMap([(0, 2000), (3000, 6000)], 6000)  # 2000–3000 is cut
    overlays = renderer._brand_overlays(request, 1080, 1920, time_map, 0, 34)
    graph, pngs = RenderingService._compose_overlays('[0:v]null[base];[base]null[captioned]', overlays, 'null')
    assert ";[1:v]scale=w=108:h=-2:flags=lanczos,format=rgba,colorchannelmixer=aa=0.4[img1]" in graph
    assert "[captioned][img1]overlay=x='34':y='H-h-34':shortest=1:enable='1'[ov1]" in graph
    # The badge's source interval crosses the cut; each kept piece gets its own
    # between() on the edited clock.
    assert ":enable='between(t,1.000,2.000)+between(t,2.000,3.000)'[composited]" in graph
    assert pngs == [overlay[0] for overlay in overlays]
    assert str(tmp_path / 'user-logo.png') not in pngs  # the generated copy is the disposable one
    assert all(os.path.isfile(path) for path in pngs)


def test_badge_fully_inside_a_cut_consumes_nothing(tmp_path):
    renderer = raster_renderer(tmp_path)
    request = brand_request(tmp_path)
    request.logo = None
    request.cta_badges = [{'kind': 'subscribe', 'position': 'center', 'start_ms': 2100, 'end_ms': 2900}]
    assert renderer._brand_overlays(request, 1080, 1920, TimeMap([(0, 2000)], 6000), 0, 34) == []
    assert list(tmp_path.glob('badge-*.png')) == []  # not even generated, so nothing leaks


# ---------------------------------------------------------------------------
# Real FFmpeg smoke
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not TEST_FFMPEG, reason="ffmpeg not installed")
def test_real_ffmpeg_composites_a_badge_at_the_brand_margin(tmp_path):
    renderer = raster_renderer(tmp_path)
    badge = renderer._badge_overlay_image('subscribe', 20, str(tmp_path / 'badge.png'))
    with Image.open(badge) as opened:
        badge_width, badge_height = opened.size
    graph, _ = RenderingService._compose_overlays('[0:v]null[base];[base]null[captioned]',
                                                  [(badge, 'W-w-34', 'H-h-34')], 'null')
    out = str(tmp_path / 'frame.png')
    subprocess.run([TEST_FFMPEG, '-v', 'error', '-y',
                    '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=1',
                    '-loop', '1', '-i', badge,
                    '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', out],
                   check=True, capture_output=True, timeout=60)
    frame = Image.open(out).convert('RGB')
    left, top = 320 - 34 - badge_width, 240 - 34 - badge_height
    assert left > 0 and top > 0
    # Inside the pill, away from the centered label: YouTube red.
    r, g, b = frame.getpixel((left + 6, top + badge_height // 2))
    assert r > 180 and g < 90 and b < 90
    assert max(frame.getpixel((5, 5))) < 16  # the rest of the frame is untouched
