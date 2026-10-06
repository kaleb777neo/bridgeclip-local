"""
Tests for tight pacing: which gaps get cut, what is protected, time mapping,
and a real FFmpeg check that audio and video stay in sync across cuts.

Also covers the manual editor's bake layers (logo, b-rolls, text cards, music,
audio gain, xfade transitions): filter-graph shape here, plus one real FFmpeg
integration render; validation and asset plumbing live in test_manual_editor.py.
"""

import asyncio
import json
import os
import shutil
import subprocess

import pytest

from clip_engine.services.clip_editor import (
    KEEP_PAUSE_MS,
    MIN_PIECE_MS,
    TimeMap,
    WindowWord,
    compute_keep_intervals,
    is_filler,
    reaction_intervals,
    remap_segments,
)
from clip_engine.services.layout_analyzer import ClipLayoutPlan, LayoutType, ShotLayout
from clip_engine.services.layout_renderer import build_layout_graph
from clip_engine.services.manual_editor import manual_plan
from clip_engine.services.rendering_service import RenderRequest, RenderingService
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord


TEST_FFMPEG = os.environ.get("TEST_FFMPEG") or shutil.which("ffmpeg")


def encoder_args():
    encoders = subprocess.run([TEST_FFMPEG, "-hide_banner", "-encoders"], capture_output=True, text=True, check=True).stdout
    if "libx264" in encoders:
        return ["-c:v", "libx264", "-preset", "ultrafast"]
    if "h264_videotoolbox" in encoders:
        return ["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", "4M"]
    pytest.skip("No H.264 encoder in test FFmpeg")


def speech(*spans):
    """Words from (start_ms, end_ms[, text]) tuples."""
    return [WindowWord(s[0], s[1], s[2] if len(s) > 2 else "word") for s in spans]


def plan_of(*shots, window_ms=20000):
    return ClipLayoutPlan(
        shots=[ShotLayout(a, b, layout) for a, b, layout in shots], source_width=1920, source_height=1080,
    )


def removed(keeps, window_ms):
    return window_ms - sum(e - s for s, e in keeps)


