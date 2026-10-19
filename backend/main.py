"""FastAPI entrypoint: validation, rate limiting, security headers, SSE streaming.

Everything the browser can reach goes through this file, so every defense lives here.
Order of checks on POST /api/chat (cheapest first, so abuse costs us almost nothing):
origin -> content type -> per-IP rate limit -> global cap -> concurrency -> body size -> schema.
"""

import asyncio
import contextlib
import json
import logging
import math
import os
import time
import uuid
from collections import deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Literal

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from starlette.datastructures import MutableHeaders
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.types import ASGIApp
from starlette.types import Message as ASGIMessage
from starlette.types import Receive, Scope, Send

load_dotenv()

from agent import check_env, get_agent, run_agent  # noqa: E402 - needs dotenv loaded first

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(levelname)s %(name)s %(message)s")
log = logging.getLogger("api")


def log_event(name: str, **fields: Any) -> None:
    """One JSON line per event. Never put message content or IPs in here."""
    log.info(json.dumps({"event": name, **fields}))


# ------------------------------------------------------------------- settings


def _env_list(name: str, default: str) -> tuple[str, ...]:
    return tuple(v.strip() for v in os.getenv(name, default).split(",") if v.strip())


@dataclass(frozen=True)
class Settings:
    env: str
    allowed_origins: tuple[str, ...]
    allowed_hosts: tuple[str, ...]
    trust_proxy: bool
    per_minute: int
    per_day: int
    global_per_minute: int
    max_concurrent: int
    run_timeout: float

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            env=os.getenv("ENV", "development"),
            allowed_origins=_env_list("ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"),
            allowed_hosts=_env_list("ALLOWED_HOSTS", "localhost,127.0.0.1"),
            trust_proxy=os.getenv("TRUST_PROXY", "false").lower() == "true",
            per_minute=max(1, int(os.getenv("RATE_LIMIT_PER_MINUTE", "10"))),
            per_day=max(1, int(os.getenv("RATE_LIMIT_PER_DAY", "100"))),
            global_per_minute=max(1, int(os.getenv("GLOBAL_LIMIT_PER_MINUTE", "120"))),
            max_concurrent=max(1, int(os.getenv("MAX_CONCURRENT_RUNS", "8"))),
            run_timeout=float(os.getenv("RUN_TIMEOUT_SECONDS", "60")),
        )


settings = Settings.from_env()
MAX_BODY_BYTES = 256 * 1024
MAX_USER_CHARS = 4000
MAX_ASSISTANT_CHARS = 8000  # earlier answers sent back as context can be longer than a question
semaphore = asyncio.Semaphore(settings.max_concurrent)


# --------------------------------------------------------------- rate limiter


class SlidingWindowLimiter:
    """In-process sliding-window limiter (no dependencies, easy to test).

    State lives in this process only. With several workers/instances each keeps its own
    counters; move to Redis if you scale out. Rejected requests are not recorded, so a
    blocked client is allowed again as soon as its oldest counted hit expires.
    """

    def __init__(self, max_keys: int = 20_000) -> None:
        self._hits: dict[str, deque[float]] = {}
        self._max_keys = max_keys

    def reset(self) -> None:
        self._hits.clear()

    def hit(self, key: str, rules: tuple[tuple[int, int], ...], now: float | None = None) -> int:
        """Record a request. Returns 0 if allowed, otherwise seconds until it would be."""
        now = time.monotonic() if now is None else now
        longest = max(window for _, window in rules)
        hits = self._hits.setdefault(key, deque())
        while hits and now - hits[0] >= longest:
            hits.popleft()
        wait = 0
        for limit, window in rules:
            recent = [t for t in hits if now - t < window]
            if len(recent) >= limit:
                # The request is allowed again when the oldest of the last `limit` hits expires.
                wait = max(wait, math.ceil(window - (now - recent[-limit])))
        if wait:
            return max(wait, 1)
        hits.append(now)
        if len(self._hits) > self._max_keys:
            self._sweep(now, longest)
        return 0

    def _sweep(self, now: float, longest: float) -> None:
        stale = [k for k, q in self._hits.items() if not q or now - q[-1] >= longest]
        for key in stale:
            del self._hits[key]
        while len(self._hits) > self._max_keys:  # still too many: drop the oldest keys
            del self._hits[next(iter(self._hits))]


limiter = SlidingWindowLimiter()


def client_ip(request: Request) -> str:
    """Real visitor IP. X-Forwarded-For is only believed when TRUST_PROXY=true, because
    any client can send that header and would otherwise dodge the limit by changing it."""
    if settings.trust_proxy:
        first = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        if first:
            return first[:64]
    return request.client.host if request.client else "unknown"


# ------------------------------------------------------------------ schemas


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=MAX_ASSISTANT_CHARS)

    @model_validator(mode="after")
    def user_messages_are_shorter(self) -> "Message":
        if self.role == "user" and len(self.content) > MAX_USER_CHARS:
            raise ValueError(f"user messages are limited to {MAX_USER_CHARS} characters")
        return self


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages: list[Message] = Field(min_length=1, max_length=12)

    @model_validator(mode="after")
    def last_message_is_from_user(self) -> "ChatRequest":
        if self.messages[-1].role != "user":
            raise ValueError("the last message must come from the user")
        return self


