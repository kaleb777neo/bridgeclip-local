"""Uploaded .srt transcripts: parse cues and replace AI transcription."""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, '.')
from clip_engine.services.ai_clipping_pipeline import ClippingJobRequest, _parse_srt  # noqa: E402


def test_parse_srt_reads_cues_strips_tags_and_skips_malformed_blocks():
    srt = (
        '1' + chr(10) + '00:00:01,600 --> 00:00:04,200' + chr(10) + '<i>Hello</i> world' + chr(10) + chr(10) +
        '2' + chr(10) + '00:00:04,500 --> 00:00:06,000' + chr(10) + 'Second line' + chr(10) + chr(10) +
        'not a cue block' + chr(10) + chr(10) +
        '3' + chr(10) + '00:00:06,000 --> 00:00:05,000' + chr(10) + 'reversed timing'
    )
    segments = _parse_srt(srt)
    assert [(s.start_time_ms, s.end_time_ms, s.text) for s in segments] == [
        (1600, 4200, 'Hello world'), (4500, 6000, 'Second line')]


def test_overlapping_cues_are_clamped_not_dropped():
    srt = (
        '1' + chr(10) + '00:00:00,000 --> 00:00:05,000' + chr(10) + 'First' + chr(10) + chr(10) +
        '2' + chr(10) + '00:00:03,000 --> 00:00:06,000' + chr(10) + 'Second'
    )
    segments = _parse_srt(srt)
    assert [(s.start_time_ms, s.end_time_ms) for s in segments] == [(0, 5000), (5000, 6000)]


def test_srt_request_carries_the_path_for_the_engine(tmp_path):
    srt = tmp_path / 'uploaded.srt'
    srt.write_text('1' + chr(10) + '00:00:00,500 --> 00:00:03,000' + chr(10) + 'Clean source captions', encoding='utf-8')
    request = ClippingJobRequest(video_url=str(tmp_path / 'source.mp4'), srt_path=str(srt), workflow='automatic')
    assert request.srt_path == str(srt)
    parsed = _parse_srt(Path(request.srt_path).read_text(encoding='utf-8'))
    assert len(parsed) == 1 and parsed[0].text == 'Clean source captions'
