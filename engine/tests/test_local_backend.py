"""Local AI backend regressions: payload translation, whisper mapping, config.

All offline: no Ollama server, no model weights, no cloud credentials.
"""

import json
from types import SimpleNamespace

import pytest

from clip_engine.services import local_llm
from clip_engine.services.local_llm import (
    is_local_backend,
    normalize_payload,
    _map_response,
    chat_completion_for,
    ollama_chat,
    UnsupportedThinkParameter,
)
from clip_engine.services import transcription_service as stt
from clip_engine.services.intelligence_planner import (
    IntelligencePlannerService,
    ClipPlanResponse,
    ClipPlanSegment,
    MAX_TITLE_WORDS,
    _title_is_usable,
    _title_needs_repair,
    _title_is_foreign,
    _spoken_vocabulary,
    _trimmed_title,
    _window_overlap_ratio,
    LOCAL_TRANSCRIPT_WINDOW_CHARS,
    LOCAL_MAX_CLIPS_PER_REQUEST,
)
from clip_engine.services.transcription_service import TranscriptionResult
from clip_engine.services import model_fetch


def local_settings(**overrides):
    base = dict(
        ai_backend="local",
        local_llm_base_url="http://127.0.0.1:11434",
        local_planner_model="qwen3:8b",
        local_repair_model="qwen3:8b",
        local_planner_context_tokens=16384,
        planner_max_output_tokens=32000,
        local_planner_max_output_tokens=16000,
        planner_model="qwen3:8b",
    )
    base.update(overrides)
    return SimpleNamespace(**base)


# ---------------------------------------------------------------------------
# Payload normalization
# ---------------------------------------------------------------------------

def openrouter_payload():
    return {
        "model": "qwen3:8b",
        "messages": [
            {"role": "system", "content": "plan clips"},
            {"role": "user", "content": [{"type": "text", "text": "transcript"}]},
        ],
        "max_tokens": 12000,
        "temperature": 0.3,
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "clip_plan", "strict": True, "schema": {"type": "object"}}},
        "models": ["fallback/a", "fallback/b"],
        "reasoning": {"effort": "medium", "exclude": True},
        "plugins": [{"id": "response-healing"}],
        "provider": {"require_parameters": True},
    }


def test_normalize_payload_keeps_meaningful_fields():
    body = normalize_payload(openrouter_payload(), local_settings())
    assert body["model"] == "qwen3:8b"
    assert body["stream"] is False
    assert body["think"] is False
    # OpenRouter-only routing and healing fields are dropped.
    for absent in ("models", "reasoning", "plugins", "provider", "response_format"):
        assert absent not in body
    assert body["messages"] == [
        {"role": "system", "content": "plan clips"},
        {"role": "user", "content": "transcript"},
    ]


def test_normalize_payload_maps_schema_and_budget():
    settings = local_settings(local_planner_context_tokens=8192)
    body = normalize_payload(openrouter_payload(), settings)
    assert body["format"] == {"type": "object"}
    assert body["options"]["num_predict"] == 12000
    assert body["options"]["num_ctx"] == 8192
    assert body["options"]["temperature"] == 0.3


def test_normalize_payload_defaults_temperature_for_reasoning_payloads():
    payload = openrouter_payload()
    payload.pop("temperature")
    payload["reasoning"] = {"effort": "medium", "exclude": True}
    body = normalize_payload(payload, local_settings())
    assert body["options"]["temperature"] == 0.2


def test_normalize_payload_without_schema_omits_format():
    payload = openrouter_payload()
    payload.pop("response_format")
    body = normalize_payload(payload, local_settings())
    assert "format" not in body


def test_map_response_shapes_openrouter_body():
    mapped = _map_response(
        {"message": {"content": "{\"clips\": []}"},
         "done_reason": "length",
         "prompt_eval_count": 10, "eval_count": 5,
         "total_duration": 1_500_000_000},
        "qwen3:8b",
    )
    assert mapped["choices"][0]["message"]["content"] == "{\"clips\": []}"
    assert mapped["choices"][0]["finish_reason"] == "length"
    assert mapped["usage"]["prompt_tokens"] == 10
    assert mapped["usage"]["completion_tokens"] == 5
    assert mapped["usage"]["total_tokens"] == 15
    assert mapped["usage"]["cost"] is None


