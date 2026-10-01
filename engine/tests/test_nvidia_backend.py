"""NVIDIA NIM backend regressions: routing, payload sanitization, config.

All offline: no NIM endpoint is contacted (httpx.MockTransport), no whisper
weights, no cloud credentials.
"""

import json
from types import SimpleNamespace

import httpx
import pytest

from clip_engine.config import Settings
from clip_engine.services import openrouter
from clip_engine.services.openrouter import (
    OpenRouterError,
    _parse_retry_after,
    chat_completion,
    is_nvidia_backend,
    sanitize_payload,
)
from clip_engine.services.intelligence_planner import IntelligencePlannerService
from clip_engine.services.transcription_service import TranscriptionService

NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"


def nvidia_env(monkeypatch, **extra):
    monkeypatch.setenv("AI_BACKEND", "nvidia")
    monkeypatch.setenv("NVIDIA_API_KEY", "nvapi-test")
    for key, value in extra.items():
        monkeypatch.setenv(key, value)


# ---------------------------------------------------------------------------
# Settings routing
# ---------------------------------------------------------------------------

def test_nvidia_backend_swaps_cloud_defaults(monkeypatch):
    nvidia_env(monkeypatch)
    settings = Settings()
    assert settings.llm_provider == "nvidia"
    assert settings.llm_base_url == NVIDIA_BASE_URL
    assert settings.llm_api_key == "nvapi-test"
    assert settings.planner_model == "deepseek-ai/deepseek-v3.1"
    assert settings.editorial_repair_model == "meta/llama-3.3-70b-instruct"
    assert settings.get_planner_fallback_models() == []
    assert settings.effective_planner_max_output_tokens == settings.nvidia_planner_max_output_tokens
    # NIM has no transcription endpoint; whisper runs locally.
    assert settings.transcription_provider == "local"
    assert settings.transcription_model == f"local/whisper-{settings.local_whisper_model}"


def test_nvidia_backend_keeps_explicit_model_env(monkeypatch):
    nvidia_env(monkeypatch, PLANNER_MODEL="qwen/qwen3-32b",
               EDITORIAL_REPAIR_MODEL="meta/llama-3.3-70b-instruct")
    settings = Settings()
    assert settings.planner_model == "qwen/qwen3-32b"


def test_cloud_backend_stays_on_openrouter(monkeypatch):
    monkeypatch.setenv("AI_BACKEND", "cloud")
    settings = Settings()
    assert settings.llm_provider == "openrouter"
    assert settings.llm_base_url == settings.openrouter_base_url
    assert settings.planner_model == "anthropic/claude-opus-5.5"
    assert settings.transcription_provider == "openrouter"


def test_local_backend_validator_is_not_affected(monkeypatch):
    monkeypatch.setenv("AI_BACKEND", "local")
    monkeypatch.setenv("LOCAL_PLANNER_MODEL", "qwen3:8b")
    settings = Settings()
    assert settings.planner_model == "qwen3:8b"
    assert settings.llm_provider == "openrouter"


def test_is_nvidia_backend_tolerates_missing_attribute():
    assert is_nvidia_backend(SimpleNamespace(ai_backend="nvidia")) is True
    assert is_nvidia_backend(SimpleNamespace(ai_backend="cloud")) is False
    assert is_nvidia_backend(SimpleNamespace()) is False


# ---------------------------------------------------------------------------
# Payload sanitization
# ---------------------------------------------------------------------------

def full_cloud_payload():
    return {
        "model": "deepseek-ai/deepseek-v3.1",
        "messages": [{"role": "user", "content": "transcript"}],
        "max_tokens": 16000,
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "clip_plan", "strict": True,
                                            "schema": {"type": "object"}}},
        "models": ["fallback/a", "fallback/b"],
        "reasoning": {"effort": "medium", "exclude": True},
        "plugins": [{"id": "response-healing"}],
        "provider": {"require_parameters": True},
        "tools": [{"type": "openrouter:web_search"}],
    }


def test_sanitize_strips_openrouter_only_fields():
    clean = sanitize_payload(full_cloud_payload(), "nvidia")
    for absent in ("models", "reasoning", "plugins", "provider", "tools"):
        assert absent not in clean
    # The reasoning effort becomes a plain temperature for determinism.
    assert clean["temperature"] == 0.2
    assert clean["response_format"]["type"] == "json_schema"
    assert clean["model"] == "deepseek-ai/deepseek-v3.1"


