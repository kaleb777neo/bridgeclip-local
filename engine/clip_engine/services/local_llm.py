"""Local chat backend: Ollama's native /api/chat, shaped like OpenRouter.

Call sites keep building their OpenRouter payload and hand it to
:func:`chat_completion_for`. In cloud mode that call goes to OpenRouter
unchanged (the caller's client is used); in local mode the payload is
translated to Ollama's native API, which exposes what local planning needs:
JSON-schema structured output, explicit context size, and disabling thinking
mode on models like Qwen3 that would otherwise burn tokens before the JSON.
"""

import json
import logging
from typing import Any, Optional

import httpx

from .openrouter import OpenRouterError, chat_completion, message_text

logger = logging.getLogger(__name__)

# A 16k-token local generation at laptop-GPU speeds can take minutes; the cap
# exists only to eventually free the job, not to cut off healthy generations.
LOCAL_CHAT_TIMEOUT_SECONDS = 1800.0
LOCAL_CONNECT_TIMEOUT_SECONDS = 5.0
MAX_LOCAL_RESPONSE_BYTES = 8 * 1024 * 1024


def is_local_backend(settings) -> bool:
    return getattr(settings, "ai_backend", "cloud") == "local"


def _text_content(content: Any) -> str:
    """Flatten OpenAI-style multipart content to plain text for Ollama."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "") for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    return "" if content is None else str(content)


def normalize_payload(payload: dict[str, Any], settings) -> dict[str, Any]:
    """Translate an OpenRouter chat payload to Ollama's /api/chat body.

    OpenRouter-only fields (`models` fallback chains, `reasoning` effort,
    `plugins`, `provider` routing, `usage` cost accounting) have no Ollama
    equivalent and are dropped. `response_format: json_schema` becomes
    Ollama's `format`, which enforces the schema during decoding.
    """
    response_format = payload.get("response_format") or {}
    schema = (response_format.get("json_schema") or {}).get("schema")

    body: dict[str, Any] = {
        "model": payload["model"],
        "messages": [
            {
                "role": message.get("role", "user"),
                "content": _text_content(message.get("content")),
            }
            for message in payload.get("messages", [])
        ],
        "stream": False,
        # Strict JSON beats creative sampling for planning output.
        "options": {
            "temperature": payload.get("temperature", 0.2),
            "num_predict": payload.get("max_tokens", 16000),
            "num_ctx": getattr(settings, "local_planner_context_tokens", 16384),
        },
    }
    if schema is not None:
        body["format"] = schema
    # Qwen3 & co. emit a thinking preamble by default; it slows planning and
    # can bleed into JSON. Older Ollama servers reject unknown fields, so the
    # caller retries once without it on a 400.
    body["think"] = False
    return body


def _finish_reason(response: dict) -> str:
    return "length" if response.get("done_reason") == "length" else "stop"


def _map_response(response: dict, model: str) -> dict:
    """Shape an Ollama /api/chat response like an OpenRouter completion."""
    message = response.get("message") or {}
    usage = {
        "prompt_tokens": response.get("prompt_eval_count", 0),
        "completion_tokens": response.get("eval_count", 0),
        "total_tokens": (response.get("prompt_eval_count", 0) or 0)
        + (response.get("eval_count", 0) or 0),
        "cost": None,
    }
    logger.info(
        "Local LLM usage (%s): %s prompt, %s completion, %.1fs total",
        model, usage["prompt_tokens"], usage["completion_tokens"],
        response.get("total_duration", 0) / 1e9,
    )
    return {
        "model": model,
        "choices": [
            {"message": {"content": message.get("content", "")},
             "finish_reason": _finish_reason(response)}
        ],
        "usage": usage,
    }


async def _post_chat(base_url: str, body: dict[str, Any], timeout: httpx.Timeout) -> dict:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        response = await client.post(f"{base_url.rstrip('/')}/api/chat", json=body)
    if len(response.content) > MAX_LOCAL_RESPONSE_BYTES:
        raise OpenRouterError("Local AI response exceeds the size limit")
    if response.status_code == 404:
        raise OpenRouterError(
            f"Local AI request failed: model '{body.get('model')}' is not installed in Ollama. "
            "Run the offline setup in Settings → Local AI."
        )
    if response.status_code == 400:
        text = response.text[:300].lower()
        if "think" in text:
            raise UnsupportedThinkParameter()
        raise OpenRouterError(f"Local AI request failed (Ollama 400: {text[:160]})")
    if response.status_code != 200:
        # 503 "model is loading" and startup races are worth one retry.
        raise OpenRouterError(
            f"Local AI request failed (Ollama {response.status_code})",
            retryable=response.status_code in (429, 500, 502, 503, 504),
        )
    try:
        return json.loads(response.content)
    except (ValueError, UnicodeError, RecursionError):
        raise OpenRouterError("Local AI returned invalid JSON") from None


class UnsupportedThinkParameter(Exception):
    """The Ollama server predates the `think` request parameter."""


async def ollama_chat(settings, payload: dict[str, Any]) -> tuple[dict, dict]:
    from .run_diagnostics import model_request

    base_url = getattr(settings, "local_llm_base_url", "http://127.0.0.1:11434")
    model = payload.get("model", "")
    body = normalize_payload(payload, settings)
    timeout = httpx.Timeout(LOCAL_CHAT_TIMEOUT_SECONDS, connect=LOCAL_CONNECT_TIMEOUT_SECONDS)
    with model_request(model) as call:
        try:
            try:
                response = await _post_chat(base_url, body, timeout)
            except UnsupportedThinkParameter:
                # Older server: same request without the thinking toggle.
                body.pop("think", None)
                response = await _post_chat(base_url, body, timeout)
        except (httpx.TimeoutException, httpx.TransportError) as error:
            raise OpenRouterError(
                "Local AI request failed: Ollama is not reachable at "
                f"{base_url}. Start it from Settings → Local AI.",
                retryable=True,
            ) from error
        mapped = _map_response(response, model)
        usage = mapped["usage"]
        call.update(
            success=True,
            input_tokens=usage["prompt_tokens"],
            output_tokens=usage["completion_tokens"],
            cost_usd=None,
        )
        content, _ = message_text(mapped)
        if not content:
            raise OpenRouterError("Local AI returned no content")
        return mapped, usage


async def chat_completion_for(
    settings, payload: dict[str, Any], cloud_client: Optional[httpx.AsyncClient],
) -> tuple[dict, dict]:
    """One chat entry point for both backends.

    `cloud_client` is the OpenRouter client the caller would have used; it is
    only touched in cloud mode, so local runs never build it.
    """
    if is_local_backend(settings):
        return await ollama_chat(settings, payload)
    if cloud_client is None:
        raise OpenRouterError("Cloud chat requested without an OpenRouter client")
    return await chat_completion(
        cloud_client, payload, provider=getattr(settings, "llm_provider", "openrouter"),
    )