def test_is_local_backend_tolerates_cloud_settings():
    assert is_local_backend(SimpleNamespace(ai_backend="cloud")) is False
    assert is_local_backend(SimpleNamespace()) is False
    assert is_local_backend(SimpleNamespace(ai_backend="local")) is True


# ---------------------------------------------------------------------------
# chat_completion_for routing
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_chat_completion_for_uses_cloud_client_unmodified():
    class FakeClient:
        pass

    sent = {}

    async def fake_chat(client, payload, provider="openrouter"):
        sent["client"] = client
        sent["payload"] = payload
        return {"ok": True}, {"cost": 1}

    import clip_engine.services.local_llm as local_llm
    original = local_llm.chat_completion
    local_llm.chat_completion = fake_chat
    try:
        payload = {"model": "anthropic/claude-opus-5.5"}
        body, usage = await chat_completion_for(SimpleNamespace(ai_backend="cloud"), payload, FakeClient())
    finally:
        local_llm.chat_completion = original
    assert sent["client"] is not None and sent["payload"] is payload
    assert body == {"ok": True}


@pytest.mark.asyncio
async def test_chat_completion_for_local_never_touches_cloud_client():
    class ExplodingClient:
        def __getattr__(self, name):
            raise AssertionError("cloud client must not be used in local mode")

    import clip_engine.services.local_llm as local_llm

    async def fake_ollama(settings, payload):
        return {"local": True}, {"cost": None}

    original = local_llm.ollama_chat
    local_llm.ollama_chat = fake_ollama
    try:
        body, usage = await chat_completion_for(
            local_settings(), {"model": "qwen3:8b"}, ExplodingClient())
    finally:
        local_llm.ollama_chat = original
    assert body == {"local": True}


@pytest.mark.asyncio
async def test_ollama_chat_retries_without_think_on_old_server(monkeypatch):
    calls = []

    class Response:
        def __init__(self, status, text=""):
            self.status_code = status
            self.text = text
            self.content = (
                b'{"message":{"content":"{\\"clips\\":[]}"},"done":true,'
                b'"prompt_eval_count":1,"eval_count":2}'
            )

    class FakeAsyncClient:
        def __init__(self, timeout=None, follow_redirects=False):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, json=None):
            # Copy: the caller mutates the same dict when retrying without
            # the `think` field, which would rewrite this call's history.
            calls.append(dict(json) if isinstance(json, dict) else json)
            if len(calls) == 1:
                return Response(400, 'unknown field "think"')
            return Response(200)

    monkeypatch.setattr("clip_engine.services.local_llm.httpx.AsyncClient", FakeAsyncClient)
    body, usage = await ollama_chat(local_settings(), {"model": "qwen3:8b", "messages": []})
    assert "think" in calls[0] and "think" not in calls[1]
    assert body["choices"][0]["message"]["content"] == '{"clips":[]}'


# ---------------------------------------------------------------------------
# Local transcription path
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_local_transcription_skips_auth_and_uses_backend(monkeypatch, tmp_path):
    svc = stt.TranscriptionService.__new__(stt.TranscriptionService)
    svc.settings = SimpleNamespace(
        ai_backend="local", openrouter_api_key=None, transcription_diarize=False,
        transcription_language="ro", clipping_mode="quality",
        transcription_model="local/whisper-large-v3-turbo",
    )
    svc.progress_callback = None

    audio = tmp_path / "chunk.wav"
    audio.write_bytes(b"wav")

    monkeypatch.setattr(svc, "_audio_duration", lambda path: 2.0)

    captured = {}

    class FakeBackend:
        def transcribe_chunk(self, path, language, keyterms, duration):
            captured.update(path=path, language=language, keyterms=keyterms, duration=duration)
            return {
                "text": "Salut",
                "words": [{"word": "Salut", "start": 0.1, "end": 0.5}],
                "language": "ro",
                "usage": {"seconds": 2, "cost": 0.0},
            }

        def close(self):
            captured["closed"] = True

    monkeypatch.setattr(svc, "_get_local_backend", lambda: FakeBackend())

    result = await svc._request_transcript_local(str(audio), None, ["BridgeClip"])
    assert captured["language"] == "ro"
    assert captured["keyterms"] == ["BridgeClip"]
    assert result["words"][0]["word"] == "Salut"


