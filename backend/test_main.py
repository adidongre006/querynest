"""API tests. The real agent is replaced by a fake, so no network or API keys are needed."""

import os

# Must be set before `import main`: settings and middleware are built at import time.
os.environ.update(
    {
        "GROQ_API_KEY": "test",
        "NIMBLE_API_KEY": "test",
        "OPEN_WEATHER": "test",
        "ENV": "test",
        "ALLOWED_HOSTS": "testserver",
        "ALLOWED_ORIGINS": "http://localhost:3000",
    }
)

import asyncio  # noqa: E402
import dataclasses  # noqa: E402
import json  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

VALID = {"messages": [{"role": "user", "content": "Weather in Pune"}]}
client = TestClient(main.app)


async def fake_agent(messages):
    yield {"event": "tool_start", "data": {"name": "weather_tool", "input": "Pune"}}
    yield {"event": "tool_end", "data": {"name": "weather_tool"}}
    yield {"event": "token", "data": {"text": "It is "}}
    yield {"event": "token", "data": {"text": "sunny."}}
    yield {"event": "done", "data": {}}


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    monkeypatch.setattr(main, "run_agent", fake_agent)
    main.limiter.reset()
    yield
    main.limiter.reset()


def parse_sse(text: str) -> list[tuple[str, dict]]:
    events = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.split("\n"))
        events.append((lines["event"], json.loads(lines["data"])))
    return events


def test_health_and_security_headers():
    res = client.get("/api/health")
    assert res.status_code == 200 and res.json() == {"status": "ok"}
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["cache-control"] == "no-store"
    assert res.headers["referrer-policy"] == "no-referrer"
    assert "default-src 'none'" in res.headers["content-security-policy"]
    assert res.headers["x-request-id"]


def test_stream_event_order():
    res = client.post("/api/chat", json=VALID)
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    names = [name for name, _ in parse_sse(res.text)]
    assert names == ["tool_start", "tool_end", "token", "token", "done"]


@pytest.mark.parametrize(
    "payload",
    [
        {"messages": []},
        {"messages": [{"role": "user", "content": ""}]},
        {"messages": [{"role": "user", "content": "x" * 4001}]},
        {"messages": [{"role": "system", "content": "hi"}]},
        {"messages": [{"role": "assistant", "content": "hi"}]},  # last must be user
        {"messages": [{"role": "user", "content": "hi"}] * 13},
        {"messages": [{"role": "user", "content": "hi", "extra": 1}]},
        {"messages": [{"role": "user", "content": "hi"}], "extra": True},
        {},
    ],
)
def test_invalid_payloads_are_rejected(payload):
    res = client.post("/api/chat", json=payload)
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "invalid_request"


def test_malformed_json_is_422():
    res = client.post("/api/chat", content=b"{not json", headers={"content-type": "application/json"})
    assert res.status_code == 422


def test_wrong_content_type_is_415():
    res = client.post("/api/chat", content=b"hello", headers={"content-type": "text/plain"})
    assert res.status_code == 415


def test_foreign_origin_is_403():
    res = client.post("/api/chat", json=VALID, headers={"origin": "https://evil.example"})
    assert res.status_code == 403


def test_allowed_origin_passes():
    res = client.post("/api/chat", json=VALID, headers={"origin": "http://localhost:3000"})
    assert res.status_code == 200


def test_oversized_body_is_413():
    big = b'{"messages":[{"role":"user","content":"' + b"a" * (300 * 1024) + b'"}]}'
    res = client.post("/api/chat", content=big, headers={"content-type": "application/json"})
    assert res.status_code == 413


def test_rate_limit_returns_429_with_retry_after():
    codes = [client.post("/api/chat", json=VALID).status_code for _ in range(10)]
    assert codes == [200] * 10
    res = client.post("/api/chat", json=VALID)
    assert res.status_code == 429
    assert int(res.headers["retry-after"]) >= 1
    assert res.json()["error"]["code"] == "rate_limited"


def test_forwarded_for_ignored_without_trust_proxy():
    for i in range(10):
        client.post("/api/chat", json=VALID, headers={"x-forwarded-for": f"1.1.1.{i}"})
    res = client.post("/api/chat", json=VALID, headers={"x-forwarded-for": "9.9.9.9"})
    assert res.status_code == 429  # a spoofed header must not give a fresh bucket


def test_separate_buckets_per_forwarded_ip_when_trusted(monkeypatch):
    monkeypatch.setattr(main, "settings", dataclasses.replace(main.settings, trust_proxy=True))
    for _ in range(10):
        assert client.post("/api/chat", json=VALID, headers={"x-forwarded-for": "1.1.1.1"}).status_code == 200
    assert client.post("/api/chat", json=VALID, headers={"x-forwarded-for": "1.1.1.1"}).status_code == 429
    assert client.post("/api/chat", json=VALID, headers={"x-forwarded-for": "2.2.2.2"}).status_code == 200


def test_busy_server_returns_503(monkeypatch):
    monkeypatch.setattr(main, "semaphore", asyncio.Semaphore(0))  # zero free slots
    res = client.post("/api/chat", json=VALID)
    assert res.status_code == 503
    assert res.headers["retry-after"]


def test_agent_failure_does_not_leak_details(monkeypatch):
    async def broken(messages):
        raise RuntimeError("secret-key-123 /srv/app/agent.py")
        yield  # pragma: no cover - makes this an async generator

    monkeypatch.setattr(main, "run_agent", broken)
    res = client.post("/api/chat", json=VALID)
    assert res.status_code == 200  # the stream already started; failure arrives as an event
    events = parse_sse(res.text)
    assert events[-1][0] == "error" and events[-1][1]["code"] == "internal"
    assert "secret-key-123" not in res.text and "agent.py" not in res.text


def test_limiter_math():
    lim = main.SlidingWindowLimiter()
    rules = ((2, 60),)
    assert lim.hit("a", rules, now=0) == 0
    assert lim.hit("a", rules, now=10) == 0
    assert lim.hit("a", rules, now=20) == 40  # oldest hit (t=0) expires at t=60
    assert lim.hit("b", rules, now=20) == 0  # other keys are independent
    assert lim.hit("a", rules, now=61) == 0  # window slid past the first hit
