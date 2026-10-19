"use client";

import { ArrowUp, Check, ChevronDown, Copy, Moon, Plus, RotateCcw, Search, Square, Sun } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ErrorNotice, Markdown, SourceList, ToolChip, WeatherCard, isHttpUrl } from "./cards";
import type { ChatError, Source, ToolRun, Weather } from "./cards";

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools: ToolRun[];
  sources: Source[];
  weather?: Weather;
  error?: ChatError;
  streaming?: boolean;
};

const STORAGE_KEY = "gsa:chat:v1";
const MAX_MESSAGES = 12; // must match the backend limit
const MAX_USER_CHARS = 4000;
const MAX_ASSISTANT_CHARS = 8000;
const SUGGESTIONS = [
  "What's the weather in Nagpur right now?",
  "Latest news in AI this week",
  "Compare PostgreSQL and MySQL for a startup",
  "What happened in tech today?",
];

const uid = () => globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);

// ---- runtime guards: everything coming off the wire / storage is untrusted ----
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function asWeather(v: unknown): Weather | null {
  if (!isObj(v) || typeof v.city !== "string" || typeof v.temp_c !== "number") return null;
  return {
    city: v.city,
    country: str(v.country),
    temp_c: v.temp_c,
    feels_like_c: num(v.feels_like_c),
    humidity: num(v.humidity),
    wind_kmh: num(v.wind_kmh),
    description: str(v.description),
    icon: str(v.icon),
  };
}

function asSources(v: unknown): Source[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((s: unknown) =>
    isObj(s) && typeof s.id === "number" && isHttpUrl(str(s.url))
      ? [{ id: s.id, title: str(s.title), url: str(s.url) }]
      : [],
  );
}

// ---- Server-Sent Events: split the byte stream into {event, data} blocks ----
type SSEEvent = { event: string; data: unknown };

function parseBlock(block: string): SSEEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join("\n")) };
  } catch {
    return null;
  }
}

async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const parsed = parseBlock(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (parsed) yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function errorFromResponse(res: Response): Promise<ChatError> {
  let message = "Something went wrong. Please try again.";
  try {
    const body: unknown = await res.json();
    if (isObj(body) && isObj(body.error) && typeof body.error.message === "string") message = body.error.message;
  } catch {
    /* the body is optional; keep the generic message */
  }
  const retryAfter = Number(res.headers.get("Retry-After")) || undefined;
  if (res.status === 429) return { kind: "rate_limit", message, retryAfter };
  if (res.status === 503) return { kind: "busy", message, retryAfter };
  return { kind: "server", message };
}

function loadMessages(): Msg[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .flatMap((m: unknown): Msg[] => {
        if (!isObj(m) || typeof m.id !== "string" || typeof m.content !== "string" || !m.content.trim()) return [];
        if (m.role !== "user" && m.role !== "assistant") return [];
        return [{ id: m.id, role: m.role, content: m.content, tools: [], sources: asSources(m.sources), weather: asWeather(m.weather) ?? undefined }];
      })
      .slice(-MAX_MESSAGES);
  } catch {
    return []; // storage blocked or corrupt: start fresh
  }
}

// ------------------------------------------------------------------ message row

