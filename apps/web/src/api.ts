const KEY = "tenai.admin.token";

export const getToken = (): string | null => {
  try { return localStorage.getItem(KEY); } catch { return null; }
};
export const setToken = (t: string | null) => {
  try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* private mode */ }
};

export async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401) { setToken(null); location.reload(); }
  if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
  return j as T;
}

export interface Overview {
  totals: { online: number; active_sessions: number; turns_today: number; refused_today: number; tokens_today: number; cost_today: number; mrs_total: number };
  sessions: Array<{ id: string; email: string; name: string; model_id: string; repo: string; branch: string; status: string; started: number; turns: number; refused: number; tokens: number; cost: number }>;
  people: Array<{ email: string; name: string; role: string; blocked: number; daily_token_budget: number; last_seen: number; sessions: number; tokens_today: number; cost_total: number }>;
  online: Array<{ email: string; name: string; modelId: string; since: number; conns: number }>;
  frozen: boolean;
  running: string[];
}

export const fmt = {
  n: (v: number) => Math.round(v).toLocaleString(),
  k: (v: number) => (v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "k" : String(Math.round(v))),
  usd: (v: number) => "$" + v.toFixed(v < 1 ? 4 : 2),
  ago: (ts: number) => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
  },
  time: (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
};

export const initials = (name: string) => name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
const PALETTE = ["#ff7a1a", "#5b8cff", "#2ecf8b", "#a07bff", "#28c9c9", "#ffb000", "#ff5d6c"];
export const colorFor = (s: string) => PALETTE[[...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
