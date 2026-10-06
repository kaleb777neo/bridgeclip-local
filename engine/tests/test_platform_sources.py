"""Kick / TikTok / Instagram links: detected as platform sources and routed
through yt-dlp's extractors with the generic (non-YouTube) format selectors."""
import sys

sys.path.insert(0, '.')
from clip_engine.services.video_downloader import (  # noqa: E402
    PLATFORM_FORMAT_SELECTORS,
    VideoDownloaderService,
    YOUTUBE_FORMAT_SELECTORS,
)


def service():
    return VideoDownloaderService()


def test_platform_hosts_are_detected_and_others_keep_their_routing():
    svc = service()
    for url in ['https://kick.com/video/abc123', 'https://kick.com/somechannel',
                'https://www.tiktok.com/@user/video/7301234', 'https://www.instagram.com/reel/Cabc123/',
                'https://instagr.am/p/Cabc123/']:
        assert svc.detect_source_type(url) == 'platform', url
    assert svc.detect_source_type('https://youtu.be/dQw4w9WgXcQ') == 'youtube'
    assert svc.detect_source_type('https://www.twitch.tv/videos/123') == 'twitch'
    assert svc.detect_source_type('https://example.com/video.mp4') == 'direct_url'
    # Subdomains of the platforms count; look-alike hosts do not.
    assert svc.detect_source_type('https://www.kick.com/video/x') == 'platform'
    assert svc.detect_source_type('https://notkick.com/video/x') == 'generic'  # page link goes to yt-dlp generic


def test_platform_selectors_are_generic_and_the_youtube_ones_stay():
    assert len(PLATFORM_FORMAT_SELECTORS) == 1
    assert 'b[vcodec!^=av01]' in PLATFORM_FORMAT_SELECTORS[0]
    assert YOUTUBE_FORMAT_SELECTORS != PLATFORM_FORMAT_SELECTORS
    # AV1 stays banned on both lists: the bundled FFmpeg cannot decode it.
    assert all('av01+ba' not in selector or 'vcodec!^=av01' in selector for selector in PLATFORM_FORMAT_SELECTORS)


def test_wide_platform_links_route_through_the_generic_ytdlp_extractor():
    svc = service()
    for url in ['https://vimeo.com/123456789',
                'https://www.dropbox.com/s/abc/recording.mp4?dl=0',
                'https://drive.google.com/file/d/XYZ/view',
                'https://rumble.com/vabc-some-video.html',
                'https://www.facebook.com/watch/?v=123',
                'https://x.com/user/status/123',
                'https://webinar.zoom.us/rec/play/abc',
                'https://streamyard.com/rec/abc',
                'https://www.linkedin.com/events/123']:
        assert svc.detect_source_type(url) == 'generic', url
    # Raw video-file links stay on the byte downloader.
    assert svc.detect_source_type('https://cdn.example.com/movie.mp4') == 'direct_url'
    assert svc.detect_source_type('https://example.com/live/stream.ts') == 'direct_url'
    # Share links keep routing to yt-dlp even when the path names a file:
    # their raw download needs platform-specific parameters.
    assert svc.detect_source_type('https://www.dropbox.com/s/abc/movie.mp4?dl=0') == 'generic'


def test_ten_hour_limits_are_declared_once():
    from clip_engine.config import get_settings
    import clip_engine.services.video_downloader as downloader
    assert get_settings().max_download_duration_seconds == 10 * 3600
    assert downloader.DOWNLOAD_DEADLINE_SECONDS == 12 * 3600
    assert downloader.MAX_SOURCE_BYTES == 20 * 1000 ** 3