# --------------------------------------------------------------- middleware

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
}
DOCS_PATHS = ("/docs", "/redoc", "/openapi.json")  # swagger UI needs scripts, so no CSP there


class RequestContextMiddleware:
    """Pure ASGI middleware (not BaseHTTPMiddleware, which interferes with streaming
    and disconnect handling): tags each request with an id and adds security headers."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = uuid.uuid4().hex[:12]
        scope.setdefault("state", {})["request_id"] = request_id
        is_docs = scope.get("path", "").startswith(DOCS_PATHS)

        async def send_with_headers(message: ASGIMessage) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["X-Request-ID"] = request_id
                for key, value in SECURITY_HEADERS.items():
                    if is_docs and key == "Content-Security-Policy":
                        continue
                    headers.setdefault(key, value)
            await send(message)

        await self.app(scope, receive, send_with_headers)


# ---------------------------------------------------------------------- app


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    check_env()
    get_agent()  # build the agent now so the first user does not pay for it
    log_event("startup", env=settings.env)
    yield


is_prod = settings.env == "production"
app = FastAPI(
    title="Google Search Agent API",
    lifespan=lifespan,
    docs_url=None if is_prod else "/docs",
    redoc_url=None,
    openapi_url=None if is_prod else "/openapi.json",
)
# add_middleware: the LAST one added is the OUTERMOST, so headers cover every response.
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),  # explicit allowlist, never "*"
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
    expose_headers=["Retry-After", "X-Request-ID"],
    max_age=600,
)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.allowed_hosts))
app.add_middleware(RequestContextMiddleware)


def request_id_of(request: Request) -> str:
    return str(request.scope.get("state", {}).get("request_id", "-"))


def problem(
    request: Request, status: int, code: str, message: str, retry_after: int | None = None
) -> JSONResponse:
    headers = {"Retry-After": str(retry_after)} if retry_after else None
    body = {"error": {"code": code, "message": message, "request_id": request_id_of(request)}}
    return JSONResponse(body, status_code=status, headers=headers)


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception) -> JSONResponse:
    log.exception("unhandled error request_id=%s", request_id_of(request))
    return problem(request, 500, "internal", "Something went wrong on our side.")


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def read_body(request: Request) -> bytes | None:
    """Read the body but give up past MAX_BODY_BYTES. Returns None if too large.
    Counting while streaming also covers chunked uploads that send no Content-Length."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        return None
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def describe_failure(exc: Exception) -> tuple[str, str]:
    if type(exc).__name__ == "GraphRecursionError":
        return "limit", "That needed too many steps. Try a simpler or more specific question."
    return "internal", "Something went wrong on our side. Please try again."


async def event_stream(messages: list[dict[str, str]], request_id: str) -> AsyncIterator[str]:
    """Pump agent events to the client as SSE, enforcing the run deadline.

    The semaphore is taken here (inside the generator) so it is always released by the
    `async with`, even if the client vanishes before the first byte is sent.
    """
    async with semaphore:
        deadline = time.monotonic() + settings.run_timeout
        events = run_agent(messages)
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError
                try:
                    event = await asyncio.wait_for(anext(events), remaining)
                except StopAsyncIteration:
                    break
                yield sse(event["event"], event["data"])
        except TimeoutError:
            log_event("run_timeout", request_id=request_id)
            yield sse("error", {"code": "timeout", "message": "That took too long. Please try again.", "request_id": request_id})
        except Exception as exc:  # noqa: BLE001 - details go to logs, never to the client
            log.exception("agent run failed request_id=%s", request_id)
            code, message = describe_failure(exc)
            yield sse("error", {"code": code, "message": message, "request_id": request_id})
        finally:
            with contextlib.suppress(Exception):
                await events.aclose()


# response_model=None: the return type is a Response union, which FastAPI must not try to serialize.
@app.post("/api/chat", response_model=None)
async def chat(request: Request) -> JSONResponse | StreamingResponse:
    origin = request.headers.get("origin")
    if origin and origin not in settings.allowed_origins:
        return problem(request, 403, "forbidden_origin", "This origin is not allowed.")
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        return problem(request, 415, "unsupported_media_type", "Send JSON (Content-Type: application/json).")

    ip = client_ip(request)
    wait = limiter.hit(ip, ((settings.per_minute, 60), (settings.per_day, 86_400)))
    if wait:
        log_event("rate_limited", request_id=request_id_of(request))
        return problem(request, 429, "rate_limited", "Too many requests. Please slow down.", wait)
    # A global cap protects the bill against many different IPs hitting us at once.
    wait = limiter.hit("__global__", ((settings.global_per_minute, 60),))
    if wait:
        return problem(request, 503, "busy", "The service is busy. Please try again shortly.", wait)
    if semaphore.locked():
        return problem(request, 503, "busy", "The service is busy. Please try again shortly.", 5)

    body = await read_body(request)
    if body is None:
        return problem(request, 413, "payload_too_large", "The request is too large.")
    try:
        payload = ChatRequest.model_validate_json(body)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(part) for part in first["loc"]) or "body"
        return problem(request, 422, "invalid_request", f"Invalid request ({where}): {first['msg']}")

    messages = [m.model_dump() for m in payload.messages]
    return StreamingResponse(
        event_stream(messages, request_id_of(request)),
        media_type="text/event-stream",
        headers={"X-Accel-Buffering": "no"},  # tell nginx-style proxies not to buffer the stream
    )