@pytest.mark.asyncio
async def test_local_mode_never_requests_cloud(monkeypatch, tmp_path):
    """transcribe_audio must not demand an API key in local mode."""
    svc = stt.TranscriptionService.__new__(stt.TranscriptionService)
    svc.settings = SimpleNamespace(
        ai_backend="local", openrouter_api_key=None, transcription_diarize=False,
        transcription_language="", clipping_mode="quality",
        transcription_model="local/whisper-large-v3-turbo",
    )
    svc.progress_callback = None
    svc.detail_callback = None

    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"wav")

    def fake_duration(path):
        return 2.0

    parsed = stt.TranscriptionResult(
        segments=[stt.TranscriptSegment(100, 500, "Salut", None,
                                        [stt.TranscriptWord("Salut", 100, 500)])],
        full_text="Salut", language="ro", duration_seconds=2.0,
        provider="local", model="local/whisper-large-v3-turbo",
    )

    async def fake_chunk(path, language, keyterms, duration, models, costs):
        costs.model = "local/whisper-large-v3-turbo"
        return parsed

    monkeypatch.setattr(svc, "_audio_duration", fake_duration)
    monkeypatch.setattr(svc, "_transcribe_chunk", fake_chunk)

    def fail_extract(source, destination, start, duration):
        raise AssertionError("single short chunk must not be re-extracted")

    monkeypatch.setattr(svc, "_extract_chunk", fail_extract)

    result = await svc.transcribe_audio(str(audio))
    assert result.provider == "local" or result.segments[0].words[0].word == "Salut"
    assert result.api_costs.estimated_cost_usd == 0.0
    assert getattr(svc, "_local_backend", None) is None


# ---------------------------------------------------------------------------
# Windowed local planning
# ---------------------------------------------------------------------------

def segment(start_ms, end_ms, text):
    return stt.TranscriptSegment(start_ms, end_ms, text, None, [])


def clip(start_ms, end_ms, score=0.5):
    return ClipPlanSegment(start_time_ms=start_ms, end_time_ms=end_ms, virality_score=score)


def test_window_overlap_ratio():
    assert _window_overlap_ratio(clip(0, 1000), clip(0, 1000)) == 1.0
    assert _window_overlap_ratio(clip(0, 1000), clip(500, 1500)) == 0.5
    assert _window_overlap_ratio(clip(0, 1000), clip(1000, 2000)) == 0.0
    assert _window_overlap_ratio(clip(0, 100), clip(0, 1000)) == 1.0


def test_merge_windowed_clips_dedupes_and_caps():
    merged = IntelligencePlannerService._merge_windowed_clips(
        [clip(0, 1000, 0.9), clip(100, 1100, 0.4), clip(5000, 6000, 0.7)], max_clips=2)
    assert [(c.start_time_ms, c.end_time_ms) for c in merged] == [(0, 1000), (5000, 6000)]


def test_merge_windowed_clips_without_cap_keeps_all():
    merged = IntelligencePlannerService._merge_windowed_clips(
        [clip(0, 1000, 0.9), clip(5000, 6000, 0.7)], max_clips=None)
    assert len(merged) == 2


def test_window_budget_is_context_sane():
    # ~3 chars per token: 24k chars ≈ 8k tokens, half of a 16k context.
    assert LOCAL_TRANSCRIPT_WINDOW_CHARS <= 24000


# ---------------------------------------------------------------------------
# Window construction through the real windowed planner
# ---------------------------------------------------------------------------

class _RecordingPlanner(IntelligencePlannerService):
    """Captures each window call without running the real planner."""

    def __init__(self):
        self.settings = local_settings()
        self.window_calls = []

    async def plan_clips(self, transcript_result, **kwargs):
        self.window_calls.append((transcript_result, kwargs))
        return ClipPlanResponse(
            segments=[
                ClipPlanSegment(
                    start_time_ms=int(kwargs["start_time_seconds"] * 1000) + 1000,
                    end_time_ms=int(kwargs["end_time_seconds"] * 1000) - 1000,
                    virality_score=0.6,
                )
            ],
            total_clips=1,
            target_platform=kwargs.get("target_platform", "tiktok"),
            insights="window ok",
        )