class TestKeepIntervals:
    def test_continuous_speech_is_untouched(self):
        words = speech(*[(100 + i * 400, 450 + i * 400) for i in range(20)])
        assert compute_keep_intervals(words, 8200) == [(0, 8200)]

    def test_long_pause_on_talking_head_is_compressed(self):
        words = speech((100, 900), (3000, 3800))
        keeps = compute_keep_intervals(words, 4200, plan_of((0, 4200, LayoutType.TALKING_HEAD)))
        assert len(keeps) == 2
        gap_after = keeps[1][0] - keeps[0][1]
        assert gap_after > 0
        # ~KEEP_PAUSE_MS of the 2.1s pause survives.
        assert 2100 - removed(keeps, 4200) == pytest.approx(KEEP_PAUSE_MS, abs=40)

    def test_screen_shot_pauses_are_protected(self):
        words = speech((100, 900), (4000, 4800))
        assert compute_keep_intervals(words, 5000, plan_of((0, 5000, LayoutType.SCREEN))) == [(0, 5000)]

    def test_screen_cam_only_cuts_long_waits(self):
        plan = plan_of((0, 12000, LayoutType.SCREEN_CAM))
        short = compute_keep_intervals(speech((100, 900), (2400, 3000), (3000, 11900)), 12000, plan)
        assert short == [(0, 12000)]  # 1.5s pause kept
        long = compute_keep_intervals(speech((100, 900), (4000, 4800), (4800, 11900)), 12000, plan)
        assert removed(long, 12000) > 2000

    def test_unknown_layout_does_not_jump_cut_demos(self):
        # No plan (analysis failed or skipped): a silent 1.5s demo stays, as on
        # screen+webcam, instead of being cut like talking-head dead air.
        short = compute_keep_intervals(speech((100, 900), (2400, 3000), (3000, 11900)), 12000, None)
        assert short == [(0, 12000)]
        long = compute_keep_intervals(speech((100, 900), (4000, 4800), (4800, 11900)), 12000, None)
        assert removed(long, 12000) > 2000

    def test_filler_gap_is_always_compressed(self):
        words = speech((100, 900, "So"), (1000, 1500, "um,"), (1600, 2300, "anyway"), (2300, 9000, "rest"))
        keeps = compute_keep_intervals(words, 9100, plan_of((0, 9100, LayoutType.TALKING_HEAD)))
        # The "um" and its surrounding silence collapse to a short breath.
        assert removed(keeps, 9100) >= 400
        assert all(not (s <= 1250 < e) for s, e in keeps)
        assert all(not (s < 1500 and e > 1000) for s, e in keeps)

    def test_reaction_is_never_cut(self):
        words = speech((100, 900), (4000, 4800))
        keeps = compute_keep_intervals(
            words, 5000, plan_of((0, 5000, LayoutType.TALKING_HEAD)), protected=[(900, 4000)],
        )
        assert keeps == [(0, 5000)]

    def test_lead_in_and_tail_silence_trimmed(self):
        words = speech((1500, 2300), (2300, 6000))
        keeps = compute_keep_intervals(words, 8000, plan_of((0, 8000, LayoutType.TALKING_HEAD)))
        assert keeps[0][0] > 1000 and keeps[-1][1] < 7000

    def test_tail_only_cut_survives_non_frame_aligned_window_end(self):
        words = speech((300, 650), (700, 1050))
        keeps = compute_keep_intervals(
            words, 10150, plan_of((0, 10150, LayoutType.SCREEN_CAM)),
        )
        assert len(keeps) == 1
        assert keeps[0][0] == 0
        assert 1400 <= keeps[0][1] <= 1500

    def test_detected_layout_wins_over_forced_style(self):
        # "Classic" (fit) framing of a talking head still gets tight pacing.
        plan = plan_of((0, 5000, LayoutType.SCREEN))
        plan.shots[0].detected_layout = LayoutType.TALKING_HEAD
        keeps = compute_keep_intervals(speech((100, 900), (4000, 4800)), 5000, plan)
        assert len(keeps) == 2

    def test_pieces_on_frame_grid_and_not_slivers(self):
        words = speech(*[(i * 1700, i * 1700 + 500) for i in range(8)])
        keeps = compute_keep_intervals(words, 14000, plan_of((0, 14000, LayoutType.TALKING_HEAD)))
        for start, end in keeps:
            assert end - start >= MIN_PIECE_MS or (start, end) == keeps[-1]
            for t in (start, end):
                assert abs(t / (1000 / 30) - round(t / (1000 / 30))) < 0.05 or t == 14000


class TestFillers:
    @pytest.mark.parametrize("word", ["um", "Uh,", "umm...", "Hmm"])
    def test_fillers(self, word):
        assert is_filler(word)

    @pytest.mark.parametrize("word", ["so", "like", "ah", "umbrella", "her"])
    def test_real_words(self, word):
        assert not is_filler(word)


class TestTimeMap:
    def test_detects_tail_only_cut_when_window_length_is_known(self):
        tm = TimeMap([(0, 2400)], window_ms=5000)
        assert tm.output_ms == 2400
        assert tm.removed_ms == 2600
        assert tm.has_cuts
        assert tm.cut_count == 1

    def test_maps_and_clamps(self):
        tm = TimeMap([(0, 1000), (2000, 3000)])
        assert tm.output_ms == 2000
        assert tm.to_output(500) == 500
        assert tm.to_output(2500) == 1500
        assert tm.to_output(1500) is None
        assert tm.to_output_clamped(1500) == 1000

    def test_remap_segments_drops_fillers_and_shifts_words(self):
        words = [
            TranscriptWord("Hello", 10_000, 10_400),
            TranscriptWord("um", 10_500, 10_800),
            TranscriptWord("world.", 12_000, 12_400),
        ]
        segs = [TranscriptSegment(10_000, 12_400, "Hello um world.", words=words)]
        tm = TimeMap([(0, 450), (1900, 2600)])  # window starts at 10_000
        out = remap_segments(segs, 10_000, tm)
        assert [w.word for w in out[0].words] == ["Hello", "world."]
        assert out[0].words[1].start_time_ms == 10_000 + 450 + 100

    def test_keeps_filler_caption_when_audio_was_not_cut(self):
        words = [TranscriptWord("um", 10_500, 10_800)]
        segs = [TranscriptSegment(10_500, 10_800, "um", words=words)]
        out = remap_segments(segs, 10_000, TimeMap([(0, 2000)]))
        assert [w.word for w in out[0].words] == ["um"]

    def test_reaction_intervals_follow_event_sentences(self):
        segs = [
            TranscriptSegment(0, 1000, "Joke.", audio_events=["(laughter)"]),
            TranscriptSegment(3000, 4000, "Next."),
        ]
        assert reaction_intervals(segs, 0, 5000) == [(1000, 3000)]


