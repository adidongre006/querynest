# Google Search Agent

A chat app that answers with live web search and real-time weather.
**Next.js** (UI) + **FastAPI** (API) + a **LangChain** agent on **Groq** (`openai/gpt-oss-20b`),
with **Nimble** for search and **OpenWeather** for weather. Answers stream in token by token,
with weather cards, tool-activity chips and numbered sources.

## Features

- Streaming answers over Server-Sent Events (SSE), Stop / Retry / Copy
- Weather card, source cards, markdown rendering (tables, lists, code)
- Light/dark mode, keyboard shortcuts, mobile layout, screen-reader friendly
- Security by default: rate limiting, validation, Origin check, CORS allowlist, security headers, safe markdown, cost caps

## Architecture

```
 Browser ──► Next.js :3000 ──── /api/* rewrite ────► FastAPI :8000
   ▲           UI + CSP/security headers                │ origin → content-type → rate limit
   │                                                    │ → global cap → concurrency → body size → schema
   │                                                    ▼
   └──────────── SSE events ◄──────────────── LangChain agent (Groq LLM)
                                                 ├─ google_search ─► Nimble
                                                 └─ weather_tool  ─► OpenWeather
```

The browser only talks to the Next.js origin. API keys and the backend URL stay on the server.
The backend is **stateless**: the browser sends the last 12 messages with every request.

## Project structure

```
backend/
  main.py          middleware, rate limiter, validation, /api/chat (SSE), /api/health
  agent.py         tools, agent, streaming generator
  test_main.py     pytest suite (agent mocked, no keys or network needed)
  requirements.txt
  .env.example
frontend/
  app/             layout.tsx, page.tsx, globals.css
  components/      chat.tsx (state, SSE reader, UI), cards.tsx (weather, sources, markdown, errors)
  next.config.ts   security headers + /api rewrite
  package.json  tsconfig.json  postcss.config.mjs  .env.example
```

## Quickstart

Prerequisites: Python 3.11+, Node 20+, API keys for Groq, Nimble, OpenWeather.

```bash
# 1. backend
cd backend
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                  # fill in the three keys
pytest -q                                             # should be green before you go on
uvicorn main:app --reload --port 8000

# 2. frontend (new terminal)
cd frontend
cp .env.example .env.local                            # BACKEND_URL=http://127.0.0.1:8000
npm install
npm run dev                                           # http://localhost:3000
```

After your first green run, freeze exact versions: `pip freeze > requirements.lock` and commit `package-lock.json`.

