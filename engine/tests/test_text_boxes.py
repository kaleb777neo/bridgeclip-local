"""Styled text boxes: independent per-box look, rendered as generated cards.

Styled boxes leave the ASS file and become rounded-card PNG overlays stacked
by anchor, so up to five boxes can share the screen without overlapping.
"""
from pathlib import Path

from clip_engine.services.clip_editor import TimeMap
from clip_engine.services.rendering_service import RenderRequest, RenderingService


STYLE = {'font': 'poppins', 'size': 0.032, 'color': '#ffffff', 'background': '#14161c',
         'radius': 10, 'padding': 1, 'align': 'center'}


def bake(tmp_path, overlays, out_w=1080, out_h=1920):
    request = RenderRequest(str(tmp_path / 'src.mp4'), str(tmp_path / 'clip.mp4'), 0, 6000, out_w, out_h,
                            text_overlays=overlays)
    graph, specs = RenderingService()._bake_stage(request, [], TimeMap(keeps=[(0, 6000)]), 0, out_w, out_h, '30', 1)
    return graph, specs


def test_styled_boxes_become_card_overlays_and_leave_the_ass_file(tmp_path):
    graph, specs = bake(tmp_path, [
        {'text': 'JAMES DOE', 'start_ms': 500, 'end_ms': 2500, 'position': 'bottom-left', 'style': STYLE},
        {'text': 'Plain card', 'start_ms': 3000, 'end_ms': 5000, 'position': 'center'}])
    assert '[1:v]overlay=' in graph and "enable='between(t,0.500,2.500)'" in graph, 'the styled box is a PNG overlay with enable windows'
    assert specs[0][0].endswith('text-box-0-500.png'), 'the card input is registered for the graph'
    # The plain card still renders through ASS; the styled one never reaches it.
    plain_ass = tmp_path / 'text-overlays-0-6000.ass'
    assert 'JAMES DOE' not in plain_ass.read_text(encoding='utf-8')
    assert 'Plain card' in plain_ass.read_text(encoding='utf-8')


def test_same_anchor_boxes_stack_vertically(tmp_path):
    graph, specs = bake(tmp_path, [
        {'text': 'First', 'start_ms': 500, 'end_ms': 2500, 'position': 'top-left', 'style': STYLE},
        {'text': 'Second', 'start_ms': 500, 'end_ms': 2500, 'position': 'top-left', 'style': STYLE}])
    offsets = sorted(int(part.split('overlay=')[1].split(':')[1].split(':')[0]) for part in graph.split(';') if part.startswith('[pip') or 'overlay=' in part and 'text-box' not in part) if False else None
    # Both cards exist and the second sits below the first (stack offset by card height + gap).
    assert len(specs) == 2
    overlay_parts = [part for part in graph.split(';') if part.startswith('[baked') or part.startswith('[1:') or part.startswith('[2:')]
    ys = [int(part.split('overlay=')[1].split(':')[1]) for part in graph.split(';') if 'overlay=' in part and ':0:' not in part and '[baked' in part]
    assert len(ys) == 2 and ys[1] > ys[0], f'the second box stacks below the first: {ys}'


def test_card_files_are_generated_with_the_requested_size(tmp_path):
    request = RenderRequest(str(tmp_path / 'src.mp4'), str(tmp_path / 'clip.mp4'), 0, 6000, 1080, 1920,
                            text_overlays=[{'text': 'Headline', 'start_ms': 500, 'end_ms': 2500,
                                            'position': 'top-left', 'style': {**STYLE, 'size': 0.05}}])
    svc = RenderingService()
    card = svc._build_text_box_card(request.text_overlays[0], 1080, 1920, str(tmp_path / 'card.png'))
    assert (tmp_path / 'card.png').exists()
    assert card['height'] >= round(1920 * 0.05), 'the card scales with the requested size'