@pytest.mark.skipif(not TEST_FFMPEG, reason="ffmpeg not installed")
def test_ffmpeg_cuts_keep_audio_video_in_sync(tmp_path):
    plan = plan_of((0, 3000, LayoutType.TALKING_HEAD), (3000, 6000, LayoutType.SCREEN), window_ms=6000)
    plan.shots[0].focus_path = [(0, 0.4, 0.4)]
    keeps = [(0, 700), (1300, 2200), (2600, 4100), (4500, 5300), (5600, 6000)]
    graph = build_layout_graph(plan, 1080, 1920, keeps, with_audio=True)
    out = tmp_path / "cut.mp4"
    subprocess.run([
        TEST_FFMPEG, "-v", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=6",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
        "-filter_complex", graph.replace("[0:a:0]", "[1:a:0]"),
        "-map", "[base]", "-map", "[aout]", *encoder_args(), "-c:a", "aac",
        str(out),
    ], check=True, capture_output=True)
    streams = json.loads(subprocess.run(
        [os.environ.get("TEST_FFPROBE") or shutil.which("ffprobe") or "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", str(out)],
        check=True, capture_output=True, text=True,
    ).stdout)["streams"]
    durations = {s["codec_type"]: float(s["duration"]) for s in streams}
    expected = sum(e - s for s, e in keeps) / 1000
    assert durations["video"] == pytest.approx(expected, abs=0.07)
    assert durations["audio"] == pytest.approx(durations["video"], abs=0.07)


# ---------------------------------------------------------------------------
# Editor bake layers: logo, b-rolls, text cards, music, audio gain, xfade
# ---------------------------------------------------------------------------

def bake_renderer(tmp_path):
    renderer = RenderingService.__new__(RenderingService)
    renderer._fonts_dir = None
    return renderer


def xfade_plan(kind='wipe', crops=([0, 0, .5, 1], [.5, 0, .5, 1])):
    c = {'ranges': [[0, 4000]], 'scenes': [
        {'at_ms': 0, 'layout': 'fill', 'crops': [list(crops[0])]},
        {'at_ms': 2000, 'layout': 'fill', 'crops': [list(crops[1])],
         'transition_ms': 600, 'transition_kind': kind},
    ]}
    return manual_plan({'width': 160, 'height': 240}, c)