def test_sanitize_keeps_explicit_temperature():
    payload = full_cloud_payload()
    payload["temperature"] = 0.4
    clean = sanitize_payload(payload, "nvidia")
    assert clean["temperature"] == 0.4


def test_sanitize_leaves_openrouter_payload_untouched():
    payload = full_cloud_payload()
    assert sanitize_payload(payload, "openrouter") is payload


# ---------------------------------------------------------------------------
# Wire behaviour through the real streaming client
# ---------------------------------------------------------------------------

class _Chunked(httpx.AsyncByteStream):
    """A one-chunk body so the real streaming reader exercises aiter_raw."""

    def __init__(self, data: bytes):
        self.data = data

    async def __aiter__(self):
        yield self.data


def reply(status=200, payload=None, text="", headers=None):
    data = json.dumps(payload).encode() if payload is not None else text.encode()
    return httpx.Response(status, stream=_Chunked(data), headers=headers)


def completion_body():
    return {
        "model": "deepseek-ai/deepseek-v3.1",
        "choices": [{"message": {"content": "{\"clips\": []}"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }


@pytest.mark.asyncio
async def test_nvidia_chat_sends_sanitized_payload():
    captured = {}

    async def handle(request):
        captured["url"] = str(request.url)
        captured["payload"] = json.loads(request.content)
        return reply(200, completion_body())

    async with httpx.AsyncClient(
        base_url=NVIDIA_BASE_URL,
        headers={"Authorization": "Bearer nvapi-test"},
        transport=httpx.MockTransport(handle),
    ) as client:
        body, usage = await chat_completion(client, full_cloud_payload(), provider="nvidia")

    assert captured["url"] == f"{NVIDIA_BASE_URL}/chat/completions"
    for absent in ("models", "reasoning", "plugins", "provider", "tools"):
        assert absent not in captured["payload"], absent
    assert captured["payload"]["response_format"]["type"] == "json_schema"
    assert usage["prompt_tokens"] == 10 and usage["cost"] is None
    assert body["choices"][0]["message"]["content"] == "{\"clips\": []}"


@pytest.mark.asyncio
async def test_openrouter_chat_keeps_routing_fields():
    captured = {}

    async def handle(request):
        captured["payload"] = json.loads(request.content)
        return reply(200, completion_body())

    async with httpx.AsyncClient(
        base_url="https://openrouter.ai/api/v1",
        transport=httpx.MockTransport(handle),
    ) as client:
        await chat_completion(client, full_cloud_payload())

    assert captured["payload"]["plugins"] == [{"id": "response-healing"}]
    assert captured["payload"]["models"] == ["fallback/a", "fallback/b"]


@pytest.mark.asyncio
async def test_nvidia_rate_limit_honors_retry_after():
    calls = []

    async def handle(request):
        calls.append(json.loads(request.content))
        if len(calls) == 1:
            return reply(429, text="slow down", headers={"retry-after": "0"})
        return reply(200, completion_body())

    async with httpx.AsyncClient(
        base_url=NVIDIA_BASE_URL, transport=httpx.MockTransport(handle),
    ) as client:
        body, _ = await chat_completion(client, full_cloud_payload(), provider="nvidia")

    assert len(calls) == 2
    assert body["choices"][0]["message"]["content"]


@pytest.mark.asyncio
async def test_nvidia_rate_limit_gives_up_after_bounded_retries():
    calls = []

    async def handle(request):
        calls.append(1)
        return reply(429, text="slow down", headers={"retry-after": "0"})

    async with httpx.AsyncClient(
        base_url=NVIDIA_BASE_URL, transport=httpx.MockTransport(handle),
    ) as client:
        with pytest.raises(OpenRouterError) as error:
            await chat_completion(client, full_cloud_payload(), provider="nvidia")

    assert error.value.retryable is True
    assert error.value.status == 429
    # One attempt plus the two bounded in-call retries.
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_nvidia_schema_rejection_retries_without_response_format():
    calls = []

    async def handle(request):
        calls.append(json.loads(request.content))
        if len(calls) == 1:
            return reply(400, payload={"error": {"message":
                "response_format json_schema is not supported by this model"}})
        return reply(200, completion_body())

    async with httpx.AsyncClient(
        base_url=NVIDIA_BASE_URL, transport=httpx.MockTransport(handle),
    ) as client:
        body, _ = await chat_completion(client, full_cloud_payload(), provider="nvidia")

    assert "response_format" in calls[0]
    assert "response_format" not in calls[1]
    assert calls[1]["temperature"] == 0.2
    assert body["choices"][0]["message"]["content"]


@pytest.mark.asyncio
async def test_nvidia_unrelated_400_is_raised_without_retry():
    calls = []

    async def handle(request):
        calls.append(1)
        return reply(400, payload={"error": {"message": "unknown field: frobnicate"}})

    async with httpx.AsyncClient(
        base_url=NVIDIA_BASE_URL, transport=httpx.MockTransport(handle),
    ) as client:
        with pytest.raises(OpenRouterError) as error:
            await chat_completion(client, full_cloud_payload(), provider="nvidia")

    assert len(calls) == 1
    assert "NVIDIA API error (400)" in str(error.value)


@pytest.mark.asyncio
async def test_nvidia_auth_error_is_fatal_and_sanitized():
    async def handle(request):
        return reply(401, payload={"error": {"message": "invalid key nvapi-secret"}})

    async with httpx.AsyncClient(
        base_url=NVIDIA_BASE_URL, transport=httpx.MockTransport(handle),
    ) as client:
        with pytest.raises(OpenRouterError) as error:
            await chat_completion(client, full_cloud_payload(), provider="nvidia")

    assert str(error.value) == "NVIDIA API error (401)"
    assert error.value.retryable is False
    assert "nvapi-secret" not in str(error.value)


def test_retry_after_parsing_is_bounded():
    assert _parse_retry_after(None) is None
    assert _parse_retry_after("abc") is None
    assert _parse_retry_after("-1") is None
    assert _parse_retry_after("2") == 2.0
    assert _parse_retry_after("3600") == 60.0


# ---------------------------------------------------------------------------
# Planner and transcription routing
# ---------------------------------------------------------------------------

def nvidia_planner_settings(**overrides):
    base = dict(
        ai_backend="nvidia",
        llm_provider="nvidia",
        llm_base_url=NVIDIA_BASE_URL,
        llm_api_key="nvapi-test",
        clipping_mode="quality",
        planner_reasoning_effort="medium",
        planner_max_output_tokens=32000,
        effective_planner_max_output_tokens=16000,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_planner_payload_is_sanitized_for_nvidia():
    planner = IntelligencePlannerService()
    planner.settings = nvidia_planner_settings()
    payload = planner._build_request_payload(
        "deepseek-ai/deepseek-v3.1", [], [{"role": "user", "content": "transcript"}])
    for absent in ("models", "reasoning", "plugins", "provider"):
        assert absent not in payload, absent
    assert payload["temperature"] == 0.2
    assert payload["max_tokens"] == 16000
    assert payload["response_format"]["type"] == "json_schema"


def test_planner_payload_keeps_routing_for_cloud():
    planner = IntelligencePlannerService()
    planner.settings = SimpleNamespace(
        ai_backend="cloud", llm_provider="openrouter", clipping_mode="quality",
        planner_reasoning_effort="medium", planner_max_output_tokens=32000,
        effective_planner_max_output_tokens=32000,
    )
    payload = planner._build_request_payload(
        "anthropic/claude-opus-5.5", ["openai/gpt-6-sol"], [{"role": "user", "content": "t"}])
    assert payload["plugins"] == [{"id": "response-healing"}]
    assert payload["models"] == ["openai/gpt-6-sol"]
    assert payload["reasoning"] == {"effort": "medium", "exclude": True}


def test_transcription_routes_local_for_nvidia():
    svc = TranscriptionService.__new__(TranscriptionService)
    svc.settings = SimpleNamespace(ai_backend="nvidia")
    assert svc._is_local() is True
    svc.settings = SimpleNamespace(ai_backend="cloud")
    assert svc._is_local() is False