@pytest.mark.asyncio
async def test_windowed_planning_splits_and_covers_everything(monkeypatch):
    planner = _RecordingPlanner()
    # Build a transcript well over the window budget: 600 segments × 60 chars.
    segments = [
        segment(i * 1000, i * 1000 + 900, "cuvinte românești " * 4)
        for i in range(600)
    ]
    result = TranscriptionResult(
        segments=segments, full_text="x", language="ro",
        duration_seconds=600.0, provider="local",
    )
    out = await planner._plan_local_windowed(
        transcript_result=result, transcript=segments,
        video_metadata=None, max_clips=5, auto_clip_count=True,
        min_duration_seconds=5, max_duration_seconds=60,
        duration_ranges=None, target_platform="tiktok",
        aspect_ratio="9:16", source_context=None, clip_request=None,
    )
    assert out is not None and len(planner.window_calls) >= 2
    # Every window's bounds match its own segments, so nothing is lost.
    covered = set()
    for window_result, kwargs in planner.window_calls:
        window = window_result.segments
        assert kwargs["start_time_seconds"] * 1000 <= window[0].start_time_ms + 1
        assert kwargs["end_time_seconds"] * 1000 >= window[-1].end_time_ms - 1
        for seg in window:
            covered.add(id(seg))
    assert covered == {id(seg) for seg in segments}
    # Merged clips are capped at the requested maximum and time-ordered.
    assert 0 < len(out.segments) <= 5
    assert [c.start_time_ms for c in out.segments] == sorted(c.start_time_ms for c in out.segments)
    assert "window ok" in (out.insights or "")


@pytest.mark.asyncio
async def test_windowed_plan_repairs_the_merged_titles_once(monkeypatch):
    planner = _RecordingPlanner()
    repaired = []

    async def spy(segments, transcript, language):
        repaired.append((len(segments), len(transcript), language))

    monkeypatch.setattr(planner, "_repair_local_titles", spy)
    segments = [segment(i * 1000, i * 1000 + 900, "cuvinte românești " * 4) for i in range(600)]
    result = TranscriptionResult(
        segments=segments, full_text="x", language="ro",
        duration_seconds=600.0, provider="local",
    )
    out = await planner._plan_local_windowed(
        transcript_result=result, transcript=segments,
        video_metadata=None, max_clips=5, auto_clip_count=True,
        min_duration_seconds=5, max_duration_seconds=60,
        duration_ranges=None, target_platform="tiktok",
        aspect_ratio="9:16", source_context=None, clip_request=None,
    )
    # One repair over the merged clips, judged against the whole transcript.
    assert repaired == [(len(out.segments), len(segments), "ro")]


@pytest.mark.asyncio
async def test_windowed_planning_returns_none_below_budget():
    planner = _RecordingPlanner()
    small = [segment(0, 900, "scurt")]
    result = TranscriptionResult(segments=small, full_text="s", duration_seconds=1.0, provider="local")
    out = await planner._plan_local_windowed(
        transcript_result=result, transcript=small,
        video_metadata=None, max_clips=3, auto_clip_count=True,
        min_duration_seconds=5, max_duration_seconds=60,
        duration_ranges=None, target_platform="tiktok",
        aspect_ratio="9:16", source_context=None, clip_request=None,
    )
    assert out is None
    assert planner.window_calls == []


# ---------------------------------------------------------------------------
# Output-budget clip cap and truncation retry
# ---------------------------------------------------------------------------