class TestBakeGraphs:
    def test_brand_overlays_composite_last_at_fixed_margins(self, tmp_path):
        from PIL import Image
        r = bake_renderer(tmp_path)
        logo_source = tmp_path / 'logo.png'
        Image.new('RGBA', (8, 8), (255, 0, 0, 255)).save(logo_source)
        attrs = {'video_speed': 1, 'output_path': str(tmp_path / 'clip.mp4'),
                 'start_time_ms': 0, 'end_time_ms': 4000,
                 'logo': {'path': str(logo_source), 'position': 'top-right', 'scale': 0.25, 'opacity': 0.6},
                 'cta_badges': [{'kind': 'subscribe', 'position': 'bottom-left'},
                                {'kind': 'follow', 'position': 'center', 'start_ms': 1000, 'end_ms': 3000}]}
        request = type('R', (), attrs)()
        logo, subscribe, follow = r._brand_overlays(request, 1920, 1080, TimeMap([(0, 4000)], 4000), 0, 34)
        # 34px output margins; W/H resolve against the composited (output) frame.
        assert logo[1:] == ('W-w-34', '34', '1',
                            'scale=w=480:h=-2:flags=lanczos,format=rgba,colorchannelmixer=aa=0.6')
        assert os.path.basename(logo[0]) == 'logo-0-4000.png'
        # The logo is re-encoded RGBA; the user's asset file is never consumed.
        assert logo[0] != str(logo_source) and Image.open(logo[0]).mode == 'RGBA'
        assert os.path.isfile(logo_source)
        # Untimed badges are plain 3-tuples; timed ones enable on the edited clock.
        assert subscribe[1:] == ('34', 'H-h-34')
        assert follow[1:4] == ('(W-w)/2', '(H-h)/2', 'between(t,1.000,3.000)')
        assert Image.open(subscribe[0]).mode == 'RGBA' and Image.open(follow[0]).mode == 'RGBA'
        graph, pngs = RenderingService._compose_overlays('[0:v]null[base];[base]null[captioned]',
                                                         [logo, subscribe, follow], 'null')
        assert "[captioned][img1]overlay=x='W-w-34':y='34':shortest=1:enable='1'[ov1]" in graph
        assert "[ov1][2:v]overlay=x='34':y='H-h-34':shortest=1[ov2]" in graph
        assert "[ov2][img3]overlay=x='(W-w)/2':y='(H-h)/2':shortest=1:enable='between(t,1.000,3.000)'[composited]" in graph
        assert pngs == [logo[0], subscribe[0], follow[0]]
        # Full opacity skips the mixer, and positions fall back to logo top-left / badge bottom-right.
        plain = type('R', (), {**attrs, 'logo': {'path': str(logo_source), 'scale': 0.2},
                               'cta_badges': [{'kind': 'subscribe'}]})()
        logo_overlay, badge_overlay = r._brand_overlays(plain, 1920, 1080, TimeMap([(0, 4000)], 4000), 0, 34)
        assert 'colorchannelmixer' not in logo_overlay[4]
        assert (logo_overlay[1], logo_overlay[2]) == ('34', '34')
        assert (badge_overlay[1], badge_overlay[2]) == ('W-w-34', 'H-h-34')
        # Brand layers land after the caption burn-in, so captions stay under them.
        assert r._caption_graph(None, [], 0, TimeMap([(0, 4000)])) == ';[base]null[captioned]'

    def test_cut_badge_intervals_draw_nothing_and_consume_no_input(self, tmp_path):
        r = bake_renderer(tmp_path)
        request = type('R', (), {
            'video_speed': 1, 'output_path': str(tmp_path / 'clip.mp4'),
            'start_time_ms': 0, 'end_time_ms': 4000, 'logo': None,
            'cta_badges': [{'kind': 'subscribe', 'position': 'center', 'start_ms': 2500, 'end_ms': 3500}],
        })()
        # The badge window lies fully inside the 2000-4000 cut.
        overlays = r._brand_overlays(request, 1920, 1080, TimeMap([(0, 2000)], 4000), 0, 34)
        assert overlays == []
        assert list(tmp_path.glob('badge-*.png')) == []

    def test_mapped_spans_follow_cuts_and_video_speed(self):
        r = bake_renderer(None)
        time_map = TimeMap([(0, 4000), (6000, 9000)], 9000)
        # Source [3000, 7500] with the window starting at 1000 and a 2s cut inside.
        spans = r._mapped_spans(3000, 7500, 1000, time_map, 2)
        assert spans == pytest.approx([(1.0, 2.0), (2.0, 2.25)])
        assert r._mapped_spans(5000, 5900, 1000, time_map, 1) == []  # Entirely inside a cut
        assert r._mapped_spans(6000, 9000, 1000, time_map, 1) == pytest.approx([(4.0, 6.0)])

    def test_broll_stage_overlays_on_final_clock_across_cuts(self, tmp_path):
        r = bake_renderer(tmp_path)
        request = type('R', (), {'video_speed': 2, 'text_overlays': [], 'output_path': str(tmp_path / 'clip.mp4'),
                                 'start_time_ms': 1000, 'end_time_ms': 10000})()
        time_map = TimeMap([(0, 4000), (6000, 9000)], 9000)
        stage, specs = r._bake_stage(
            request,
            [{'path': str(tmp_path / 'card.png'), 'start_ms': 3000, 'end_ms': 7500},
             {'path': str(tmp_path / 'gone.png'), 'start_ms': 5000, 'end_ms': 5900},
             {'path': str(tmp_path / 'insert.mp4'), 'start_ms': 2000, 'end_ms': 3000}],
            time_map, 1000, 1080, 1920, '30', first_index=2,
        )
        enable = "'gte(t,1.000)*lt(t,2.000)+gte(t,2.000)*lt(t,2.250)'"
        assert ";[2:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[broll2]" in stage
        assert f"[pre_bake][broll2]overlay=0:0:enable={enable}[baked2]" in stage
        # The fully cut b-roll still consumes input 3 (command indexes shift).
        assert '[3:v]' not in stage
        # A video insert replays from its own start on the output clock, muted.
        assert 'fps=30,setpts=PTS-STARTPTS+0.500/TB[broll4]' in stage
        assert "overlay=0:0:repeatlast=0:enable='gte(t,0.500)*lt(t,1.000)'[baked4]" in stage
        assert stage.endswith('[baked4]null[out]')
        opts = [options for _, options in specs]
        assert opts == [RenderingService.LOOP_IMAGE, RenderingService.LOOP_IMAGE, RenderingService.PLAIN_FILE]

    def test_text_cards_become_one_ass_file_on_the_final_clock(self, tmp_path):
        r = bake_renderer(tmp_path)
        request = type('R', (), {
            'video_speed': 1, 'output_path': str(tmp_path / 'clip.mp4'),
            'start_time_ms': 0, 'end_time_ms': 4000,
            'text_overlays': [{'text': 'A{b}c\\d\nSecond', 'start_ms': 500, 'end_ms': 2500, 'position': 'top-right'},
                              {'text': 'cut', 'start_ms': 2000, 'end_ms': 3000, 'position': 'center'}],
        })()
        time_map = TimeMap([(0, 2000)], 4000)  # 2000-3000 is cut away
        stage, specs = r._bake_stage(request, [], time_map, 0, 160, 240, '30', first_index=1)
        assert specs == []
        assert 'ass=' in stage and stage.endswith('[baked_text]null[out]')
        ass = next(tmp_path.glob('text-overlays-*.ass'))
        content = ass.read_text(encoding='utf-8')
        assert 'PlayResX: 160' in content and 'PlayResY: 240' in content
        assert 'Style: Default,Arial,16,&H00FFFFFF' in content  # bold white, 5% of height
        # Braces and backslashes are stripped first; \n becomes ASS's \N.
        assert 'Dialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,{\\an9\\pos(152,8)}Abcd\\NSecond' in content
        events = content.split('[Events]')[-1]
        assert 'cut' not in events and 'Second' in events  # the fully cut card is gone

    def test_compose_overlays_hands_off_to_bake_stage(self, tmp_path):
        graph, pngs = RenderingService._compose_overlays('[x]null[captioned]', [], 'setpts=1.5*PTS',
                                                         output_label='pre_bake')
        assert graph.endswith('[captioned]setpts=1.5*PTS[pre_bake]') and pngs == []
        default, _ = RenderingService._compose_overlays('[x]null[captioned]', [])
        assert default == '[x]null[captioned];[captioned]null[out]'

    def test_audio_gain_and_music_mix_before_loudnorm(self):
        plan = ClipLayoutPlan([ShotLayout(0, 4000, LayoutType.TALKING_HEAD)], 160, 240)
        graph = build_layout_graph(plan, 1080, 1920, [(0, 4000)], True, fps='30',
                                   audio_gain=0.5, music_index=3, music_gain=0.3)
        speech = graph.index('[a0]concat=n=1:v=0:a=1,volume=0.5[speech_baked]')
        bed = graph.index('[3:a:0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,'
                          'volume=0.3[music_bed]')
        mix = graph.index('[speech_baked][music_bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,'
                          'loudnorm=')
        assert speech < bed < mix
        # Without music/gain the graph is byte-identical to the shipped default.
        plain = build_layout_graph(plan, 1080, 1920, [(0, 4000)], True, fps='30')
        assert '[a0]concat=n=1:v=0:a=1,loudnorm=' in plain
        assert 'music_bed' not in plain and 'xfade' not in plain and 'volume=' not in plain

    def test_xfade_overlap_preserves_the_concat_frame_grid(self):
        for kind, expected in (('wipe', 'xfade=transition=wipeleft:duration=0.600000:offset=2.000000'),
                               ('dissolve', 'xfade=transition=fade:duration=0.600000:offset=2.000000')):
            graph = build_layout_graph(xfade_plan(kind), 160, 120, None, fps='30')
            # The previous piece borrows the transition's source frames...
            assert 'trim=start_frame=0:end_frame=78' in graph
            assert expected in graph
            # ...and the composite is rebuilt on the exact concat grid.
            assert 'setpts=N,fps=30[base]' in graph

    def test_xfade_falls_back_to_a_hard_cut_when_a_user_cut_lands_on_the_scene(self):
        graph = build_layout_graph(xfade_plan(), 160, 120, [(0, 2000), (2500, 4000)], fps='30')
        assert 'xfade' not in graph and 'concat=n=2:v=1:a=0' in graph