const MessageRow = memo(function MessageRow({ m, last, onRetry }: { m: Msg; last: boolean; onRetry: () => void }) {
  const [copied, setCopied] = useState(false);

  if (m.role === "user") {
    return (
      <div className="fade-in flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap wrap-break-word rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-accent-fg">
          {m.content}
        </p>
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: nothing useful to do */
    }
  };
  const thinking = m.streaming && !m.content && !m.tools.length;

  return (
    <article className="fade-in" aria-busy={m.streaming} aria-live={m.streaming ? "polite" : "off"}>
      {m.tools.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {m.tools.map((t) => (
            <ToolChip key={t.id} run={t} />
          ))}
        </div>
      )}
      {thinking && <p className="animate-pulse text-sm text-muted motion-reduce:animate-none">Thinking…</p>}
      {m.weather && <WeatherCard w={m.weather} />}
      {m.content && (
        <div className={`prose-chat ${m.streaming ? "caret" : ""}`}>
          <Markdown text={m.content} />
        </div>
      )}
      <SourceList sources={m.sources} />
      {m.error && <ErrorNotice error={m.error} onRetry={last ? onRetry : undefined} />}
      {!m.streaming && m.content && (
        <div className="mt-3 flex gap-1 text-muted">
          <button type="button" onClick={copy} aria-label="Copy answer" className="rounded-lg p-1.5 transition-colors hover:bg-surface-2 hover:text-text">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </button>
          {last && (
            <button type="button" onClick={onRetry} aria-label="Regenerate answer" className="rounded-lg p-1.5 transition-colors hover:bg-surface-2 hover:text-text">
              <RotateCcw className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
    </article>
  );
});

// ------------------------------------------------------------------------ chat

export default function Chat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [stick, setStick] = useState(true); // auto-follow the newest text
  const [dark, setDark] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<Msg[]>([]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Load saved chat + theme after mount (not during render, to avoid hydration mismatches).
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
    setMessages(loadMessages());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || busy) return;
    try {
      const keep = messages
        .filter((m) => m.content.trim())
        .slice(-MAX_MESSAGES)
        .map(({ id, role, content, weather, sources }) => ({ id, role, content, weather, sources }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(keep));
    } catch {
      /* quota or privacy mode: the chat simply will not persist */
    }
  }, [messages, busy, hydrated]);

  // Follow the stream, but stop following as soon as the user scrolls up.
  useEffect(() => {
    const onScroll = () =>
      setStick(window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (stick) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [messages, stick]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  /** Send `history` (which must end with a user message) and stream the answer into a new bubble. */
  const run = useCallback(async (history: Msg[]) => {
    const id = uid();
    const patch = (fn: (m: Msg) => Msg) => setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
    setMessages([...history, { id, role: "assistant", content: "", tools: [], sources: [], streaming: true }]);
    setBusy(true);
    setStick(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Tokens can arrive faster than the screen refreshes; apply them once per frame.
    let pending = "";
    let frame = 0;
    const flush = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (!pending) return;
      const text = pending;
      pending = "";
      patch((m) => ({ ...m, content: m.content + text }));
    };
    const queue = (text: string) => {
      pending += text;
      if (!frame) frame = requestAnimationFrame(flush);
    };

    const payload = history
      .filter((m) => m.content.trim())
      .slice(-MAX_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content.slice(0, m.role === "user" ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS) }));

    let finished = false;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: payload }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const error = await errorFromResponse(res);
        patch((m) => ({ ...m, error }));
        return;
      }
      for await (const { event, data } of readSSE(res.body)) {
        if (event === "token" && isObj(data)) {
          queue(str(data.text));
        } else if (event === "tool_start" && isObj(data)) {
          patch((m) => ({ ...m, tools: [...m.tools, { id: String(m.tools.length), name: str(data.name), input: str(data.input), done: false }] }));
        } else if (event === "tool_end" && isObj(data)) {
          patch((m) => {
            const i = m.tools.findIndex((t) => t.name === data.name && !t.done);
            return i < 0 ? m : { ...m, tools: m.tools.map((t, j) => (j === i ? { ...t, done: true } : t)) };
          });
        } else if (event === "weather") {
          const weather = asWeather(data);
          if (weather) patch((m) => ({ ...m, weather }));
        } else if (event === "sources") {
          const fresh = asSources(data);
          patch((m) => ({ ...m, sources: [...m.sources, ...fresh.filter((s) => !m.sources.some((o) => o.url === s.url))] }));
        } else if (event === "error" && isObj(data)) {
          const message = str(data.message) || "Something went wrong. Please try again.";
          patch((m) => ({ ...m, error: { kind: data.code === "timeout" ? "timeout" : "server", message } }));
          finished = true;
        } else if (event === "done") {
          finished = true;
        }
      }
      if (!finished) patch((m) => ({ ...m, error: { kind: "network", message: "The connection was interrupted. Please try again." } }));
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      if (!aborted) patch((m) => ({ ...m, error: { kind: "network", message: "Can't reach the server. Check your connection and try again." } }));
    } finally {
      flush();
      patch((m) => ({ ...m, streaming: false, tools: m.tools.map((t) => ({ ...t, done: true })) }));
      abortRef.current = null;
      setBusy(false);
    }
  }, []);

  const send = useCallback(
    (text: string) => {
      const content = text.trim().slice(0, MAX_USER_CHARS);
      if (!content || abortRef.current) return;
      const user: Msg = { id: uid(), role: "user", content, tools: [], sources: [] };
      setInput("");
      void run([...messagesRef.current.filter((m) => m.content.trim()), user]);
    },
    [run],
  );

  const retry = useCallback(() => {
    if (abortRef.current) return;
    const list = messagesRef.current;
    let i = list.length - 1;
    while (i >= 0 && list[i]?.role !== "user") i--;
    if (i >= 0) void run(list.slice(0, i + 1));
  }, [run]);

  const newChat = () => {
    abortRef.current?.abort();
    setMessages([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    inputRef.current?.focus();
  };

  const toggleTheme = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    setDark(next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      /* ignore */
    }
  };

  const iconBtn = "flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-text";

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-bg/80 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-accent-fg">
              <Search className="h-4 w-4" aria-hidden />
            </span>
            <h1 className="text-sm font-semibold tracking-tight">Search Agent</h1>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={newChat} className={iconBtn}>
              <Plus className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">New chat</span>
              <span className="sr-only sm:hidden">New chat</span>
            </button>
            <button type="button" onClick={toggleTheme} aria-label="Toggle dark mode" className={iconBtn}>
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 backdrop-blur-lg bg-(--back-bg)/70 rounded-4xl " aria-label="Conversation">
        {messages.length === 0 ? (
          <section className="flex min-h-[50vh] flex-col items-center justify-center text-center">
            <h2 className="text-3xl font-semibold tracking-tight">Ask anything.</h2>
            <p className="mt-2 text-muted">Live web search and real-time weather, with sources.</p>
            <div className="mt-8 grid w-full max-w-xl gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="rounded-xl border border-border bg-surface px-4 py-3 text-left text-sm transition-colors hover:border-accent"
                >
                  {s}
                </button>
              ))}
            </div>
          </section>
        ) : (
          <div className="space-y-8">
            {messages.map((m, i) => (
              <MessageRow key={m.id} m={m} last={i === messages.length - 1} onRetry={retry} />
            ))}
          </div>
        )}
      </main>

      <div className="sticky bottom-0 z-10 border-t  border-slate-400 bg-bg/90 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
        <div className="relative mx-auto max-w-3xl px-4">
          {!stick && messages.length > 0 && (
            <button
              type="button"
              onClick={() => setStick(true)}
              className="absolute -top-12 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface px-3 py-1.5 text-xs shadow-sm"
            >
              <ChevronDown className="h-3.5 w-3.5" aria-hidden /> Jump to latest
            </button>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-end gap-2 rounded-4xl border-2 border-border bg-surface p-3 shadow-sm focus-within:border-accent"
          >
            <label htmlFor="prompt" className="sr-only">
              Ask anything
            </label>
            <textarea
              id="prompt"
              ref={inputRef}
              rows={1}
              maxLength={MAX_USER_CHARS}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder="Ask anything…"
              className="max-h-50 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 outline-none placeholder:text-muted"
            />
            {input.length > MAX_USER_CHARS - 500 && (
              <span className="self-center text-xs text-muted" aria-live="polite">
                {input.length}/{MAX_USER_CHARS}
              </span>
            )}
            {busy ? (
              <button type="button" onClick={() => abortRef.current?.abort()} aria-label="Stop generating" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-text text-bg">
                <Square className="h-4 w-4 fill-current" />
              </button>
            ) : (
              <button type="submit" disabled={!input.trim()} aria-label="Send message" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg transition-opacity disabled:opacity-30">
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </form>
          <p className="mt-2 text-center text-xs text-muted">
            AI can make mistakes. Check the sources. Enter to send, Shift+Enter for a new line, Ctrl/⌘ K to focus.
          </p>
        </div>
      </div>
    </div>
  );
}
