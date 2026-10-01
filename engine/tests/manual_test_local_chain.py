"""Manual smoke test for the local chat backend against a live Ollama server.

Run from engine/: .venv/Scripts/python -m tests.manual_test_local_chain [model]
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from types import SimpleNamespace

from clip_engine.services.local_llm import ollama_chat
from clip_engine.services.openrouter import json_schema_format

MODEL = sys.argv[1] if len(sys.argv) > 1 else "qwen2.5:1.5b"

settings = SimpleNamespace(
    ai_backend="local",
    local_llm_base_url=os.environ.get("LOCAL_LLM_BASE_URL", "http://127.0.0.1:11434"),
    local_planner_model=MODEL,
    local_planner_context_tokens=8192,
)

schema = {
    "type": "object",
    "properties": {
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start": {"type": "number"},
                    "end": {"type": "number"},
                    "title": {"type": "string"},
                },
                "required": ["start", "end", "title"],
            },
        }
    },
    "required": ["clips"],
}

payload = {
    "model": MODEL,
    "messages": [
        {"role": "system", "content": "You pick clips from transcripts. Answer in the transcript's language."},
        {"role": "user", "content": (
            "Transcript:\n"
            "[0.0-4.0] Astăzi vă arăt cum să economisiți bani pe facturi.\n"
            "[4.0-9.0] Prima metodă este să opriți aparatele din priză când nu le folosiți.\n"
            "[9.0-14.0] A doua metodă este să comparați ofertele furnizorilor înainte de reînnoire.\n\n"
            "Pick the single most viral moment as one clip between 4 and 9 seconds."
        )},
    ],
    "max_tokens": 512,
    "response_format": json_schema_format("smoke", schema),
    "models": ["unused/fallback"],
    "reasoning": {"effort": "medium", "exclude": True},
    "plugins": [{"id": "response-healing"}],
    "provider": {"require_parameters": True},
}


async def main():
    body, usage = await ollama_chat(settings, payload)
    content = body["choices"][0]["message"]["content"]
    print("finish_reason:", body["choices"][0]["finish_reason"])
    print("content:", content[:400])
    print("usage:", usage)

asyncio.run(main())
