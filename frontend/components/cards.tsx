import {
  Check,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  Loader2,
  Moon,
  Sun,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type Weather = {
  city: string;
  country: string;
  temp_c: number;
  feels_like_c: number;
  humidity: number;
  wind_kmh: number;
  description: string;
  icon: string;
};
export type Source = { id: number; title: string; url: string };
export type ToolRun = { id: string; name: string; input: string; done: boolean };
export type ChatError = {
  kind: "rate_limit" | "busy" | "timeout" | "network" | "server";
  message: string;
  retryAfter?: number;
};

export function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

// OpenWeather icon codes ("10d", "01n"...) -> bundled icons, so no remote images (strict CSP).
function WeatherIcon({ code, className }: { code: string; className?: string }) {
  const night = code.endsWith("n");
  switch (code.slice(0, 2)) {
    case "01":
      return night ? <Moon className={className} aria-hidden /> : <Sun className={className} aria-hidden />;
    case "02":
      return night ? <CloudMoon className={className} aria-hidden /> : <CloudSun className={className} aria-hidden />;
    case "09":
      return <CloudDrizzle className={className} aria-hidden />;
    case "10":
      return <CloudRain className={className} aria-hidden />;
    case "11":
      return <CloudLightning className={className} aria-hidden />;
    case "13":
      return <CloudSnow className={className} aria-hidden />;
    case "50":
      return <CloudFog className={className} aria-hidden />;
    default:
      return <Cloud className={className} aria-hidden />;
  }
}

export function WeatherCard({ w }: { w: Weather }) {
  const stats: [string, string][] = [
    ["Feels like", `${Math.round(w.feels_like_c)}°`],
    ["Humidity", `${Math.round(w.humidity)}%`],
    ["Wind", `${Math.round(w.wind_kmh)} km/h`],
  ];
  return (
    <section aria-label={`Weather in ${w.city}`} className="my-3 w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-muted">
            {w.city}
            {w.country ? `, ${w.country}` : ""}
          </p>
          <p className="mt-1 text-5xl font-semibold tracking-tight">
            {Math.round(w.temp_c)}°<span className="text-2xl text-muted">C</span>
          </p>
          <p className="mt-1 text-sm capitalize text-muted">{w.description}</p>
        </div>
        <WeatherIcon code={w.icon} className="h-12 w-12 text-accent" />
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-4">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="mt-0.5 text-sm font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function SourceList({ sources }: { sources: Source[] }) {
  if (!sources.length) return null;
  return (
    <section aria-label="Sources" className="mt-4">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Sources</h3>
      <ol className="grid gap-2 sm:grid-cols-2">
        {sources.filter((s) => isHttpUrl(s.url)).map((s) => (
          <li key={`${s.id}-${s.url}`}>
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="flex items-start gap-3 rounded-xl border border-border bg-surface p-3 text-sm transition-colors hover:border-accent"
            >
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-surface-2 text-xs font-medium text-muted">
                {s.id}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{s.title || domainOf(s.url)}</span>
                <span className="block truncate text-xs text-muted">{domainOf(s.url)}</span>
              </span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

const TOOL_LABELS: Record<string, string> = {
  google_search: "Searching the web",
  weather_tool: "Checking the weather",
};

export function ToolChip({ run }: { run: ToolRun }) {
  return (
    <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted">
      {run.done ? (
        <Check className="h-3.5 w-3.5 text-accent" aria-hidden />
      ) : (
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
      )}
      <span className="truncate">
        {TOOL_LABELS[run.name] ?? "Working"}
        {run.input ? `: ${run.input}` : ""}
      </span>
    </span>
  );
}

// react-markdown ignores raw HTML by default; links are re-checked and images are dropped.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) =>
          isHttpUrl(href) ? (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ) : (
            <span>{children}</span>
          ),
        img: () => null,
        table: ({ children }) => (
          <div className="overflow-x-auto">
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

export function ErrorNotice({ error, onRetry }: { error: ChatError; onRetry?: () => void }) {
  const [left, setLeft] = useState(error.retryAfter ?? 0);
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);

  const text =
    error.kind === "rate_limit" || error.kind === "busy"
      ? left > 0
        ? `${error.kind === "rate_limit" ? "Slow down" : "We're busy"}. Try again in ${left}s.`
        : "You can try again now."
      : error.message;

  return (
    <div
      role="alert"
      className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm"
    >
      <span className="min-w-0 flex-1">{text}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={left > 0}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-opacity disabled:opacity-40"
        >
          Retry
        </button>
      )}
    </div>
  );
}
