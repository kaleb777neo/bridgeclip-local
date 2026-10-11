"""Reuse of already-downloaded source video, keyed by URL, inside the Library.

An automatic run downloads the full source, renders clips from it, then deletes it, so
"Edit this" used to fetch the same gigabytes from the network again. Runs keep their
download here instead, and an editor import takes the material from disk first: this
run's own copy, the cache, then any sibling run that imported the very same video.
"""
import hashlib
import json
import os
import stat as stat_module
from pathlib import Path

CACHE_DIR_NAME = '.source-cache'
CACHE_BUDGET_BYTES = 5 * 1024 ** 3
# A stub smaller than this is a leftover, never a video. Real content is proven by a
# media probe before reuse, so this floor only filters empty files and partial stubs.
MIN_USABLE_BYTES = 1024
COPY_CHUNK_BYTES = 8 * 1024 * 1024
# Job manifests are a few hundred kilobytes; a huge one is not a run's metadata.
MAX_MANIFEST_BYTES = 8 * 1024 * 1024


def is_remote_url(url) -> bool:
    return isinstance(url, str) and url.lower().startswith(('http://', 'https://'))


def library_root(library) -> Path | None:
    """The Library folder itself, or None when it isn't there."""
    if not library:
        return None
    try:
        root = Path(library).resolve(strict=True)
    except OSError:
        return None
    return root if root.is_dir() else None


def cache_directory(library) -> Path | None:
    """The Library's cache folder, or None when the Library itself isn't usable."""
    root = library_root(library)
    return root / CACHE_DIR_NAME if root is not None else None


def entry_path(library, url) -> Path | None:
    if not is_remote_url(url):
        return None
    directory = cache_directory(library)
    if directory is None:
        return None
    return directory / (hashlib.sha256(url.encode('utf-8')).hexdigest()[:24] + '.mp4')


def is_usable(path) -> bool:
    """A regular file with real video bytes, never a symlink, stub or empty shell."""
    try:
        info = os.lstat(str(path))
    except OSError:
        return False
    return stat_module.S_ISREG(info.st_mode) and info.st_size >= MIN_USABLE_BYTES


def _copy(source: Path, destination: Path, progress) -> bool:
    size = os.path.getsize(str(source))
    copied = 0
    temporary = str(destination) + '.cache-tmp'
    try:
        with open(str(source), 'rb') as reader, open(temporary, 'wb') as writer:
            while chunk := reader.read(COPY_CHUNK_BYTES):
                writer.write(chunk)
                copied += len(chunk)
                if progress:
                    progress(copied, size)
        os.replace(temporary, str(destination))
        return True
    except OSError:
        try:
            os.remove(temporary)
        except OSError:
            pass
        return False


def _place(source: Path, destination: Path, progress) -> bool:
    """Copy the cached bytes into the run.

    Deliberately not a hardlink: the editor's "free media" action promises to reclaim
    the run's bytes, which a shared file couldn't do.
    """
    try:
        if destination.is_symlink() or destination.exists():
            os.remove(str(destination))
    except OSError:
        return False
    return _copy(source, destination, progress)


def library_copy(library, url) -> Path | None:
    """Another run's imported copy of this exact video, already on disk.

    A run whose editor import finished holds the whole original in its own folder, so
    every later run of the same video can open the editor without the network. Only the
    URL recorded in that run's manifest counts as proof; no size or duration guessing,
    because yt-dlp can pick a different format for the same video next time.
    """
    root = library_root(library)
    if root is None or not is_remote_url(url):
        return None
    try:
        children = sorted(root.iterdir(), key=str)
    except OSError:
        return None
    for directory in children:
        try:
            if directory.name.startswith('.') or directory.is_symlink() or not directory.is_dir():
                continue
            manifest = directory / 'job_output.json'
            if not manifest.is_file() or manifest.stat().st_size > MAX_MANIFEST_BYTES:
                continue
            if json.loads(manifest.read_text(encoding='utf-8', errors='replace')).get('source_video_url') != url:
                continue
        except (OSError, ValueError):
            continue
        video = directory / 'editor-source.mp4'
        if is_usable(video):
            return video
    return None


def copy_into(source, destination, progress=None) -> bool:
    """Place a video file that already proved itself into the run as its source."""
    return _place(Path(source), Path(destination), progress)


def retain(library, url, video_path) -> bool:
    """Move a job's finished download into the cache. Best effort: never fails a run.

    The copy is moved rather than linked so no two names share bytes: the Library's
    disk readouts and the editor's "free media" action both report real sizes.
    """
    cached = entry_path(library, url)
    if cached is None or not is_usable(video_path):
        return False
    try:
        cached.parent.mkdir(parents=True, exist_ok=True)
        staging = cached.parent / (cached.name + '.moving')
        try:
            os.rename(str(video_path), str(staging))
        except OSError:
            # The job's work folder can be on another drive than the Library, where a
            # rename is impossible. Copying is slower but the run still keeps its download.
            if not _copy(Path(video_path), staging, None):
                return False
    except OSError:
        return False
    try:
        os.replace(str(staging), str(cached))
    except OSError:
        try:
            os.remove(str(staging))
        except OSError:
            pass
        return False
    enforce_budget(library)
    return True


def enforce_budget(library, budget=CACHE_BUDGET_BYTES) -> None:
    """Drop the least recently used copies until the cache fits its budget."""
    directory = cache_directory(library)
    if directory is None:
        return
    entries = []
    total = 0
    try:
        names = os.listdir(str(directory))
    except OSError:
        return
    for name in names:
        if not name.endswith('.mp4'):
            continue
        try:
            info = os.lstat(str(directory / name))
        except OSError:
            continue
        if stat_module.S_ISREG(info.st_mode):
            entries.append((directory / name, info.st_size, info.st_mtime))
            total += info.st_size
    for path, size, _ in sorted(entries, key=lambda item: item[2]):
        if total <= budget:
            break
        try:
            os.remove(str(path))
            total -= size
        except OSError:
            pass
