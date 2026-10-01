"""Offline transcription with faster-whisper (CTranslate2) on the local GPU.

The backend speaks the OpenRouter transcription response shape
(``{"text", "words": [{"word", "start", "end"}], "language", "usage"}``) so
TranscriptionService can reuse its chunk loop, word-timing validation and
segment building unchanged. Audio never leaves the machine.
"""

import logging
import os
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# faster-whisper model ids (Hugging Face repos are resolved by the library).
WHISPER_MODEL_REPOS = {
    "large-v3-turbo": "Systran/faster-whisper-large-v3-turbo",
    "large-v3": "Systran/faster-whisper-large-v3",
    "medium": "Systran/faster-whisper-medium",
}


def local_model_dirs(model_name: str) -> list[Path]:
    """User-placeable model folders, most specific first.

    The configured models dir comes first; the platform default follows, so
    weights placed manually (or by an earlier install with a different
    BRIDGECLIP_MODELS_DIR) still load.
    """
    repo = WHISPER_MODEL_REPOS.get(model_name, model_name)
    dashed = repo.replace("/", "-")
    dirs: list[Path] = []
    for root in (whisper_models_dir(), _default_models_dir()):
        candidate = root / dashed
        if candidate not in dirs:
            dirs.append(candidate)
    return dirs


def resolve_model_path(model_name: str) -> str:
    """Local model directory when its weights exist, else the HF repo id.

    A directory containing model.bin wins over the registry download: that is
    both the manual-install route and the offline-setup result.
    """
    for directory in local_model_dirs(model_name):
        if (directory / "model.bin").is_file():
            return str(directory)
    return WHISPER_MODEL_REPOS.get(model_name, model_name)


# Weights stay across jobs; keep them out of per-job work directories.
# BRIDGECLIP_MODELS_DIR is set by the desktop app to a user-data folder;
# source runs fall back to a cache under the user profile.
def _default_models_dir() -> Path:
    if os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        return Path(os.environ["LOCALAPPDATA"]) / "BridgeClip" / "models"
    return Path.home() / ".cache" / "bridgeclip" / "models"


def whisper_models_dir() -> Path:
    configured = os.environ.get("BRIDGECLIP_MODELS_DIR")
    if configured:
        return Path(configured)
    return _default_models_dir()


def whisper_model_available(model_name: str) -> bool:
    """True when the converted weights are already on disk (no download needed)."""
    if model_name not in WHISPER_MODEL_REPOS:
        return False
    if any((directory / "model.bin").is_file() for directory in local_model_dirs(model_name)):
        return True
    repo_dir = whisper_models_dir() / WHISPER_MODEL_REPOS[model_name].replace("/", os.sep)
    return (repo_dir / "model.bin").is_file()


def cuda_device_count() -> int:
    try:
        ensure_cuda_dlls()
        import ctranslate2
        return ctranslate2.get_cuda_device_count()
    except Exception:
        return 0


def ensure_cuda_dlls() -> None:
    """Make the pip-installed cuBLAS/cuDNN DLLs findable before ctranslate2 loads.

    The `nvidia-*-cu12` wheels place their DLLs in site-packages/nvidia/*/bin,
    which is not on the Windows DLL search path. Note ctranslate2 itself may
    fail to import before this runs, so import it lazily here, not at module
    top, and never let DLL bookkeeping break CPU-only runs.
    """
    if os.name != "nt":
        return
    import glob
    import site

    try:
        packages = set(site.getsitepackages())
        if hasattr(site, "getusersitepackages"):
            packages.add(site.getusersitepackages())
        for package_dir in packages:
            for bin_dir in glob.glob(os.path.join(package_dir, "nvidia", "*", "bin")):
                os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
                try:
                    os.add_dll_directory(bin_dir)
                except (OSError, AttributeError):
                    pass
    except Exception:
        logger.debug("Could not prepare NVIDIA DLL directories", exc_info=True)