@pytest.mark.skipif(not TEST_FFMPEG, reason="ffmpeg not installed")
def test_real_bake_render_composites_logo_music_text_and_intro(tmp_path, monkeypatch):
    """One actual FFmpeg bake: white intro, then a black clip carrying a red
    top-left logo, a white centered text card between 2s and 3s, and a 1 kHz
    music bed under the source's 440 Hz tone."""
    np = pytest.importorskip("numpy")
    if not shutil.which('ffprobe') and not os.environ.get('TEST_FFPROBE'):
        pytest.skip('ffprobe is needed to probe the bake inputs')
    from clip_engine.services import rendering_service

    monkeypatch.setattr(rendering_service, 'get_output_dimensions', lambda _: (160, 240))
    renderer = RenderingService()
    monkeypatch.setattr(renderer.settings, 'local_mode', True)
    renderer._verify_ffmpeg()  # Picks an encoder this build actually has.

    def run(*args):
        subprocess.run([TEST_FFMPEG, '-v', 'error', '-y', *args], check=True, capture_output=True, timeout=60)

    source = str(tmp_path / 'source.mp4')
    run('-f', 'lavfi', '-i', 'color=c=black:s=160x240:r=30:d=4',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
        *encoder_args(), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source)
    logo = str(tmp_path / 'logo.png')
    run('-f', 'lavfi', '-i', 'color=c=red:s=24x24:r=30:d=1', '-frames:v', '1', logo)
    music = str(tmp_path / 'music.m4a')
    run('-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2', '-c:a', 'aac', music)
    intro = str(tmp_path / 'intro.mp4')
    run('-f', 'lavfi', '-i', 'color=c=white:s=160x240:r=30:d=1', *encoder_args(), '-pix_fmt', 'yuv420p', intro)

    request = RenderRequest(
        video_path=source, output_path=str(tmp_path / 'out.mp4'), start_time_ms=0, end_time_ms=4000,
        source_width=160, source_height=240, include_captions=False, include_title=False, apply_padding=False,
        video_speed=1, manual_ranges_ms=[(0, 4000)],
        manual_plan=manual_plan({'width': 160, 'height': 240}, {'ranges': [[0, 4000]], 'scenes': [
            {'at_ms': 0, 'layout': 'fill', 'crops': [[0, 0, 1, 1]]}]}),
        logo={'path': logo, 'position': 'top-left', 'scale': 0.2, 'opacity': 1.0},
        music={'path': music, 'gain': 0.8}, audio_gain=1.0,
        text_overlays=[{'text': 'HELLO WORLD', 'start_ms': 1000, 'end_ms': 2000, 'position': 'center'}],
        intro_path=intro,
    )
    result = asyncio.run(renderer.render_clip(request))
    assert 4900 <= result.duration_ms <= 5150  # 1s intro + 4s baked clip

    raw = subprocess.run([TEST_FFMPEG, '-v', 'error', '-i', result.output_path, '-f', 'rawvideo',
                          '-pix_fmt', 'rgb24', 'pipe:1'], check=True, capture_output=True, timeout=60)
    frames = np.frombuffer(raw.stdout, dtype=np.uint8).reshape(-1, 240, 160, 3)
    assert len(frames) >= 145
    assert np.all(frames[5] > 200)  # The intro plays first, untouched
    def text_pixels(frame):
        return int(np.count_nonzero(frame[90:150, 20:140].max(axis=2) > 150))
    during, before, after = frames[75], frames[40], frames[130]
    # 32x32 logo at (34,34): the 34px brand margin, not the old 3% margin.
    assert during[50, 50, 0] > 180 and during[50, 50, 1] < 80 and during[50, 50, 2] < 80
    assert after[50, 50, 0] > 180  # the logo outlives the text card
    assert text_pixels(during) > 20 and text_pixels(before) == 0 and text_pixels(after) == 0
    assert os.path.isfile(logo)  # the overlay chain deletes only its own rasters

    audio = subprocess.run([TEST_FFMPEG, '-v', 'error', '-i', result.output_path, '-f', 's16le', '-ac', '1',
                            '-ar', '48000', 'pipe:1'], check=True, capture_output=True, timeout=60)
    samples = np.frombuffer(audio.stdout, dtype=np.int16).astype(float) / 32768
    segment = samples[2 * 48000:4 * 48000]  # inside the baked part
    spectrum = np.abs(np.fft.rfft(segment * np.bartlett(len(segment))))
    median = np.median(spectrum)
    for tone in (440, 1000):  # source audio under the mixed music bed
        assert spectrum[int(tone * len(segment) / 48000)] > max(10 * median, 1.0), tone