def planner_settings(**overrides):
    base = dict(
        ai_backend="local",
        planner_model="qwen3:8b",
        get_planner_fallback_models=lambda: [],
        clipping_mode="quality",
        planner_reasoning_effort="low",
        planner_supports_images=True,
        sentence_snapping_enabled=False,
        max_suggested_clips=10,
        max_clips_absolute=30,
        clip_scaling_enabled=False,
        effective_planner_max_output_tokens=16000,
        local_planner_context_tokens=16384,
        openrouter_api_key="",
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def completion_body(content, finish_reason):
    return {
        "model": "qwen3:8b",
        "choices": [{"message": {"content": content}, "finish_reason": finish_reason}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30, "cost": 0.0},
    }


USAGE = {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30, "cost": 0.0}


def _budget_planner(monkeypatch, responses):
    """A real planner whose transport is captured, returning canned responses."""
    from clip_engine.services.intelligence_planner import IntelligencePlannerService
    planner = IntelligencePlannerService()
    planner.settings = planner_settings()
    captured = []

    async def fake_call(model, fallback_models, messages):
        captured.append(messages[0]["content"])
        content, reason = responses[min(len(captured), len(responses)) - 1]
        return completion_body(content, reason), dict(USAGE)

    async def no_sleep(_):
        return None

    planner._call_openrouter = fake_call
    monkeypatch.setattr("clip_engine.services.intelligence_planner.asyncio.sleep", no_sleep)
    transcript = [segment(i * 20000, i * 20000 + 19000, f"rand {i}") for i in range(40)]
    return planner, captured, TranscriptionResult(
        segments=transcript, full_text="x", language="ro", duration_seconds=800.0, provider="local",
    )


async def _plan(planner, transcript_result):
    return await planner.plan_clips(
        transcript_result, max_clips=24, auto_clip_count=False,
        min_duration_seconds=60, max_duration_seconds=120,
    )


@pytest.mark.asyncio
async def test_local_plan_caps_clips_at_output_budget(monkeypatch):
    from clip_engine.services.intelligence_planner import LOCAL_MAX_CLIPS_PER_REQUEST
    planner, captured, result = _budget_planner(monkeypatch, [('{"clips": []}', 'stop')])
    await _plan(planner, result)
    # The 800s range fits 13 clips of 60s, but the local output budget holds fewer.
    assert f"Return exactly {LOCAL_MAX_CLIPS_PER_REQUEST} clips" in captured[0]
    assert "Return exactly 13 clips" not in captured[0]
    assert "Return exactly 24 clips" not in captured[0]
    # The per-request cap is not the job's ceiling: windowed planning pays it once
    # per window and the job keeps everything the range and the request allow.
    assert planner.discovery_limit == 13


@pytest.mark.asyncio
async def test_windowed_plan_keeps_every_window_beyond_the_per_request_cap(monkeypatch):
    planner, captured, result = _budget_planner(
        monkeypatch, [('{"clips": []}', 'stop')] * 4)
    long_speech = [segment(i * 1000, i * 1000 + 900, "cuvinte românești " * 4) for i in range(600)]
    result = TranscriptionResult(
        segments=long_speech, full_text="x", language="ro",
        duration_seconds=600.0, provider="local",
    )
    async def no_repair(segments, transcript, language):
        return None
    monkeypatch.setattr(planner, "_repair_local_titles", no_repair)

    await planner.plan_clips(
        result, max_clips=24, auto_clip_count=True,
        min_duration_seconds=30, max_duration_seconds=120,
    )
    assert len(captured) >= 2, "the transcript is planned in windows"
    # Each window pays the per-request cap...
    assert all(f"Return exactly {LOCAL_MAX_CLIPS_PER_REQUEST} clips" in prompt for prompt in captured)
    # ...but the job's ceiling stays the requested count, so the later windows'
    # clips are kept instead of discarded at selection.
    assert planner.discovery_limit > LOCAL_MAX_CLIPS_PER_REQUEST


@pytest.mark.asyncio
async def test_local_truncated_plan_retries_with_fewer_clips(monkeypatch):
    from clip_engine.services.intelligence_planner import LOCAL_MAX_CLIPS_PER_REQUEST
    planner, captured, result = _budget_planner(monkeypatch, [
        ('{"clips": [', 'length'),   # cut off by num_predict; unparseable
        ('{"clips": []}', 'stop'),
    ])
    await _plan(planner, result)
    assert len(captured) == 2
    assert f"Return exactly {LOCAL_MAX_CLIPS_PER_REQUEST} clips" in captured[0]
    assert f"Return exactly {LOCAL_MAX_CLIPS_PER_REQUEST // 2} clips" in captured[1]


@pytest.mark.asyncio
async def test_cloud_truncated_plan_keeps_the_same_request(monkeypatch):
    planner, captured, result = _budget_planner(monkeypatch, [
        ('{"clips": [', 'length'),
        ('{"clips": []}', 'stop'),
    ])
    planner.settings = planner_settings(ai_backend="cloud")
    await _plan(planner, result)
    assert len(captured) == 2
    assert captured[0] == captured[1]


# ---------------------------------------------------------------------------
# Titles the local planner writes as descriptions
# ---------------------------------------------------------------------------

RUNAWAY = ("The speaker criticizes the current government's actions, "
           "particularly their handling of a sports event, calling it a disgrace")
FIRST_CLAUSE = "The speaker criticizes the current government's actions"


def titled(summary):
    return ClipPlanSegment(start_time_ms=0, end_time_ms=5000, virality_score=0.5, summary=summary)


def test_title_usability_follows_the_seven_word_card():
    assert _title_is_usable("Datoria publică a României", "ro")
    assert not _title_is_usable(RUNAWAY, "ro")
    assert not _title_is_usable(RUNAWAY, None)
    assert _title_is_usable("The debt nobody mentions", "en")
    # Only English drift is punished: a terse English title has no stopwords either.
    assert _title_is_usable("Datoria publică crește", "en")
    # Two "și" must not read as the English word "i".
    assert _title_is_usable("Guvernul și criza și datoria", "ro")


def test_missing_titles_are_left_alone():
    assert not _title_needs_repair(None, "ro")
    assert not _title_needs_repair("   ", "ro")


def romanian_transcript():
    speech = ("Guvernul a crescut datoria publică, premierul vorbește despre deficit "
              "în fața parlamentului, iar sindicatele cer măriri de salariu pentru "
              "profesori și medici pentru că prețurile la energie au explodat")
    # The detector only reads a transcript with a few hundred distinct words as
    # evidence of the spoken language; a thin one calls every title foreign.
    filler = "".join(f" {chr(97 + i // 26)}{chr(97 + i % 26)}" for i in range(300))
    return [segment(0, 60_000, speech + filler)]


def test_terse_english_titles_are_foreign_to_a_romanian_video():
    # A short English headline carries no stopword pattern for _is_english to see;
    # the words the speaker never used are what mark it foreign.
    vocabulary = _spoken_vocabulary(romanian_transcript())
    assert _title_is_foreign("Media Censorship and Public Reaction", vocabulary)
    assert not _title_is_foreign("Datoria publică a crescut", vocabulary)
    assert not _title_is_foreign("Deficitul și datoria", vocabulary)


def test_a_thin_transcript_is_not_evidence_of_a_foreign_title():
    vocabulary = _spoken_vocabulary([segment(0, 5000, "datoria e uriașă")])
    assert len(vocabulary) < 200
    assert not _title_is_foreign("Media Censorship and Public Reaction", vocabulary)


def test_the_spoken_vocabulary_decides_which_cards_read_as_foreign():
    vocabulary = _spoken_vocabulary(romanian_transcript())
    assert not _title_is_usable("Media Censorship and Public Reaction", "ro", vocabulary)
    assert _title_is_usable("Datoria publică a crescut", "ro", vocabulary)
    # An English video keeps its English titles.
    assert _title_is_usable("Media Censorship and Public Reaction", "en", vocabulary)
    # Fewer than three words give the detector nothing to judge.
    assert _title_is_usable("Cenzura media", "ro", vocabulary)


def test_title_repair_looks_at_the_foreign_ones_only():
    vocabulary = _spoken_vocabulary(romanian_transcript())
    assert _title_needs_repair("Media Censorship and Public Reaction", "ro", vocabulary)
    assert not _title_needs_repair("Datoria publică a crescut", "ro", vocabulary)


def test_trimmed_title_keeps_the_first_clause():
    assert _trimmed_title(RUNAWAY) == FIRST_CLAUSE
    assert len(FIRST_CLAUSE.split()) <= MAX_TITLE_WORDS
    assert _trimmed_title("a b c d e f g h i j") == "a b c d e f g"
    assert _trimmed_title("") is None


def _repair_planner():
    planner = IntelligencePlannerService.__new__(IntelligencePlannerService)
    planner.settings = local_settings()
    return planner


@pytest.mark.asyncio
async def test_repair_local_titles_asks_once_and_validates_answers(monkeypatch):
    planner = _repair_planner()
    payloads = []

    async def fake_chat(settings, payload):
        payloads.append(payload)
        return completion_body(json.dumps({"titles": [
            {"index": 0, "title": "Datoria României"},
            {"index": 1, "title": "The speaker also criticizes the current government endlessly"},
        ]}), "stop"), dict(USAGE)

    monkeypatch.setattr(local_llm, "ollama_chat", fake_chat)
    segments = [titled(RUNAWAY), titled(RUNAWAY)]
    await planner._repair_local_titles(segments, [segment(0, 5000, "datoria e uriașă")], "ro")

    assert len(payloads) == 1
    assert "in ro" in payloads[0]["messages"][0]["content"]
    assert segments[0].summary == "Datoria României"
    # An answer that still breaks the rule falls back to the trim, not the card cut.
    assert segments[1].summary == FIRST_CLAUSE


@pytest.mark.asyncio
async def test_repair_local_titles_rewrites_english_headlines_of_a_romanian_video(monkeypatch):
    planner = _repair_planner()
    asked = []

    async def fake_chat(settings, payload):
        asked.append(json.loads(payload["messages"][1]["content"]))
        return completion_body(json.dumps({"titles": [
            {"index": 1, "title": "Deficitul și datoria publică"},
        ]}), "stop"), dict(USAGE)

    monkeypatch.setattr(local_llm, "ollama_chat", fake_chat)
    segments = [titled("Datoria publică a crescut"), titled("Media Censorship and Public Reaction")]
    await planner._repair_local_titles(segments, romanian_transcript(), "ro")

    assert [item["index"] for item in asked[0]["clips"]] == [1]
    assert segments[0].summary == "Datoria publică a crescut"
    assert segments[1].summary == "Deficitul și datoria publică"


@pytest.mark.asyncio
async def test_repair_local_titles_survives_an_unreachable_model(monkeypatch):
    planner = _repair_planner()

    async def broken(settings, payload):
        raise RuntimeError("Ollama is not reachable")

    monkeypatch.setattr(local_llm, "ollama_chat", broken)
    segments = [titled(RUNAWAY)]
    await planner._repair_local_titles(segments, [segment(0, 5000, "text")], "ro")
    assert segments[0].summary == FIRST_CLAUSE


@pytest.mark.asyncio
async def test_local_plan_asks_for_and_ships_titles_in_the_spoken_language(monkeypatch):
    plan = json.dumps({"clips": [{
        "start_time": 20, "end_time": 80, "summary": RUNAWAY,
        "scores": {"hook": 8, "standalone": 8, "arc": 8, "quotability": 8, "ending": 8},
        "tags": ["datorie"], "emphasis": ["datorie"],
    }]})
    planner, captured, result = _budget_planner(monkeypatch, [(plan, "stop")])

    async def fake_chat(settings, payload):
        return completion_body(json.dumps({"titles": [{"index": 0, "title": "Datoria României"}]}),
                               "stop"), dict(USAGE)

    monkeypatch.setattr(local_llm, "ollama_chat", fake_chat)
    out = await _plan(planner, result)
    assert "Write every title in ro" in captured[0]
    assert out.segments[0].summary == "Datoria României"


@pytest.mark.asyncio
async def test_cloud_plan_prompt_keeps_the_original_title_rules(monkeypatch):
    planner, captured, result = _budget_planner(monkeypatch, [('{"clips": []}', "stop")])
    planner.settings = planner_settings(ai_backend="cloud")
    await _plan(planner, result)
    assert "Write every title" not in captured[0]


@pytest.mark.asyncio
async def test_local_plan_asks_for_headroom_over_the_minimum(monkeypatch):
    # Gap trimming shortens what the planner sized, so a clip planned at the
    # minimum ships under it. Only the local models need telling.
    planner, captured, result = _budget_planner(monkeypatch, [('{"clips": []}', "stop")])
    await _plan(planner, result)
    assert "Aim for the middle of the length you pick, never its lower edge" in captured[0]


@pytest.mark.asyncio
async def test_cloud_plan_keeps_the_original_duration_rules(monkeypatch):
    planner, captured, result = _budget_planner(monkeypatch, [('{"clips": []}', "stop")])
    planner.settings = planner_settings(ai_backend="cloud")
    await _plan(planner, result)
    assert "Aim for the middle of the length" not in captured[0]


# ---------------------------------------------------------------------------
# Model fetch fallback
# ---------------------------------------------------------------------------

def test_every_engine_whisper_model_has_a_mirror():
    from clip_engine.services.local_whisper import WHISPER_MODEL_REPOS
    for repo in WHISPER_MODEL_REPOS.values():
        assert repo in model_fetch.MODELSCOPE_MIRRORS, repo


def test_ensure_model_short_circuits_when_weights_exist(tmp_path, capsys):
    target = tmp_path / "Systran-faster-whisper-medium"
    target.mkdir()
    (target / "model.bin").write_bytes(b"x")
    model_fetch.ensure_model("Systran/faster-whisper-medium", str(tmp_path))
    assert "weights already present" in capsys.readouterr().err


def test_ensure_model_unknown_repo_raises_without_fallback(tmp_path):
    import pytest as _pytest
    with _pytest.raises(Exception):
        model_fetch.ensure_model("unknown/thing", str(tmp_path))