class LocalWhisperError(Exception):
    """Raised when the local transcription stack is missing or fails."""


class LocalWhisperBackend:
    """Loads one faster-whisper model and keeps it for the whole job.

    The model is heavy; load it once per job (all chunks reuse it) and call
    :meth:`close` afterwards so the GPU memory is free for the local LLM
    planning stage that follows transcription in the pipeline.
    """

    def __init__(self, settings):
        self.settings = settings
        self._model: Any = None
        self._device: Optional[str] = None
        self._compute_type: Optional[str] = None

    def _resolve_device(self) -> tuple[str, str]:
        device = getattr(self.settings, "local_whisper_device", "auto")
        compute = getattr(self.settings, "local_whisper_compute_type", "auto")
        if device == "auto":
            device = "cuda" if cuda_device_count() > 0 else "cpu"
        if compute == "auto":
            compute = "float16" if device == "cuda" else "int8"
        return device, compute

    def _load(self) -> Any:
        if self._model is not None:
            return self._model
        model_name = getattr(self.settings, "local_whisper_model", "large-v3-turbo")
        if model_name not in WHISPER_MODEL_REPOS:
            raise LocalWhisperError(f"Unknown local Whisper model: {model_name}")
        model_source = resolve_model_path(model_name)
        try:
            ensure_cuda_dlls()
            from faster_whisper import WhisperModel
        except ImportError as error:
            raise LocalWhisperError(
                "Local transcription is not installed. Run 'Local AI' setup in Settings "
                "(pip install -r engine/requirements-local.txt)."
            ) from error
        device, compute = self._resolve_device()
        try:
            self._model = WhisperModel(
                model_source, device=device, compute_type=compute,
                download_root=str(whisper_models_dir()),
            )
        except (RuntimeError, OSError, ValueError) as error:
            if device != "cuda":
                raise LocalWhisperError(f"Could not load local Whisper on CPU: {error}") from error
            # Missing CUDA/cuDNN DLLs or an unsupported driver: fall back to
            # CPU int8 rather than failing the job.
            logger.warning("CUDA Whisper load failed (%s); falling back to CPU", error)
            device, compute = "cpu", "int8"
            self._model = WhisperModel(
                model_source, device=device, compute_type=compute,
                download_root=str(whisper_models_dir()),
            )
        self._device, self._compute_type = device, compute
        logger.info("Local Whisper ready: model=%s device=%s compute=%s", model_name, device, compute)
        return self._model

    def transcribe_chunk(
        self,
        wav_path: str,
        language: Optional[str],
        keyterms: Optional[list[str]],
        duration: float,
    ) -> dict:
        """Transcribe one WAV chunk and shape it like an OpenRouter response."""
        model = self._load()
        prompt = self._vocabulary_prompt(keyterms)
        segments, info = model.transcribe(
            wav_path,
            language=language or None,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            initial_prompt=prompt or None,
            condition_on_previous_text=False,
        )
        words: list[dict[str, Any]] = []
        for segment in segments:
            for word in segment.words or []:
                text = " ".join(word.word.split())
                if not text:
                    continue
                # Plain floats: numpy scalars fail the engine's strict
                # timing validation downstream.
                words.append({"word": text, "start": float(word.start), "end": float(word.end)})
        return {
            "text": " ".join(w["word"] for w in words),
            "words": words,
            "language": info.language,
            "usage": {"seconds": duration, "cost": 0.0},
        }

    @staticmethod
    def _vocabulary_prompt(keyterms: Optional[list[str]]) -> str:
        if not keyterms:
            return ""
        joined = ", ".join(keyterms[:20])
        return "Expected vocabulary: " + joined[:400]

    def close(self) -> None:
        """Release the model so its GPU memory is available to later stages."""
        if self._model is None:
            return
        try:
            import gc
            self._model = None
            gc.collect()
        except Exception:
            logger.warning("Could not fully release local Whisper memory")
            self._model = None