@pytest.mark.skipif(not TEST_FFMPEG, reason="ffmpeg not installed")
def test_real_bake_render_appends_the_outro(tmp_path, monkeypatch):
    """The outro plays after the baked clip: a black main with a 440 Hz tone,
    then a red oversized outro (it must be resized to the render's frame) with
    a 660 Hz tone."""
    np = pytest.importorskip("numpy")
    if not shutil.which('ffprobe') and not os.environ.get('TEST_FFPROBE'):
        pytest.skip('ffprobe is needed to probe the bake inputs')
    from clip_engine.services import rendering_service

    monkeypatch.setattr(rendering_service, 'get_output_dimensions', lambda _: (160, 240))
    renderer = RenderingService()
    monkeypatch.setattr(renderer.settings, 'local_mode', True)
    renderer._verify_ffmpeg()

    def run(*args):
        subprocess.run([TEST_FFMPEG, '-v', 'error', '-y', *args], check=True, capture_output=True, timeout=60)

    source = str(tmp_path / 'source.mp4')
    run('-f', 'lavfi', '-i', 'color=c=black:s=160x240:r=30:d=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        *encoder_args(), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source)
    outro = str(tmp_path / 'outro.mp4')
    run('-f', 'lavfi', '-i', 'color=c=red:s=320x480:r=30:d=1',
        '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1',
        *encoder_args(), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', outro)

    request = RenderRequest(
        video_path=source, output_path=str(tmp_path / 'out.mp4'), start_time_ms=0, end_time_ms=2000,
        source_width=160, source_height=240, include_captions=False, include_title=False, apply_padding=False,
        video_speed=1, manual_ranges_ms=[(0, 2000)],
        manual_plan=manual_plan({'width': 160, 'height': 240}, {'ranges': [[0, 2000]], 'scenes': [
            {'at_ms': 0, 'layout': 'fill', 'crops': [[0, 0, 1, 1]]}]}),
        outro_path=outro,
    )
    result = asyncio.run(renderer.render_clip(request))
    assert 2900 <= result.duration_ms <= 3150  # 2s baked clip + 1s outro

    raw = subprocess.run([TEST_FFMPEG, '-v', 'error', '-i', result.output_path, '-f', 'rawvideo',
                          '-pix_fmt', 'rgb24', 'pipe:1'], check=True, capture_output=True, timeout=60)
    frames = np.frombuffer(raw.stdout, dtype=np.uint8).reshape(-1, 240, 160, 3)
    assert len(frames) >= 85
    assert frames[5].max() < 60  # The baked clip plays first, untouched
    last = frames[-5]
    assert np.all(last[:, :, 0] > 180) and last[:, :, 1].max() < 80  # Red outro, resized to the render frame

    audio = subprocess.run([TEST_FFMPEG, '-v', 'error', '-i', result.output_path, '-f', 's16le', '-ac', '1',
                            '-ar', '48000', 'pipe:1'], check=True, capture_output=True, timeout=60)
    samples = np.frombuffer(audio.stdout, dtype=np.int16).astype(float) / 32768
    for lo, hi, tone in ((0, 48000 * 2, 440), (int(2.05 * 48000), int(2.95 * 48000), 660)):
        part = samples[lo:hi]
        spectrum = np.abs(np.fft.rfft(part * np.bartlett(len(part))))
        assert spectrum[int(tone * len(part) / 48000)] > 10 * np.median(spectrum), tone

