"""
Shared chat-completions call used by the clip planner, coherence repair and
the layout vision step. Speaks the OpenAI chat-completions dialect to
OpenRouter (default) and to other OpenAI-compatible providers such as
NVIDIA's hosted NIM API (`provider="nvidia"`). Normalizes errors into
retryable / fatal and extracts billed usage.
"""

import asyncio
import json
import logging
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)

# HTTP statuses worth retrying (rate limits, provider outages, timeouts).
MAX_CHAT_RESPONSE_BYTES = 2 * 1024 * 1024

RETRYABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504}

# NVIDIA's free tier throttles at roughly 40 requests per minute; when NIM
# answers 429 it sends Retry-After. Honouring it here keeps one planner
# attempt from burning its whole backoff loop on immediately-rejected calls.
NVIDIA_MAX_RATE_LIMIT_RETRIES = 2
NVIDIA_MAX_RETRY_AFTER_SECONDS = 60.0

# Payload fields only OpenRouter understands: server-side response healing,
# provider routing, the cross-vendor fallback chain, OpenRouter reasoning
# controls and OpenRouter-hosted tools such as web search.
OPENROUTER_ONLY_FIELDS = ("plugins", "provider", "models", "reasoning", "tools")


class OpenRouterError(Exception):
    """A chat-completions request failed. `retryable` marks transient failures.

    `detail` carries up to 200 characters of the response body for internal
    error classification only; it must never be rendered into the message,
    which reaches logs and the desktop UI (provider bodies are untrusted).
    """

    def __init__(self, message: str, retryable: bool = False,
                 status: Optional[int] = None, retry_after: Optional[float] = None,
                 detail: str = ""):
        super().__init__(message)
        self.retryable = retryable
        self.status = status
        self.retry_after = retry_after
        self.detail = detail


def is_nvidia_backend(settings) -> bool:
    """Whether settings route cloud chat through NVIDIA's hosted NIM API."""
    return getattr(settings, "ai_backend", "cloud") == "nvidia"


def sanitize_payload(payload: dict[str, Any], provider: str = "openrouter") -> dict[str, Any]:
    """Drop fields the target chat provider does not speak.

    NVIDIA NIM serves plain OpenAI chat completions, so OpenRouter-only
    routing fields are removed. The reasoning effort becomes a plain
    temperature so planning output stays deterministic without
    provider-specific controls.
    """
    if provider != "nvidia":
        return payload
    clean = {k: v for k, v in payload.items() if k not in OPENROUTER_ONLY_FIELDS}
    if "reasoning" in payload and "temperature" not in clean:
        clean["temperature"] = 0.2
    return clean


def _rejects_response_format(error: OpenRouterError) -> bool:
    """Whether a 400 rejection is about `response_format` constrained decoding."""
    detail = (getattr(error, "detail", "") or "").lower()
    return any(marker in detail for marker in ("response_format", "json_schema", "guided_json"))


def json_schema_format(name: str, schema: dict[str, Any]) -> dict[str, Any]:
    """`response_format` for strict JSON-schema structured output."""
    return {
        "type": "json_schema",
        "json_schema": {"name": name, "strict": True, "schema": schema},
    }


def apply_reasoning(payload: dict[str, Any], effort: str, temperature: float = 0.2) -> None:
    """Set reasoning effort, or a temperature when reasoning is off.

    Reasoning models ignore or reject temperature, so it is only sent with
    effort "none".
    """
    if effort == "none":
        payload["temperature"] = temperature
    else:
        payload["reasoning"] = {"effort": effort, "exclude": True}


def message_text(body: dict[str, Any]) -> tuple[Optional[str], Optional[str]]:
    """Return (content, finish_reason) of the first choice."""
    choice = (body.get("choices") or [{}])[0]
    content = (choice.get("message") or {}).get("content")
    if isinstance(content, list):
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return content, choice.get("finish_reason")