Smoke-test the API without the UI (`-N` disables curl's buffering so you see the stream):

```bash
curl -N -X POST http://127.0.0.1:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Weather in Pune"}]}'
```

## Environment variables

### backend/.env

| Variable | Default | Purpose |
|---|---|---|
| `GROQ_API_KEY`, `NIMBLE_API_KEY`, `OPEN_WEATHER` | required | The server refuses to start without them |
| `ENV` | `development` | `production` disables `/docs` and `/openapi.json` |
| `ALLOWED_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | CORS allowlist **and** Origin check |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1` | Accepted `Host` headers (`*.example.com` wildcards work) |
| `TRUST_PROXY` | `false` | Read client IP from `X-Forwarded-For`. Only when a proxy you control overwrites that header |
| `RATE_LIMIT_PER_MINUTE` / `RATE_LIMIT_PER_DAY` | `10` / `100` | Per IP |
| `GLOBAL_LIMIT_PER_MINUTE` | `120` | All visitors combined (bill safety net) |
| `MAX_CONCURRENT_RUNS` | `8` | Simultaneous agent runs before `503` |
| `RUN_TIMEOUT_SECONDS` | `60` | Hard cap per answer |
| `MAX_OUTPUT_TOKENS` | `2048` | Includes the reasoning model's thinking tokens |
| `AGENT_RECURSION_LIMIT` | `10` | Caps tool-call loops |
| `NIMBLE_DEEP_SEARCH` | `false` | `true` = deeper but slower; raise both timeouts if you enable it |
| `SEARCH_TIMEOUT_SECONDS` | `30` | Per search call |

### frontend/.env.local

| Variable | Purpose |
|---|---|
| `BACKEND_URL` | Where Next.js forwards `/api/*`. Server-only (never `NEXT_PUBLIC_`). **Read at build time** on production hosts |

## API

`POST /api/chat`, body:

```json
{ "messages": [ { "role": "user", "content": "Weather in Pune" } ] }
```

Rules: 1 to 12 messages, role `user` or `assistant`, user text 1 to 4000 chars (assistant 1 to 8000), last message from `user`, no extra fields, `Content-Type: application/json`, body under 256 KB.

Response `text/event-stream`:

| event | data |
|---|---|
| `tool_start` | `{"name":"weather_tool","input":"Pune"}` |
| `tool_end` | `{"name":"weather_tool"}` |
| `weather` | `{"city","country","temp_c","feels_like_c","humidity","wind_kmh","description","icon"}` |
| `sources` | `[{"id":1,"title":"...","url":"https://..."}]` |
| `token` | `{"text":"..."}` |
| `done` | `{}` |
| `error` | `{"code":"timeout\|limit\|internal","message":"...","request_id":"..."}` |

Errors before the stream starts are JSON: `{"error":{"code","message","request_id"}}` with status
`403` origin, `413` too large, `415` content type, `422` invalid body, `429` rate limited (`Retry-After`), `503` busy (`Retry-After`).

`GET /api/health` returns `{"status":"ok"}`.

## Security model

| Threat | Defense |
|---|---|
| Cost abuse | Per-IP minute/day limits, global cap, concurrency cap, token cap, tool-loop cap, 60 s deadline |
| Malformed / huge input | Strict Pydantic schema (`extra="forbid"`), 256 KB streamed body limit, length caps |
| Cross-site use of your API | Origin check (403), CORS allowlist, JSON-only content type (forces a preflight), same-origin proxy |
| Spoofed client IP | `X-Forwarded-For` ignored unless `TRUST_PROXY=true` (tested) |
| Leaked keys | Keys only in backend env; never in `NEXT_PUBLIC_*`; weather key never logged (httpx logger muted, no exception text logged) |
| XSS | No raw HTML in markdown, `http(s)` links only, images dropped, CSP, no `dangerouslySetInnerHTML` except one fixed theme-init literal |
| Clickjacking / sniffing | `X-Frame-Options`, `frame-ancestors`, `nosniff` |
| Prompt injection from web pages | System prompt treats tool output as data; the model never has access to keys; output is only rendered as text |
| Information leaks | Generic client errors plus a request id; stack traces only in server logs; no message content or IPs logged |

**Known limits.** The rate limiter is in-process: with several workers or instances each keeps its own counters (use Redis if you scale out). IP-based limits are shared by users behind one NAT and can be dodged by rotating IPs; add auth or a CAPTCHA (e.g. Cloudflare Turnstile) when you need more. The CSP allows inline scripts because Next needs them for hydration; per-request nonces are the stricter upgrade.

## Deployment

1. **Backend** (Render / Railway / Fly.io): `uvicorn main:app --host 0.0.0.0 --port $PORT`.
   Set the three keys, `ENV=production`, `TRUST_PROXY=true`, `ALLOWED_ORIGINS=https://your-frontend`, `ALLOWED_HOSTS=your-backend-host`.
2. **Frontend** (Vercel): set `BACKEND_URL=https://your-backend` **before the build**, then deploy.
3. Verify: `curl -I https://your-frontend` shows the security headers; the 11th request in a minute gets `429`; text streams progressively rather than appearing at once.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Answer appears all at once | A proxy is buffering. Keep `compress: false`, check `X-Accel-Buffering: no`, test with `curl -N` against both ports |
| Everyone shares one rate-limit bucket | `TRUST_PROXY` is off behind a proxy (all requests look like one IP) |
| Rate limit trivially bypassed | `TRUST_PROXY=true` but nothing in front overwrites `X-Forwarded-For` |
| `403 forbidden_origin` | Your frontend URL (including preview deployments) is missing from `ALLOWED_ORIGINS` |
| `400 Invalid host header` / failing platform health checks | Add the host the platform uses to `ALLOWED_HOSTS` |
| No sources shown | The search tool returned a shape the normalizer does not know; log `raw` in `agent._normalize` and extend it |
| Reasoning text appears in the answer | Print one streamed `AIMessageChunk` and see where your langchain-groq version puts it; only `type == "text"` blocks should be emitted |
| Answers cut off | `MAX_OUTPUT_TOKENS` too low (reasoning tokens count) |
| Startup error about missing variables | By design: fill `backend/.env` |

## Tests

```bash
cd backend && pytest -q            # validation, 429 + Retry-After, spoofed XFF, headers, SSE order, 503, no error leaks
cd frontend && npm run typecheck && npm run build
```
