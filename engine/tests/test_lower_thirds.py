"""Lower Thirds (Name Tag / Location): validation, bake pass-through, animated ASS.

The 12 presets render as layered ASS events — text-extent boxes, full-width band
drawings and accent strips sharing one entrance animation — while plain text
cards keep their original rendering byte-for-byte.
"""
from pathlib import Path

import pytest

from clip_engine.services.clip_editor import TimeMap
from clip_engine.services.manual_editor import EditorError, editor_bake_layers, validate_candidate
from clip_engine.services.rendering_service import LOWER_THIRD_IDS, LOWER_THIRDS, RenderRequest, RenderingService


def candidate(**overlay_patch):
    overlay = {'text': 'Tanya', 'start_ms': 500, 'end_ms': 2500, 'position': 'bottom-left',
               'preset': 'name-classic', 'variant': 'solid', 'sub': 'Creator'}
    overlay.update(overlay_patch)
    return {'id': 'candidate-1', 'title': 'Clip', 'ranges': [[0, 4000]],
            'scenes': [{'at_ms': 0, 'layout': 'fill', 'crops': [[.1, .1, .8, .8]]}],
            'captions': True, 'caption_preset': 'pop', 'video_speed': 1,
            'text_overlays': [overlay]}


def test_catalog_matches_the_renderer():
    assert LOWER_THIRD_IDS == {'name-classic', 'name-accent', 'name-side', 'name-two-line', 'name-clean', 'name-card',
                               'loc-pill', 'loc-ticker', 'loc-pin', 'loc-banner', 'loc-frame', 'loc-spotlight'}
    assert all(spec['anim'] in ('fade', 'rise', 'slide', 'pop') for spec in LOWER_THIRDS.values())


def test_lower_third_fields_validate_against_the_catalog():
    assert validate_candidate(candidate(), 4000, 4) is None
    for patch in [{'preset': 'not-a-preset'}, {'variant': 'neon'}, {'color': 'red'}, {'color': '#12g45z'},
                  {'image': '../escape.png'}, {'image': 'short'}, {'sub': 42}]:
        with pytest.raises(ValueError):
            validate_candidate(candidate(**patch), 4000, 4)
    validate_candidate(candidate(variant='image', image='a' * 32 + '.png', sub=None), 4000, 4)


def test_bake_layers_pass_lower_thirds_through_and_resolve_the_band_image(tmp_path):
    (tmp_path / ('editor-asset-' + 'a' * 32 + '.png')).write_bytes(b'png')
    layers = editor_bake_layers(tmp_path, candidate(variant='image', image='a' * 32 + '.png'))
    layer = layers['text_overlays'][0]
    assert layer['preset'] == 'name-classic' and layer['sub'] == 'Creator' and layer['variant'] == 'image'
    assert layer['image'] == str(tmp_path / ('editor-asset-' + 'a' * 32 + '.png'))
    with pytest.raises(EditorError):
        editor_bake_layers(tmp_path, candidate(variant='image', image='b' * 32 + '.png'))


def ass_for(tmp_path, overlays, out_w=1080, out_h=1920):
    request = RenderRequest(str(tmp_path / 'src.mp4'), str(tmp_path / 'clip.mp4'), 0, 8000, out_w, out_h,
                            text_overlays=overlays)
    path = RenderingService()._text_overlay_ass(request, out_w, out_h, TimeMap(keeps=[(0, 8000)]), 0)
    return Path(path).read_text(encoding='utf-8')


def test_name_tag_renders_a_boxed_rise_with_its_secondary_line(tmp_path):
    content = ass_for(tmp_path, [candidate()['text_overlays'][0]])
    assert 'Style: LT-name-classic-main-14161c' in content
    assert ',3,' in content.split('LT-name-classic-main')[1].split('\n')[0], 'the fill box uses BorderStyle=3'
    assert '\\move(43,1877,43,1810,0,260)\\fad(220,180)}Tanya' in content, 'rise entrance animation'
    assert '\\move(43,1747,43,1680,0,260)\\fad(220,180)}Creator' in content, 'the sub stacks above the main line'


