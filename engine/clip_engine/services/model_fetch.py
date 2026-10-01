"""Fetch faster-whisper model weights with an automatic mirror fallback.

Primary source is huggingface.co through faster-whisper/huggingface_hub. Some
networks (notably datacenter IP ranges) get refused there with 401 even for
public repos; in that case the same public CT2 conversions are downloaded
from ModelScope into the dash-layout folder the engine loads first, so the
next run needs no network at all.

Progress lines ``... NN%`` go to stderr; the desktop setup UI parses them.
Run: python -c "from clip_engine.services.model_fetch import ensure_model; \
ensure_model('<hf-repo>', '<models-dir>')"
"""

import json
import sys
import time
import urllib.request
from pathlib import Path

MODELSCOPE_MIRRORS = {
    "Systran/faster-whisper-large-v3-turbo": "pengzhendong/faster-whisper-large-v3-turbo",
    "Systran/faster-whisper-large-v3": "pengzhendong/faster-whisper-large-v3",
    "Systran/faster-whisper-medium": "pengzhendong/faster-whisper-medium",
}

FILE_LIST_URL = "https://modelscope.cn/api/v1/models/{repo}/repo/files?Revision=master"
FILE_URL = "https://modelscope.cn/api/v1/models/{repo}/repo?Revision=master&FilePath={path}"

# ModelScope-side bookkeeping that faster-whisper never reads.
SKIP_FILES = {".gitattributes", "configuration.json"}
SKIP_SUFFIXES = (".md",)
CHUNK = 256 * 1024
TIMEOUT = 60


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _local_dir(models_root: str, repo: str) -> Path:
    return Path(models_root) / repo.replace("/", "-")


def _fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "BridgeClip-setup"})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


def _download_file(url: str, destination: Path, expected_size: int, done_bytes: int, total_bytes: int) -> None:
    """Download one file with resume, size verification and percent progress."""
    part = destination.with_suffix(destination.suffix + ".part")
    start = part.stat().st_size if part.exists() else 0
    if expected_size and start > expected_size:
        # A leftover part larger than the file would send an unsatisfiable
        # Range request (416) on every retry; start over instead.
        part.unlink(missing_ok=True)
        start = 0
    headers = {"User-Agent": "BridgeClip-setup"}
    if start:
        headers["Range"] = f"bytes={start}-"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response, open(part, "ab" if start else "wb") as output:
        if start and response.status == 200:
            # Server ignored the range request; restart rather than corrupt.
            output.seek(0)
            output.truncate()
            start = 0
        while True:
            chunk = response.read(CHUNK)
            if not chunk:
                break
            output.write(chunk)
            start += len(chunk)
            if total_bytes > 0:
                percent = min(99, int(100 * (done_bytes + start) / total_bytes))
                _log(f"downloading {destination.name} {percent}%")
    if expected_size and start != expected_size:
        raise IOError(f"size mismatch for {destination.name}: {start} != {expected_size}")
    part.replace(destination)


def _fetch_from_modelscope(repo: str, models_root: str) -> Path:
    mirror = MODELSCOPE_MIRRORS[repo]
    target = _local_dir(models_root, repo)
    listing = _fetch_json(FILE_LIST_URL.format(repo=mirror))
    files = [
        (file["Path"], int(file.get("Size") or 0))
        for file in listing.get("Data", {}).get("Files", [])
        if file["Path"] not in SKIP_FILES and not file["Path"].lower().endswith(SKIP_SUFFIXES)
    ]
    total = sum(size for _, size in files)
    done = 0
    target.mkdir(parents=True, exist_ok=True)
    for path, size in files:
        destination = target / path
        if destination.exists() and destination.stat().st_size == size:
            done += size
            continue
        _log(f"fetching {path} from the ModelScope mirror")
        last_error: Exception | None = None
        for attempt in (1, 2):
            try:
                _download_file(
                    FILE_URL.format(repo=mirror, path=path), destination, size, done, total,
                )
                last_error = None
                break
            except (OSError, IOError) as error:
                last_error = error
                _log(f"retrying {path} after {error}")
                time.sleep(2 * attempt)
        if last_error is not None:
            raise last_error
        done += size
    return target


def ensure_model(repo: str, models_root: str) -> None:
    """Make the weights for `repo` available under `models_root`.

    A complete dash-layout folder short-circuits; otherwise huggingface_hub
    downloads (resumable, cache layout), and a refused/blocked hub falls back
    to the ModelScope mirror writing the dash layout.
    """
    if (_local_dir(models_root, repo) / "model.bin").is_file():
        _log("weights already present")
        return
    try:
        from faster_whisper import WhisperModel

        WhisperModel(repo, device="cpu", compute_type="int8", download_root=models_root)
        _log("weights-ready")
        return
    except Exception as error:
        if repo not in MODELSCOPE_MIRRORS:
            raise
        _log(f"huggingface.co refused the download ({error}); using the ModelScope mirror")
    _fetch_from_modelscope(repo, models_root)
    if not (_local_dir(models_root, repo) / "model.bin").is_file():
        raise IOError("model.bin missing after download")
    _log("weights-ready")