async def chat_completion(
    client: httpx.AsyncClient, payload: dict[str, Any], provider: str = "openrouter",
) -> tuple[dict, dict]:
    from .run_diagnostics import model_request
    payload = sanitize_payload(payload, provider)
    label = "NVIDIA" if provider == "nvidia" else "OpenRouter"
    # Some NIM models reject json_schema constrained decoding; the planner
    # prompt already demands JSON and every parse is validated, so one retry
    # without the wire-level schema recovers them.
    schema_retry_available = provider == "nvidia" and "response_format" in payload
    rate_retries = NVIDIA_MAX_RATE_LIMIT_RETRIES if provider == "nvidia" else 0
    with model_request(payload.get('model', '')) as call:
        while True:
            try:
                body, usage = await _chat_completion(client, payload, label)
                break
            except OpenRouterError as error:
                if (schema_retry_available and error.status == 400
                        and _rejects_response_format(error)):
                    schema_retry_available = False
                    payload = {k: v for k, v in payload.items() if k != "response_format"}
                    continue
                if error.retry_after is not None and rate_retries > 0:
                    rate_retries -= 1
                    await asyncio.sleep(error.retry_after)
                    continue
                raise
        raw = body.get('usage') or {}
        call.update(success=True, input_tokens=raw.get('prompt_tokens'),
                    output_tokens=raw.get('completion_tokens'), cost_usd=raw.get('cost'))
        return body, usage


async def _chat_completion(
    client: httpx.AsyncClient,
    payload: dict[str, Any],
    label: str = "OpenRouter",
) -> tuple[dict, dict]:
    """POST /chat/completions.

    Returns:
        (response_json, usage) where usage has prompt_tokens,
        completion_tokens, total_tokens and `cost` in USD (None if the
        provider did not report it).

    Raises:
        OpenRouterError: `retryable=True` for rate limits, provider outages
        and network failures.
    """
    model = payload.get("model", "")
    try:
        async with client.stream(
            "POST", "/chat/completions", json=payload,
            headers={"Accept-Encoding": "identity"}, follow_redirects=False,
        ) as response:
            # Do not hand attacker-controlled compressed bodies to an unbounded
            # decompressor. The request explicitly negotiates an identity body.
            if response.headers.get("content-encoding", "identity").lower() != "identity":
                raise OpenRouterError(f"{label} returned an unsupported response encoding")
            content = bytearray()
            async for chunk in response.aiter_raw():
                if len(chunk) > MAX_CHAT_RESPONSE_BYTES - len(content):
                    raise OpenRouterError(f"{label} response exceeds the size limit")
                content.extend(chunk)
            status = response.status_code
            retry_after = _parse_retry_after(response.headers.get("retry-after"))
    except (httpx.TimeoutException, httpx.TransportError):
        raise OpenRouterError(f"{label} request failed", retryable=True) from None

    if status == 402 and label == "OpenRouter":
        raise OpenRouterError(
            "OpenRouter account is out of credits. Add credits at openrouter.ai/credits.",
            status=status,
        )
    if status != 200:
        raise OpenRouterError(
            f"{label} API error ({status})",
            retryable=status in RETRYABLE_STATUS_CODES,
            status=status,
            retry_after=retry_after,
            detail=content[:200].decode("utf-8", "replace"),
        )
    try:
        body = json.loads(content)
    except (ValueError, UnicodeError, RecursionError):
        raise OpenRouterError(f"{label} returned invalid JSON") from None
    if not isinstance(body, dict):
        raise OpenRouterError(f"{label} returned an invalid response")

    # Providers can return 200 with an upstream error in the body.
    if body.get("error"):
        raise OpenRouterError(f"{label} provider error", retryable=True)

    usage = body.get("usage") or {}
    cost = usage.get("cost")
    usage_data = {
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": usage.get("completion_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
        "cost": float(cost) if cost is not None else None,
    }
    reasoning_tokens = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens", 0)

    logger.info(
        f"{label} usage ({body.get('model', model)}): "
        f"{usage_data['prompt_tokens']} prompt, "
        f"{usage_data['completion_tokens']} completion "
        f"({reasoning_tokens} reasoning), cost=${usage_data['cost'] if cost is not None else 'n/a'}"
    )
    return body, usage_data


def _parse_retry_after(value: Optional[str]) -> Optional[float]:
    """Seconds to wait from a Retry-After header, bounded for safety."""
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        return None
    if seconds < 0:
        return None
    return min(seconds, NVIDIA_MAX_RETRY_AFTER_SECONDS)