def test_location_ticker_draws_a_full_width_band_in_the_variant_color(tmp_path):
    content = ass_for(tmp_path, [{'text': 'Los Angeles', 'start_ms': 500, 'end_ms': 2500, 'position': 'bottom-left',
                                  'preset': 'loc-ticker', 'variant': 'color', 'color': '#B3261E'}])
    assert '\\p1\\pos(0,1556)\\move(76,1556,0,1556,0,280)\\fad(240,180)\\1c&H001E26B3}m 0 0 l 1080 0 1080 230 0 230' in content
    assert '}LOS ANGELES' in content, 'band presets render uppercase'


def test_plain_cards_keep_their_original_rendering(tmp_path):
    content = ass_for(tmp_path, [{'text': 'Plain card', 'start_ms': 500, 'end_ms': 2500, 'position': 'center'}])
    events = content.split('[Events]')[1]
    assert 'Dialogue: 0,0:00:00.50,0:00:02.50,Default,,0,0,0,,{\\an5\\pos(540,960)}Plain card' in events
    assert '\\fad' not in events and 'LT-' not in content


def test_an_overlay_fully_cut_away_produces_no_events(tmp_path):
    content = ass_for(tmp_path, [candidate(**{'start_ms': 500, 'end_ms': 2500})['text_overlays'][0]])
    # The kept window starts at 4s in this map, so the 0.5–2.5s overlay is gone.
    request = RenderRequest(str(tmp_path / 'src.mp4'), str(tmp_path / 'clip.mp4'), 0, 8000, 1080, 1920,
                            text_overlays=[candidate()['text_overlays'][0]])
    path = RenderingService()._text_overlay_ass(request, 1080, 1920, TimeMap(keeps=[(4000, 8000)]), 0)
    trimmed = Path(path).read_text(encoding='utf-8')
    assert 'Tanya' not in trimmed
    assert content  # the uncut variant rendered fine above


def test_image_variant_draws_a_band_overlay_in_the_graph_and_skips_the_rect(tmp_path):
    content = ass_for(tmp_path, [{'text': 'Studio City', 'start_ms': 500, 'end_ms': 2500, 'position': 'bottom-left',
                                  'preset': 'loc-spotlight', 'variant': 'image', 'image': 'a' * 32 + '.png'}])
    assert '\\p1' not in content, 'the picture replaces the drawn band'
    assert 'LT-loc-spotlight-image-050608' in content

    svc = RenderingService()
    request = RenderRequest(str(tmp_path / 'src.mp4'), str(tmp_path / 'clip.mp4'), 0, 8000, 1080, 1920,
                            text_overlays=[{'text': 'Studio City', 'start_ms': 500, 'end_ms': 2500,
                                            'position': 'bottom-left', 'preset': 'loc-spotlight',
                                            'variant': 'image', 'image': 'a' * 32 + '.png'}])
    graph, specs = svc._bake_stage(request, [], TimeMap(keeps=[(0, 8000)]), 0, 1080, 1920, '30', 2)
    assert '[ltband2]' in graph and 'overlay=0:1556' in graph
    assert any(path.endswith('.png') for path, _ in specs)

    # A non-band preset has no strip to fill: the image stays unused, nothing breaks.
    request2 = RenderRequest(str(tmp_path / 'src.mp4'), str(tmp_path / 'clip.mp4'), 0, 8000, 1080, 1920,
                             text_overlays=[{'text': 'Tanya', 'start_ms': 500, 'end_ms': 2500,
                                             'position': 'bottom-left', 'preset': 'name-classic',
                                             'variant': 'image', 'image': 'a' * 32 + '.png'}])
    graph2, specs2 = svc._bake_stage(request2, [], TimeMap(keeps=[(0, 8000)]), 0, 1080, 1920, '30', 2)
    assert 'ltband' not in graph2 and not specs2
