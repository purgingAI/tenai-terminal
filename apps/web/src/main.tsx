/** TenAI Control — admin dashboard for every connected OpenWallet Terminal session. */
import type { ServerFrame } from "@tenai/wire";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { call, colorFor, fmt, getToken, initials, type Overview, setToken } from "./api";
import { Constellation, TOOL_COLORS } from "./constellation";

type View = "live" | "sessions" | "spine" | "changes" | "people" | "tokens" | "claude" | "gate" | "ledger";
type Toast = { id: number; text: string; tone: "red" | "amber" | "green" | "" };
type FeedItem = { id: number; ts: number; icon: string; color: string; text: React.ReactNode; tone?: "red" | "amber" };

const ICONS: Record<View, JSX.Element> = {
  live: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="8" strokeDasharray="3 3" /></svg>,
  sessions: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="14" rx="3" /><path d="M7 9l3 3-3 3M12 15h5" /></svg>,
  spine: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3v18M6 7h12M6 12h12M6 17h12" /></svg>,
  changes: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M6 8.5V14a4 4 0 004 4h5.5" /></svg>,
  people: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="9" cy="8" r="3.5" /><path d="M3 20c.8-3.4 3.2-5 6-5s5.2 1.6 6 5M16 4.5a3.5 3.5 0 010 7M18 15c1.6.6 2.6 2.2 3 5" /></svg>,
  tokens: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>,
  claude: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5M5.3 5.3l3.5 3.5M15.2 15.2l3.5 3.5M5.3 18.7l3.5-3.5M15.2 8.8l3.5-3.5" /></svg>,
  gate: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></svg>,
  ledger: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="3" width="16" height="18" rx="2.5" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>,
};
const TITLES: Record<View, [string, string]> = {
  live: ["Live", "Every connected agent, right now"],
  sessions: ["Sessions", "Each person's agent model, its branch and spend"],
  spine: ["Spine", "Who is editing what, open MRs, team notes — collisions light up"],
  changes: ["Changes", "Commits and merge requests raised through TenAI"],
  people: ["People", "Access, budgets and blocks"],
  tokens: ["Tokens", "Where the Claude tokens went"],
  claude: ["Claude", "The account every agent runs on — usage left, and switching it"],
  gate: ["Gate", "The intent model: label, train, shadow, promote — like Studio"],
  ledger: ["Ledger", "Tamper-evident audit trail"],
};

// ---------- theme (System / Dark / Light, like Studio) ----------
type Theme = "system" | "dark" | "light";
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => { try { return (localStorage.getItem("tenai.theme") as Theme) || "system"; } catch { return "system"; } });
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("theming");
    if (theme === "system") delete root.dataset.theme; else root.dataset.theme = theme;
    try { localStorage.setItem("tenai.theme", theme); } catch { /* private mode */ }
    const t = setTimeout(() => root.classList.remove("theming"), 450);
    return () => clearTimeout(t);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "system" ? "dark" : t === "dark" ? "light" : "system"))];
}
const THEME_ICON: Record<Theme, JSX.Element> = {
  system: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>,
  dark: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" /></svg>,
  light: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>,
};

/** Cross-fade between views where the browser supports it; instant otherwise or under reduced motion. */
function transition(fn: () => void) {
  const d = document as Document & { startViewTransition?: (cb: () => void) => void };
  if (d.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) d.startViewTransition(fn);
  else fn();
}

function useCountUp(target: number, ms = 900) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now(), a = from.current;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setV(target); from.current = target; return; }
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms), e = 1 - Math.pow(1 - k, 3);
      setV(a + (target - a) * e);
      if (k < 1) raf = requestAnimationFrame(step); else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}

function Kpi({ label, value, render, color }: { label: string; value: number; render: (v: number) => string; color: string }) {
  const v = useCountUp(value);
  return <div className="kpi" style={{ ["--c" as string]: color }}><div className="lb">{label}</div><div className="v">{render(v)}</div></div>;
}

// ---------- login ----------
function Login({ onIn }: { onIn: () => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      if (stage === "email") { await call("/auth/otp/request", { email }); setStage("code"); }
      else {
        const r = await call<{ token: string; role: string }>("/auth/otp/verify", { email, code });
        if (r.role !== "admin") throw new Error("This dashboard is for TenAI admins.");
        setToken(r.token); onIn();
      }
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <form className="lcard" onSubmit={submit}>
        <div className="logo">P10</div>
        <h2>TenAI Control</h2>
        <p>{stage === "email" ? "Sign in with your @example.com email. We'll send a one-time code." : `Enter the 6-digit code sent to ${email}.`}</p>
        {stage === "email"
          ? <input className="inp" autoFocus type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          : <input className="inp code" autoFocus inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />}
        <div className="err">{err}</div>
        <button className="btn go" style={{ width: "100%", marginTop: 8, padding: 12 }} disabled={busy}>{stage === "email" ? "Send code" : "Sign in"}</button>
      </form>
    </div>
  );
}

// ---------- views ----------
function LiveView({ ov, feed, canvasRef }: { ov: Overview; feed: FeedItem[]; canvasRef: React.RefObject<HTMLCanvasElement> }) {
  const t = ov.totals;
  return (
    <div className="view">
      <div className="kpis">
        <Kpi label="Online now" value={t.online ?? 0} render={fmt.n} color="#2ecf8b" />
        <Kpi label="Live sessions" value={t.active_sessions} render={fmt.n} color="#28c9c9" />
        <Kpi label="Turns today" value={t.turns_today} render={fmt.n} color="#5b8cff" />
        <Kpi label="Refused today" value={t.refused_today} render={fmt.n} color="#ffb000" />
        <Kpi label="Tokens today" value={t.tokens_today} render={fmt.k} color="#ff7a1a" />
        <Kpi label="Spend today" value={t.cost_today} render={fmt.usd} color="#f0302a" />
      </div>
      <div className="grid2">
        <div className="panel">
          <h3>Agent constellation <span className="n">{ov.sessions.filter((s) => s.status === "active").length} sessions · {ov.online?.length ?? 0} online</span>
            {ov.online?.length ? <span className="online-chips">{ov.online.map((o) => <span key={o.email} className="chip" title={`${o.email} · connected ${fmt.ago(o.since)}`}><i style={{ background: colorFor(o.email) }} />{o.name.split(" ")[0]}</span>)}</span> : null}</h3>
          <div className="stage">
            <canvas ref={canvasRef} />
            <div className="legend"><span><b style={{ background: "#ff7a1a" }} />turn</span><span><b style={{ background: "#5b8cff" }} />read</span><span><b style={{ background: "#28c9c9" }} />search</span><span><b style={{ background: "#a07bff" }} />edit</span><span><b style={{ background: "#ffb000" }} />git / refused</span><span><b style={{ background: "#ff5d6c" }} />denied / collision ⚡</span><span><b style={{ background: "#2ecf8b" }} />done / MR</span></div>
          </div>
        </div>
        <div className="panel">
          <h3>Live activity <span className="n">{feed.length}</span></h3>
          <div className="feed">
            {feed.length === 0 && <div className="empty">Waiting for activity…</div>}
            {feed.map((f) => (
              <div key={f.id} className={`ev ${f.tone ?? ""}`}>
                <div className="ic" style={{ background: f.color + "22", color: f.color }}>{f.icon}</div>
                <div className="tx">{f.text}</div>
                <div className="tm">{fmt.time(f.ts)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionsView({ ov, flash, open }: { ov: Overview; flash: Set<string>; open: (id: string) => void }) {
  if (!ov.sessions.length) return <div className="empty">No sessions yet.{ov.online?.length ? ` Online without a session: ${ov.online.map((o) => o.name).join(", ")}.` : ""}</div>;
  return (
    <div className="view cards">
      {ov.sessions.map((s) => {
        const working = ov.running.includes(s.id);
        const st = s.status !== "active" ? s.status : working ? "working" : "idle";
        return (
          <div key={s.id} className={`scard ${s.status} ${flash.has(s.id) ? "flash" : ""}`} style={{ ["--c" as string]: colorFor(s.email) }} onClick={() => open(s.id)}>
            <div className="hd">
              <div className="av">{initials(s.name)}</div>
              <div><div className="nm">{s.name}</div><div className="md">{s.model_id}</div></div>
              <span className={`stat ${st}`}><i />{st}</span>
            </div>
            <div className="br">⎇ {s.repo} · {s.branch}</div>
            <div className="ft"><span><b>{s.turns}</b> turns</span><span><b>{s.refused}</b> refused</span><span><b>{fmt.k(s.tokens)}</b> tok</span><span><b>{fmt.usd(s.cost)}</b></span></div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- turn replay: scrub through what an agent did, step by step ----------
const STEP_STYLE: Record<string, [string, string]> = {
  start: ["›", "#ff7a1a"], tool: ["⏺", "#5b8cff"], denied: ["⛔", "#ff5d6c"], text: ["¶", "#eef0f7"], done: ["✓", "#2ecf8b"], error: ["!", "#ff5d6c"],
};
function stepLabel(e: any): string {
  if (e.kind === "start") return `Prompt: ${e.text}`;
  if (e.kind === "tool") return `${e.name} ${e.text ?? ""}`;
  if (e.kind === "done") { try { const d = JSON.parse(e.text); return `Done · ${fmt.k(d.tokens)} tokens · ${fmt.usd(d.costUsd)}`; } catch { return "Done"; } }
  return e.text ?? "";
}
function TurnReplay({ turnId, close }: { turnId: string; close: () => void }) {
  const [ev, setEv] = useState<any[] | null>(null);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(true);
  useEffect(() => { call<any[]>(`/admin/api/turns/${turnId}/events`).then((e) => { setEv(e); setPos(0); }); }, [turnId]);
  useEffect(() => {
    if (!ev || !playing || pos >= ev.length) return;
    // real gaps, compressed: never slower than 1.6s or faster than 0.25s per step
    const gap = pos === 0 ? 300 : Math.min(1600, Math.max(250, (ev[pos].ts - ev[pos - 1].ts) / 6));
    const t = setTimeout(() => setPos((p) => p + 1), gap);
    return () => clearTimeout(t);
  }, [ev, pos, playing]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [pos]);
  if (!ev) return <div className="skel" style={{ height: 120 }} />;
  if (!ev.length) return <div className="empty">No recorded steps — this turn ran before replay existed or was refused.</div>;
  const t0 = ev[0].ts, total = Math.max(1, ev.at(-1).ts - t0);
  return (
    <div className="replay">
      <div className="rp-bar">
        <button className="btn sm" onClick={() => { if (pos >= ev.length) setPos(0); setPlaying((p) => !p || pos >= ev.length); }}>{playing && pos < ev.length ? "❚❚ Pause" : pos >= ev.length ? "↺ Replay" : "▶ Play"}</button>
        <div className="rp-track">
          {ev.map((e, i) => <i key={e.seq} title={stepLabel(e)} onClick={() => { setPos(i + 1); setPlaying(false); }}
            style={{ left: `${((e.ts - t0) / total) * 100}%`, background: STEP_STYLE[e.kind]?.[1], opacity: i < pos ? 1 : 0.28 }} />)}
          <b style={{ width: `${pos ? ((ev[Math.min(pos, ev.length) - 1].ts - t0) / total) * 100 : 0}%` }} />
        </div>
        <span className="mono dim" style={{ fontSize: 11 }}>{pos}/{ev.length} · {Math.round(total / 1000)}s</span>
        <button className="btn sm" onClick={close}>✕</button>
      </div>
      <div className="rp-list" ref={listRef}>
        {ev.slice(0, pos).map((e) => (
          <div key={e.seq} className={`rp-step k-${e.kind}`}>
            <span className="ic" style={{ color: STEP_STYLE[e.kind]?.[1] }}>{STEP_STYLE[e.kind]?.[0]}</span>
            <span className="tx">{stepLabel(e)}</span>
            <span className="tm mono">+{((e.ts - t0) / 1000).toFixed(1)}s</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SessionDrawer({ id, ov, live, close, refresh }: { id: string; ov: Overview; live: Map<string, string[]>; close: () => void; refresh: () => void }) {
  const s = ov.sessions.find((x) => x.id === id);
  const [tab, setTab] = useState<"turns" | "live" | "diff">("turns");
  const [turns, setTurns] = useState<any[]>([]);
  const [diff, setDiff] = useState<{ files: string[]; patch: string } | null>(null);
  const [replay, setReplay] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { call<any[]>(`/admin/api/sessions/${id}/turns`).then(setTurns).catch((e) => setErr(e.message)); }, [id, ov]);
  useEffect(() => { if (tab === "diff") call<{ files: string[]; patch: string }>(`/admin/api/sessions/${id}/diff`).then(setDiff).catch((e) => setErr(e.message)); }, [tab, id]);
  if (!s) return null;
  const block = async () => {
    const reason = prompt(`Block ${s.name}'s session? Reason:`);
    if (!reason) return;
    await call(`/admin/api/sessions/${id}/block`, { reason });
    refresh();
  };
  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="drawer">
        <div className="dh">
          <div className="av" style={{ background: colorFor(s.email) }}>{initials(s.name)}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>{s.name} <span className="tag">{s.model_id}</span></div>
            <div className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{s.repo} · {s.branch}</div>
          </div>
          {s.status === "active" && <button className="btn danger" onClick={block}>Block session</button>}
          <button className="btn" onClick={close}>Close</button>
        </div>
        <div className="db">
          <div className="tabs">
            {(["turns", "live", "diff"] as const).map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t === "turns" ? `Turns (${turns.length})` : t === "live" ? "Live transcript" : "Code changes"}</button>)}
          </div>
          {err && <div className="err">{err}</div>}
          {tab === "turns" && turns.map((t) => (
            <div className="turn" key={t.id}>
              <div className="q">{t.prompt}</div>
              <div className="m">
                <span className={`tag ${t.outcome === "done" ? "ok" : t.outcome === "refused" ? "warn" : t.outcome === "failed" ? "bad" : ""}`}>{t.outcome}</span>
                {t.gate_label && <span>gate: {t.gate_label}{t.gate_score != null ? ` ${(t.gate_score * 100).toFixed(0)}%` : ""}</span>}
                {t.detail && <span>{t.detail}</span>}
                {t.input_tokens != null && <span>{fmt.n(t.input_tokens + t.output_tokens + (t.cache_write ?? 0))} tok · {fmt.usd(t.cost_usd ?? 0)}</span>}
                <span>{fmt.ago(t.started)}</span>
                {t.outcome !== "refused" && <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => setReplay(replay === t.id ? null : t.id)}>{replay === t.id ? "Hide replay" : "▶ Replay"}</button>}
              </div>
              {replay === t.id && <TurnReplay turnId={t.id} close={() => setReplay(null)} />}
            </div>
          ))}
          {tab === "live" && <div className="live-tx">{(live.get(id) ?? ["Nothing streamed since this page opened."]).map((l, i) => <div key={i} className={l.startsWith("⏺") ? "tool" : l.startsWith("⛔") ? "den" : l.startsWith("⚠") ? "ref" : ""}>{l}</div>)}</div>}
          {tab === "diff" && (diff ? (
            <>
              <div style={{ marginBottom: 10 }}>{diff.files.map((f) => <span key={f} className="claim">{f}</span>)}</div>
              <pre className="diff">{diff.patch.split("\n").map((l, i) => <div key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "a" : l.startsWith("-") && !l.startsWith("---") ? "d" : l.startsWith("@@") ? "h" : ""}>{l || " "}</div>)}</pre>
            </>
          ) : <div className="empty">Loading diff…</div>)}
        </div>
      </div>
    </>
  );
}

function SpineView({ toast }: { toast: (t: string, tone?: Toast["tone"]) => void }) {
  const [claims, setClaims] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  useEffect(() => {
    const load = () => { call<any[]>("/admin/api/claims").then(setClaims); call<any[]>("/admin/api/spine").then((e) => setEvents(e.reverse().slice(0, 60))); };
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);
  const byRepo = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const c of claims) m.set(c.repo, [...(m.get(c.repo) ?? []), c]);
    return m;
  }, [claims]);
  const clash = (c: any) => claims.some((o) => o.repo === c.repo && o.session_id !== c.session_id && (o.path === c.path || o.path.startsWith(c.path + "/") || c.path.startsWith(o.path + "/")));
  return (
    <div className="view">
    <div className="grid2" style={{ marginTop: 0 }}>
      <div className="panel">
        <h3>Files being edited <span className="n">{claims.length}</span></h3>
        {!claims.length && <div className="empty">No active claims.</div>}
        {[...byRepo].map(([repo, cs]) => (
          <div className="repo" key={repo}>
            <h4>{repo}</h4>
            {cs.map((c) => <span key={c.id} className={`claim ${clash(c) ? "clash" : ""}`} title={c.email}><b style={{ width: 8, height: 8, borderRadius: 4, background: colorFor(c.email), display: "inline-block" }} />{c.path}<em style={{ color: "var(--muted)", fontStyle: "normal" }}>· {c.email.split("@")[0]}</em></span>)}
          </div>
        ))}
      </div>
      <div className="panel">
        <h3>Spine timeline</h3>
        <div className="feed">
          {events.map((e) => (
            <div key={e.seq} className={`ev ${e.kind === "collision" ? "red" : ""}`}>
              <div className="ic" style={{ background: colorFor(e.actor) + "22", color: colorFor(e.actor) }}>{e.kind === "mr.opened" ? "⇡" : e.kind === "collision" ? "⚡" : e.kind === "claim" ? "✎" : e.kind === "note" ? "📌" : e.kind === "session.start" ? "+" : "•"}</div>
              <div className="tx"><b>{e.actor.split("@")[0]}</b> {e.kind === "note" ? "pinned a note" : e.kind.replace(".", " ")} <em>{e.repo} {e.kind === "note" ? `· ${e.payload.text}` : (e.payload.paths ?? []).join?.(", ") ?? ""}</em></div>
              <div className="tm">{fmt.time(e.ts)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
    <CollabPanels toast={toast} />
    </div>
  );
}

function CollabPanels({ toast }: { toast: (t: string, tone?: Toast["tone"]) => void }) {
  const [c, setC] = useState<any>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => call<any>("/admin/api/collab").then(setC).catch(() => undefined);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);
  if (!c) return <div className="skel" style={{ marginTop: 16 }} />;
  const claimed = new Set(c.claims.map((x: any) => `${x.repo}:${x.path}`));
  const byRepo = new Map<string, any[]>();
  for (const m of c.mrs) byRepo.set(m.repo, [...(byRepo.get(m.repo) ?? []), m]);
  const connect = async () => {
    setBusy(true);
    try { const r = await call<{ ok: boolean; error?: string }>("/admin/api/integrations/teams", { url }); r.ok ? (toast("Teams connected — a test card was posted", "green"), setUrl("")) : toast(r.error ?? "Failed", "red"); load(); }
    finally { setBusy(false); }
  };
  return (
    <div className="grid2" style={{ marginTop: 16 }}>
      <div className="panel">
        <h3>Open merge requests <span className="n">{c.mrs.length} · GitLab {c.gitlab.lastRefresh ? `synced ${fmt.ago(c.gitlab.lastRefresh)}` : "not synced yet"}</span>
          <button className="btn sm" style={{ marginLeft: "auto" }} onClick={async () => { const r = await call<any>("/admin/api/gitlab/refresh", {}); toast(r.ok ? "GitLab synced" : r.error, r.ok ? "green" : "red"); load(); }}>Sync now</button></h3>
        {c.gitlab.lastError && <div className="note bad">{c.gitlab.lastError}</div>}
        {[...byRepo].map(([repo, list]) => (
          <div className="repo" key={repo}>
            <h4>{repo}</h4>
            {list.map((m: any, i: number) => {
              const hot = m.files.filter((f: string) => claimed.has(`${repo}:${f}`));
              return (
                <div key={m.iid} className={`mr ${hot.length ? "hot" : ""}`} style={{ animationDelay: `${i * 40}ms` }}>
                  <a href={m.url} target="_blank" rel="noreferrer" className="mono">!{m.iid}</a>
                  <span className="tt">{m.draft && <span className="tag">draft</span>} {m.title}</span>
                  <span className="dim">{m.author} · {m.files.length} files</span>
                  {hot.length > 0 && <span className="tag bad" title={hot.join(", ")}>⚡ overlaps live edit</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="panel">
        <h3>Team notes <span className="n">{c.notes.length}</span></h3>
        <div className="feed" style={{ maxHeight: 240 }}>
          {!c.notes.length && <div className="empty" style={{ padding: 14 }}>No notes yet — engineers add them with <code>/note</code> in the terminal.</div>}
          {c.notes.map((n: any) => (
            <div key={n.id} className="ev">
              <div className="ic" style={{ background: colorFor(n.email) + "22", color: colorFor(n.email) }}>📌</div>
              <div className="tx"><b>{n.repo}{n.path ? `/${n.path}` : ""}</b> {n.text} <em>· {n.email.split("@")[0]}</em></div>
              <div className="tm">{fmt.ago(n.created)}</div>
            </div>
          ))}
        </div>
        <h3 style={{ marginTop: 18 }}>Teams channel {c.teams.connected ? <span className="tag ok">● connected</span> : <span className="tag">not connected</span>}</h3>
        {c.teams.connected ? (
          <div className="dim" style={{ fontSize: 12.5 }}>Shipped MRs and usage alerts post to the channel. <button className="btn sm" onClick={async () => { await call("/admin/api/integrations/teams/disconnect", {}); load(); }}>Disconnect</button></div>
        ) : (
          <>
            <p className="hint">In the TenAI channel: <b>⋯ → Workflows → “Post to a channel when a webhook request is received”</b>, copy the URL it gives you and paste it here. TenAI posts a test card first.</p>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="inp mono" type="password" placeholder="https://…logic.azure.com/workflows/…" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button className="btn go" disabled={busy || url.length < 20 || !c.teams.configured} onClick={connect}>{busy ? "Testing…" : "Connect"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ChangesView() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { call<any[]>("/admin/api/changes").then(setRows); }, []);
  if (!rows.length) return <div className="empty">No changes shipped yet.</div>;
  return (
    <div className="view panel">
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Repo / branch</th><th>Files</th><th>Change</th><th>Merge request</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}>
            <td className="mono">{fmt.ago(r.ts)}</td>
            <td>{r.email.split("@")[0]}</td>
            <td><div>{r.repo}</div><div className="mono" style={{ color: "var(--teal)", fontSize: 11.5 }}>{r.branch}</div></td>
            <td>{JSON.parse(r.files).slice(0, 6).map((f: string) => <div key={f} className="mono" style={{ fontSize: 11.5 }}>{f}</div>)}</td>
            <td className="mono" style={{ fontSize: 12 }}>{r.sha?.slice(0, 8)}<div style={{ color: "var(--muted)" }}>{r.diffstat}</div></td>
            <td>{r.mr_url ? <a href={r.mr_url} target="_blank" rel="noreferrer">{r.mr_url.split("/").pop()} ↗</a> : <span className="tag">branch pushed</span>}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function PeopleView({ ov, refresh }: { ov: Overview; refresh: () => void }) {
  const toggle = async (email: string, blocked: boolean) => {
    if (!confirm(`${blocked ? "Unblock" : "Block"} ${email}?`)) return;
    await call(`/admin/api/users/${encodeURIComponent(email)}/${blocked ? "unblock" : "block"}`, {});
    refresh();
  };
  return (
    <div className="view panel">
      <table>
        <thead><tr><th>Person</th><th>Role</th><th>Sessions</th><th>Today's budget</th><th>Total spend</th><th>Last seen</th><th /></tr></thead>
        <tbody>{ov.people.map((p) => {
          const pct = Math.min(100, (p.tokens_today / Math.max(1, p.daily_token_budget)) * 100);
          return (
            <tr key={p.email}>
              <td><div style={{ display: "flex", gap: 10, alignItems: "center" }}><div className="av" style={{ background: colorFor(p.email), width: 30, height: 30, fontSize: 11 }}>{initials(p.name)}</div><div><div style={{ fontWeight: 600 }}>{p.name}{ov.online?.some((o) => o.email === p.email) && <span className="tag ok" style={{ marginLeft: 8 }}>● online</span>}</div><div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{p.email}</div></div></div></td>
              <td><span className={`tag ${p.role === "admin" ? "warn" : ""}`}>{p.role}</span>{p.blocked ? <span className="tag bad" style={{ marginLeft: 6 }}>blocked</span> : null}</td>
              <td className="mono">{p.sessions}</td>
              <td><div className="gauge"><i style={{ width: pct + "%" }} /></div><div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{fmt.k(p.tokens_today)} / {fmt.k(p.daily_token_budget)}</div></td>
              <td className="mono">{fmt.usd(p.cost_total)}</td>
              <td className="mono">{p.last_seen ? fmt.ago(p.last_seen) : "—"}</td>
              <td><button className={`btn sm ${p.blocked ? "" : "danger"}`} onClick={() => toggle(p.email, !!p.blocked)}>{p.blocked ? "Unblock" : "Block"}</button></td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

function TokensView({ ov }: { ov: Overview }) {
  const people = [...ov.people].sort((a, b) => b.cost_total - a.cost_total);
  const sessions = [...ov.sessions].sort((a, b) => b.tokens - a.tokens).slice(0, 12);
  const maxP = Math.max(1e-9, ...people.map((p) => p.cost_total));
  const maxS = Math.max(1, ...sessions.map((s) => s.tokens));
  return (
    <div className="view grid2" style={{ marginTop: 0 }}>
      <div className="panel"><h3>Spend by person</h3><div className="bars">{people.map((p) => (
        <div className="bar" key={p.email}><span>{p.name}</span><div className="tr"><i style={{ width: (p.cost_total / maxP) * 100 + "%" }} /></div><span className="mono">{fmt.usd(p.cost_total)}</span></div>
      ))}</div></div>
      <div className="panel"><h3>Tokens by session</h3><div className="bars">{sessions.map((s) => (
        <div className="bar" key={s.id}><span title={s.branch}>{s.name.split(" ")[0]} · {s.repo}</span><div className="tr"><i style={{ width: (s.tokens / maxS) * 100 + "%" }} /></div><span className="mono">{fmt.k(s.tokens)}</span></div>
      ))}</div></div>
    </div>
  );
}

// ---------- Gate: the intent model's learning loop ----------
const GLABELS: Array<{ k: string; key: string; name: string; color: string }> = [
  { k: "code_task", key: "1", name: "Code task", color: "#5b8cff" },
  { k: "code_question", key: "2", name: "Code question", color: "#28c9c9" },
  { k: "out_of_scope", key: "3", name: "Out of scope", color: "#ffb000" },
];
const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 1000) / 10}%`);

function GateInbox({ onChange }: { onChange: () => void }) {
  const [box, setBox] = useState<{ items: any[]; counts: Record<string, number> } | null>(null);
  const [sel, setSel] = useState(0);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const load = () => call<any>("/admin/api/gate/inbox").then((b) => { setBox(b); setGone(new Set()); });
  useEffect(() => { load(); }, []);
  const items = (box?.items ?? []).filter((i) => !gone.has(i.key));
  const act = async (item: any, label: string) => {
    if (!item) return;
    setGone((g) => new Set(g).add(item.key)); // optimistic: the card flies out
    await call("/admin/api/gate/label", { ids: item.ids, label });
    onChange();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      const it = items[Math.min(sel, items.length - 1)];
      const l = GLABELS.find((g) => g.key === e.key);
      if (l) act(it, l.k);
      else if (e.key === "d" || e.key === "x") act(it, "dismiss");
      else if (e.key === "j" || e.key === "ArrowDown") setSel((i) => Math.min(items.length - 1, i + 1));
      else if (e.key === "k" || e.key === "ArrowUp") setSel((i) => Math.max(0, i - 1));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [items, sel]);
  if (!box) return <div className="skel" />;
  return (
    <div className="view">
      <div className="inbox-hd">
        <span><b>{items.length}</b> waiting</span><span className="dim">{box.counts.labelled ?? 0} labelled · {box.counts.dismissed ?? 0} dismissed</span>
        <span className="sp" />
        <span className="keys">{GLABELS.map((g) => <span key={g.k}><span className="kbd">{g.key}</span> {g.name}</span>)}<span><span className="kbd">d</span> dismiss</span><span><span className="kbd">j/k</span> move</span></span>
      </div>
      {!items.length && <div className="empty">Inbox zero. Refused, borderline and appealed prompts land here.</div>}
      <div className="inbox">
        {items.map((it, i) => (
          <div key={it.key} className={`icard ${i === Math.min(sel, items.length - 1) ? "on" : ""} ${it.reasons.includes("appeal") ? "appeal" : ""}`} onClick={() => setSel(i)}>
            <div className="itx">“{it.text}”</div>
            <div className="imeta">
              {it.reasons.map((r: string) => <span key={r} className={`tag ${r === "appeal" ? "bad" : r === "refused" ? "warn" : ""}`}>{r}</span>)}
              <span>model said <b>{(it.model_label ?? "?").replace("_", " ")}</b> {it.model_score != null ? pct(it.model_score) : ""}{it.model_version ? ` · v${it.model_version}` : ""}</span>
              <span>{it.people.map((p: string) => p.split("@")[0]).join(", ")}{it.count > 1 ? ` · ×${it.count}` : ""}</span>
              <span className="dim">{fmt.ago(it.latest)}</span>
            </div>
            {it.notes.length > 0 && <div className="inote">💬 {it.notes.join(" · ")}</div>}
            <div className="ibtns">
              {GLABELS.map((g) => <button key={g.k} className="btn sm" style={{ ["--c" as string]: g.color }} onClick={(e) => { e.stopPropagation(); act(it, g.k); }}><span className="kbd">{g.key}</span> {g.name}</button>)}
              <button className="btn sm" onClick={(e) => { e.stopPropagation(); act(it, "dismiss"); }}>Dismiss</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Gates({ gates }: { gates: any[] }) {
  return <div className="gates">{gates.map((g, i) => (
    <div key={g.name} className={`gt ${g.ok ? "ok" : "bad"}`} style={{ animationDelay: `${i * 120}ms` }}>
      <span className="gi">{g.ok ? "✓" : "✗"}</span><span className="gn">{g.name}</span><span className="gv mono">{typeof g.got === "number" ? pct(g.got) : String(g.got ?? "—")} <em>want {g.want}</em></span>
    </div>
  ))}</div>;
}

function GateModels({ toast }: { toast: (t: string, tone?: Toast["tone"]) => void }) {
  const [m, setM] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const load = () => call<any>("/admin/api/gate/models").then(setM).catch((e) => setM({ error: e.message }));
  useEffect(() => { load(); }, []);
  const run = async (what: string, fn: () => Promise<any>, done: (r: any) => string) => {
    setBusy(what);
    try { const r = await fn(); toast(done(r), "green"); await load(); } catch (e) { toast((e as Error).message, "red"); } finally { setBusy(""); }
  };
  if (!m) return <div className="skel" />;
  if (m.error) return <div className="empty">{m.error}</div>;
  return (
    <div className="view">
      <div className="panel train-hd">
        <div>
          <div className="lb">Live model</div>
          <div className="big">v{m.live}{m.shadow ? <span className="tag" style={{ marginLeft: 10 }}>v{m.shadow} in shadow</span> : null}</div>
          <div className="dim">{m.labels.total} human labels · <b style={{ color: "var(--ink)" }}>{m.labels.sinceLastTrain}</b> new since the last version</div>
        </div>
        <div className="sp" />
        <button className="btn go" disabled={!!busy} onClick={() => run("train", () => call("/admin/api/gate/train", {}), (r) => `v${r.version} trained — ${r.passed ? "passed every gate" : "failed a gate"}`)}>
          {busy === "train" ? <><span className="spin" /> Training…</> : "Train challenger"}
        </button>
      </div>
      <div className="versions">
        {m.versions.map((v: any, i: number) => {
          const isLive = v.version === m.live, isShadow = v.version === m.shadow;
          return (
            <div key={v.version} className={`vcard ${isLive ? "live" : ""} ${v.passed ? "" : "failed"}`} style={{ animationDelay: `${i * 60}ms` }}>
              <div className="vh">
                <div className="vn">v{v.version}</div>
                {isLive && <span className="tag ok">● live</span>}
                {isShadow && <span className="tag warn">◐ shadow</span>}
                {!v.passed && <span className="tag bad">failed gates</span>}
                <span className="dim" style={{ marginLeft: "auto" }}>{v.by === "bootstrap" ? "first deploy" : `${v.by.split("@")[0]} · ${fmt.ago(v.created)}`}</span>
              </div>
              <div className="vstats">
                <div><b>{pct(v.golden.accuracy)}</b><span>golden exam ({v.golden.n})</span></div>
                <div><b>{pct(v.golden.oos_recall)}</b><span>off-topic caught</span></div>
                <div><b>{pct(v.golden.false_refusal)}</b><span>code refused</span></div>
                <div><b>{v.exam?.n ? pct(v.exam.accuracy) : "—"}</b><span>real prompts{v.exam?.n ? ` (${v.exam.n})` : ""}</span></div>
                <div><b>{v.train?.human_labels ?? 0}</b><span>human labels</span></div>
              </div>
              {v.train?.skipped_golden > 0 && <div className="dim" style={{ fontSize: 12, margin: "-4px 0 8px" }}>{v.train.skipped_golden} label{v.train.skipped_golden > 1 ? "s" : ""} matched a golden-exam prompt word for word and {v.train.skipped_golden > 1 ? "were" : "was"} not trained on (keeps the exam honest).</div>}
              <Gates gates={v.gates} />
              <div className="vbtns">
                {!isLive && v.passed && <button className="btn sm go" disabled={!!busy} onClick={() => confirm(`Make v${v.version} the live gate for everyone?`) && run("promote", () => call("/admin/api/gate/promote", { version: v.version }), () => `v${v.version} is live`)}>{v.version < m.live ? "Roll back to this" : "Promote to live"}</button>}
                {!isLive && (isShadow
                  ? <button className="btn sm" disabled={!!busy} onClick={() => run("shadow", () => call("/admin/api/gate/shadow", { version: null }), () => "Shadow stopped")}>Stop shadow</button>
                  : <button className="btn sm" disabled={!!busy} onClick={() => run("shadow", () => call("/admin/api/gate/shadow", { version: v.version }), () => `v${v.version} now runs in shadow on real prompts`)}>Run in shadow</button>)}
                {v.golden.misses?.length > 0 && <button className="btn sm" onClick={() => setOpen(open === v.version ? null : v.version)}>{open === v.version ? "Hide" : "Show"} {v.golden.misses.length} miss{v.golden.misses.length > 1 ? "es" : ""}</button>}
              </div>
              {open === v.version && <div className="misses">{v.golden.misses.map((x: any) => <div key={x.text}><span className="tag">{x.gold.replace("_", " ")}</span> “{x.text}” <em>→ {x.label.replace("_", " ")} {pct(x.score)}</em></div>)}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DriftChart({ days }: { days: any[] }) {
  const W = 760, H = 220, P = 34;
  const maxP = Math.max(4, ...days.map((d) => d.prompts));
  const x = (i: number) => P + (i * (W - P * 2)) / Math.max(1, days.length - 1);
  const rate = days.map((d) => (d.prompts ? d.refused / d.prompts : 0));
  const line = rate.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${(H - P - r * (H - P * 2)).toFixed(1)}`).join(" ");
  const bw = Math.max(6, (W - P * 2) / days.length - 10);
  return (
    <svg className="drift" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {[0, 0.25, 0.5, 0.75, 1].map((g) => <g key={g}><line x1={P} x2={W - P} y1={H - P - g * (H - P * 2)} y2={H - P - g * (H - P * 2)} className="gl" /><text x={4} y={H - P - g * (H - P * 2) + 4} className="ax">{g * 100}%</text></g>)}
      {days.map((d, i) => <rect key={d.day} className="pb" x={x(i) - bw / 2} width={bw} y={H - P - (d.prompts / maxP) * (H - P * 2)} height={(d.prompts / maxP) * (H - P * 2)} rx={4} style={{ animationDelay: `${i * 40}ms` }}><title>{d.day}: {d.prompts} prompts</title></rect>)}
      <path d={line} className="rl" pathLength={1} />
      {rate.map((r, i) => <circle key={i} cx={x(i)} cy={H - P - r * (H - P * 2)} r={days[i].appeals ? 5 : 3} className={days[i].appeals ? "ap" : "rd"}><title>{days[i].day}: {Math.round(r * 100)}% refused · {days[i].appeals} appeals · {days[i].borderline} borderline</title></circle>)}
      {days.map((d, i) => i % 2 === 0 ? <text key={d.day} x={x(i)} y={H - 10} className="ax" textAnchor="middle">{d.day.slice(5)}</text> : null)}
    </svg>
  );
}

function GateDrift() {
  const [days, setDays] = useState<any[] | null>(null);
  useEffect(() => { call<any[]>("/admin/api/gate/drift").then(setDays); }, []);
  if (!days) return <div className="skel" />;
  const sum = (k: string) => days.reduce((a, d) => a + d[k], 0);
  const seen = sum("shadowSeen");
  return (
    <div className="view">
      <div className="kpis" style={{ gridTemplateColumns: "repeat(5,minmax(0,1fr))" }}>
        <Kpi label="Prompts · 14d" value={sum("prompts")} render={fmt.n} color="#5b8cff" />
        <Kpi label="Refused by the gate" value={sum("refused")} render={fmt.n} color="#ffb000" />
        <Kpi label="Borderline (let through)" value={sum("borderline")} render={fmt.n} color="#a07bff" />
        <Kpi label="Appeals" value={sum("appeals")} render={fmt.n} color="#f0302a" />
        <Kpi label="Shadow agreement" value={seen ? (sum("shadowAgree") / seen) * 100 : 0} render={(v) => (seen ? `${Math.round(v)}%` : "—")} color="#2ecf8b" />
      </div>
      <div className="panel" style={{ marginTop: 16 }}>
        <h3>Refusal rate per day <span className="n">bars = prompts · line = % refused · red dots = days with appeals</span></h3>
        <DriftChart days={days} />
      </div>
    </div>
  );
}

function GateRefusals() {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { call<any[]>("/admin/api/gate").then(setRows); }, []);
  if (!rows) return <div className="skel" />;
  if (!rows.length) return <div className="empty">Nothing refused yet.</div>;
  return (
    <div className="view panel">
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Prompt</th><th>Why</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}><td className="mono">{fmt.ago(r.started)}</td><td>{r.email.split("@")[0]}</td><td>{r.prompt}</td>
            <td><span className={`tag ${r.gate_label === "guardrail" ? "bad" : "warn"}`}>{r.gate_label ?? "refused"}</span> <span className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{r.detail}{r.gate_score != null ? ` · ${pct(r.gate_score)}` : ""}</span></td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function GateView({ toast }: { toast: (t: string, tone?: Toast["tone"]) => void }) {
  const [tab, setTab] = useState<"inbox" | "models" | "drift" | "refusals">("inbox");
  const [waiting, setWaiting] = useState<number | null>(null);
  const count = () => call<any>("/admin/api/gate/inbox").then((b) => setWaiting(b.items.length)).catch(() => undefined);
  useEffect(() => { count(); }, []);
  return (
    <div className="view">
      <div className="tabs big">
        {([["inbox", `Inbox${waiting ? ` · ${waiting}` : ""}`], ["models", "Models"], ["drift", "Drift"], ["refusals", "Refusals"]] as const).map(([k, l]) =>
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === "inbox" && <GateInbox onChange={count} />}
      {tab === "models" && <GateModels toast={toast} />}
      {tab === "drift" && <GateDrift />}
      {tab === "refusals" && <GateRefusals />}
    </div>
  );
}

function LedgerView() {
  const [rows, setRows] = useState<any[]>([]);
  const [verdict, setVerdict] = useState<null | { brokenAt: number | null }>(null);
  useEffect(() => { call<any[]>("/admin/api/ledger").then(setRows); }, []);
  return (
    <div className="view panel">
      <div className="chain">
        <button className="btn go" onClick={() => call<{ brokenAt: number | null }>("/admin/api/ledger/verify").then(setVerdict)}>Verify hash chain</button>
        {verdict && (verdict.brokenAt === null ? <span className="tag ok">✓ all {rows.length}+ entries intact</span> : <span className="tag bad">✗ chain broken at #{verdict.brokenAt}</span>)}
      </div>
      <table>
        <thead><tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Detail</th><th>Hash</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.seq}><td className="mono">{r.seq}</td><td className="mono">{fmt.time(r.ts)}</td><td>{r.actor}</td>
            <td><span className={`tag ${/refused|denied|blocked|failed/.test(r.action) ? "bad" : r.action === "ship" ? "ok" : ""}`}>{r.action}</span></td>
            <td className="mono" style={{ fontSize: 11, color: "var(--muted)", maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis" }}>{r.payload}</td>
            <td className="hash">{r.hash.slice(0, 12)}…</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

// ---------- Claude account ----------
interface Win { utilization: number; resetsAt: number; status?: string }
interface ClaudeStatus {
  account: { kind: "oauth" | "api_key"; label: string; fingerprint: string; setAt: number; setBy: string; source: string } | null;
  model: { current: string; serverDefault: string; options: Array<{ id: string; label: string; note: string }> };
  usage: { status: string; fiveHour?: Win; sevenDay?: Win; overageStatus?: string; at: number } | null;
  forecast: { fiveHour: null | { perHour: number; hitsAt: number | null; beforeReset: boolean }; samples: Array<{ ts: number; five_hour: number | null; seven_day: number | null }> };
  spend: { day: { c: number; n: number; t: number }; week: { c: number; n: number; t: number } };
  history: Array<{ ts: number; actor: string; kind: string; label: string; fingerprint: string; from?: { label: string } | null }>;
  ok?: boolean; error?: string;
}

const until = (epochSec: number) => {
  const m = Math.max(0, Math.round((epochSec * 1000 - Date.now()) / 60000));
  return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

function Ring({ title, win }: { title: string; win?: Win }) {
  const used = win ? Math.round(win.utilization * 100) : null;
  const shown = useCountUp(used ?? 0);
  const color = used == null ? "var(--dim)" : used >= 85 ? "var(--red)" : used >= 60 ? "var(--o1)" : "var(--green)";
  const R = 54, C = 2 * Math.PI * R;
  return (
    <div className="ring">
      <svg viewBox="0 0 132 132">
        <circle cx="66" cy="66" r={R} className="trk" />
        <circle cx="66" cy="66" r={R} className="val" style={{ stroke: color, strokeDasharray: C, strokeDashoffset: C * (1 - (used ?? 0) / 100) }} />
      </svg>
      <div className="mid">
        <div className="big" style={{ color }}>{used == null ? "—" : `${Math.round(100 - shown)}%`}</div>
        <div className="sm">{used == null ? "no data yet" : "left"}</div>
      </div>
      <div className="cap"><b>{title}</b><span>{used == null ? "run a turn or Check now" : `${used}% used · resets in ${until(win!.resetsAt)}`}</span></div>
    </div>
  );
}

function Spark({ samples }: { samples: ClaudeStatus["forecast"]["samples"] }) {
  const pts = samples.filter((p) => p.five_hour != null);
  if (pts.length < 2) return <div className="dim" style={{ fontSize: 12 }}>The 24-hour trend appears after a few turns.</div>;
  const W = 520, H = 70, t0 = pts[0].ts, span = Math.max(1, pts.at(-1)!.ts - t0);
  const xy = (p: (typeof pts)[0]) => [((p.ts - t0) / span) * W, H - 4 - (p.five_hour ?? 0) * (H - 8)] as const;
  const d = pts.map((p, i) => `${i ? "L" : "M"}${xy(p)[0].toFixed(1)},${xy(p)[1].toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <line x1="0" x2={W} y1={H - 4 - 0.85 * (H - 8)} y2={H - 4 - 0.85 * (H - 8)} className="th" />
      <path d={`${d} L${W},${H} L0,${H} Z`} className="ar" />
      <path d={d} className="ln" pathLength={1} />
    </svg>
  );
}

function Forecast({ st }: { st: ClaudeStatus }) {
  const f = st.forecast?.fiveHour, w = st.usage?.fiveHour;
  let text: React.ReactNode = "Forecast appears after ~10 minutes of activity in this window.";
  let tone = "";
  if (f && w) {
    if (!f.hitsAt || f.perHour <= 0.001) text = <>Usage is flat — no risk of hitting the 5-hour limit before it resets in {until(w.resetsAt)}.</>;
    else if (f.beforeReset) { tone = "warn"; text = <>At this pace (<b>{Math.round(f.perHour * 100)}%/hour</b>) the 5-hour limit is hit at <b>{new Date(f.hitsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</b> — {until(f.hitsAt / 1000)} from now, before the reset.</>; }
    else text = <>At this pace (<b>{Math.round(f.perHour * 100)}%/hour</b>) the window resets before the limit — you're fine.</>;
  }
  return (
    <div className={`forecast ${tone}`}>
      <div className="fh"><b>5-hour window · last 24h</b><span className="dim">dashed line = 85% alert</span></div>
      <Spark samples={st.forecast?.samples ?? []} />
      <div className="ft">🔮 {text}</div>
    </div>
  );
}

function ClaudeView({ onChange }: { onChange: () => void }) {
  const [st, setSt] = useState<ClaudeStatus | null>(null);
  const [busy, setBusy] = useState<"" | "check" | "switch">("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [kind, setKind] = useState<"oauth" | "api_key">("oauth");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const load = () => call<ClaudeStatus>("/admin/api/claude").then(setSt).catch((e) => setMsg({ tone: "bad", text: e.message }));
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  const check = async () => {
    setBusy("check"); setMsg(null);
    try { const r = await call<ClaudeStatus>("/admin/api/claude/check", {}); setSt(r); setMsg(r.ok ? { tone: "ok", text: "Checked — usage refreshed." } : { tone: "bad", text: r.error ?? "Check failed" }); onChange(); }
    catch (e) { setMsg({ tone: "bad", text: (e as Error).message }); } finally { setBusy(""); }
  };
  const doSwitch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirm(`Switch every TenAI agent to "${label}"? Running turns finish on the old account; new turns use the new one.`)) return;
    setBusy("switch"); setMsg(null);
    try {
      const r = await call<ClaudeStatus>("/admin/api/claude/switch", { kind, label, secret });
      setSt(r);
      if (r.ok) { setSecret(""); setLabel(""); setMsg({ tone: "ok", text: `Switched. All new turns run on "${r.account?.label}".` }); onChange(); }
      else setMsg({ tone: "bad", text: r.error ?? "Switch failed" });
    } catch (x) { setMsg({ tone: "bad", text: (x as Error).message }); } finally { setBusy(""); }
  };

  if (!st) return <div className="empty">Loading…</div>;
  const a = st.account, u = st.usage;
  const statusTone = !u ? "" : u.status === "allowed" ? "ok" : u.status === "rejected" ? "bad" : "warn";
  return (
    <div className="view">
      <div className="grid2" style={{ marginTop: 0 }}>
        <div className="panel acct">
          <div className="acct-hd">
            <div className="orb" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="lb">Agents are running on</div>
              <div className="nm">{a ? a.label : "No Claude credential configured"}
                {a && <button className="btn sm" style={{ marginLeft: 10, verticalAlign: 3 }} onClick={async () => {
                  const l = prompt("Name this account (e.g. dev@example.com · Max):", a.label);
                  if (l && l.trim()) { setSt(await call<ClaudeStatus>("/admin/api/claude/rename", { label: l })); onChange(); }
                }}>Rename</button>}
              </div>
              {a && <div className="meta">
                <span className={`tag ${a.kind === "oauth" ? "warn" : "ok"}`}>{a.kind === "oauth" ? "Claude subscription" : "Anthropic API key"}</span>
                <span className="tag">fp {a.fingerprint}</span>
                <span>{a.source === "config" ? "from server config" : `set by ${a.setBy.split("@")[0]} · ${fmt.ago(a.setAt)}`}</span>
              </div>}
            </div>
            <button className="btn" onClick={check} disabled={!!busy || !a}>{busy === "check" ? "Checking…" : "Check now"}</button>
          </div>
          {a?.kind === "api_key" ? (
            <div className="rings"><div className="empty" style={{ padding: 20 }}>API keys are billed per token — no subscription windows. Spend is on the right.</div></div>
          ) : (
            <div className="rings">
              <Ring title="5-hour window" win={u?.fiveHour} />
              <Ring title="Weekly limit" win={u?.sevenDay} />
            </div>
          )}
          {a?.kind !== "api_key" && <Forecast st={st} />}
          <div className="acct-ft">
            {u ? <>
              <span className={`tag ${statusTone}`}>{u.status === "allowed" ? "● allowed" : u.status}</span>
              {u.overageStatus && <span className="tag">overage {u.overageStatus}</span>}
              <span>updated {fmt.ago(u.at)} · from every agent turn · counts everything on this Claude account (Studio, personal Claude Code), not only TenAI</span>
            </> : <span>No usage reported yet for this account.</span>}
          </div>
          {msg && <div className={`note ${msg.tone}`}>{msg.text}</div>}
          <div className="model-pick">
            <div className="lb">Agent model <span className="dim">· every new turn, for everyone · takes effect immediately</span></div>
            <div className="seg">
              {st.model.options.map((m) => (
                <button key={m.id} className={`seg-btn ${st.model.current === m.id ? "on" : ""}`} disabled={!!busy || st.model.current === m.id}
                  title={m.note}
                  onClick={async () => {
                    if (!confirm(`Run every new TenAI turn on ${m.label}?\n\n${m.note}`)) return;
                    const r = await call<ClaudeStatus>("/admin/api/claude/model", { model: m.id });
                    setSt(r);
                    setMsg(r.ok ? { tone: "ok", text: `Agents now run on ${m.label} from the next turn.` } : { tone: "bad", text: r.error ?? "Could not switch" });
                    onChange();
                  }}>{m.label}</button>
              ))}
            </div>
            <div className="dim small">{st.model.options.find((m) => m.id === st.model.current)?.note}</div>
          </div>
        </div>

        <div className="panel">
          <h3>Spend through TenAI</h3>
          <div className="kpis two">
            <Kpi label="Last 24 hours" value={st.spend.day.c} render={fmt.usd} color="#ff7a1a" />
            <Kpi label="Last 7 days" value={st.spend.week.c} render={fmt.usd} color="#f0302a" />
            <Kpi label="Turns · 24h" value={st.spend.day.n} render={fmt.n} color="#5b8cff" />
            <Kpi label="Tokens · 24h" value={st.spend.day.t} render={fmt.k} color="#a07bff" />
          </div>
          <h3 style={{ marginTop: 18 }}>Account history</h3>
          <div className="feed" style={{ maxHeight: 220 }}>
            {!st.history.length && <div className="empty" style={{ padding: 16 }}>No switches yet.</div>}
            {st.history.map((h, i) => (
              <div className="ev" key={i}>
                <div className="ic" style={{ background: "#ff7a1a22", color: "#ff7a1a" }}>⇄</div>
                <div className="tx"><b>{h.actor.split("@")[0]}</b> switched to <b>{h.label}</b> <em>· {h.kind === "oauth" ? "subscription" : "API key"} · fp {h.fingerprint}{h.from ? ` · was ${h.from.label}` : ""}</em></div>
                <div className="tm">{fmt.ago(h.ts)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <form className="panel switch" onSubmit={doSwitch}>
        <h3>Switch the account</h3>
        <div className="seg">
          <button type="button" className={kind === "oauth" ? "on" : ""} onClick={() => setKind("oauth")}>Claude subscription (now)</button>
          <button type="button" className={kind === "api_key" ? "on" : ""} onClick={() => setKind("api_key")}>Anthropic API key (company, later)</button>
        </div>
        <p className="hint">{kind === "oauth"
          ? <>On any machine signed in to the Claude account you want, run <code>claude setup-token</code> and paste the token it prints (<code>sk-ant-oat…</code>).</>
          : <>Create a key in the Anthropic Console for the company workspace and paste it (<code>sk-ant-api…</code>). Usage is then billed per token.</>}
          {" "}TenAI tests it with one tiny request first and only switches if it works. The secret is stored on the server (0600) and never shown again.</p>
        <div className="row">
          <input className="inp" placeholder={kind === "oauth" ? "Label, e.g. dev@example.com · Max" : "Label, e.g. OpenWallet company key"} value={label} onChange={(e) => setLabel(e.target.value)} />
          <input className="inp mono" type="password" autoComplete="off" spellCheck={false} placeholder={kind === "oauth" ? "sk-ant-oat01-…" : "sk-ant-api03-…"} value={secret} onChange={(e) => setSecret(e.target.value)} />
          <button className="btn go" disabled={!!busy || !label.trim() || secret.trim().length < 20}>{busy === "switch" ? "Testing…" : "Test & switch"}</button>
        </div>
        {location.protocol === "http:" && <p className="hint warnline">⚠ This page is plain HTTP — the token crosses the office network unencrypted. Prefer switching from a machine on the same VPN, and rotate the token if in doubt.</p>}
      </form>
    </div>
  );
}

// ---------- shell ----------
function Shell() {
  const [view, setView] = useState<View>("live");
  const [ov, setOv] = useState<Overview | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<string | null>(null);
  const [pal, setPal] = useState(false);
  const [q, setQ] = useState("");
  const [palIdx, setPalIdx] = useState(0);
  const [wsUp, setWsUp] = useState(false);
  const [theme, cycleTheme] = useTheme();
  const [notice, setNotice] = useState<{ level: string; text: string } | null>(null);
  const railRef = useRef<HTMLElement>(null);
  const [ind, setInd] = useState(0);
  const go = (v: View) => transition(() => setView(v));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cons = useRef<Constellation | null>(null);
  const live = useRef(new Map<string, string[]>());
  const ovRef = useRef<Overview | null>(null);
  ovRef.current = ov;
  let seq = useRef(1);

  const refresh = useCallback(() => { call<Overview>("/admin/api/overview").then(setOv).catch(() => undefined); }, []);
  const [claudePill, setClaudePill] = useState<ClaudeStatus | null>(null);
  const loadClaude = useCallback(() => { call<ClaudeStatus>("/admin/api/claude").then(setClaudePill).catch(() => undefined); }, []);
  const loadClaudeRef = useRef(loadClaude);
  useEffect(() => { loadClaude(); const t = setInterval(loadClaude, 30000); return () => clearInterval(t); }, [loadClaude]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [refresh]);

  const toast = (text: string, tone: Toast["tone"] = "") => {
    const id = seq.current++;
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  };
  const addFeed = (f: Omit<FeedItem, "id" | "ts">) => setFeed((xs) => [{ ...f, id: seq.current++, ts: Date.now() }, ...xs].slice(0, 80));
  const nameOf = (sessionId?: string) => ovRef.current?.sessions.find((s) => s.id === sessionId)?.name.split(" ")[0] ?? "someone";
  const pulse = (id: string) => { setFlash((f) => new Set(f).add(id)); setTimeout(() => setFlash((f) => { const n = new Set(f); n.delete(id); return n; }), 1300); };
  const pushLive = (id: string, line: string) => { const l = live.current.get(id) ?? []; l.push(line); live.current.set(id, l.slice(-400)); };

  useEffect(() => {
    let ws: WebSocket | null = null, stop = false;
    const open = () => {
      ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/admin/ws");
      ws.onopen = () => { ws!.send(JSON.stringify({ type: "auth", token: getToken() })); setWsUp(true); };
      ws.onclose = () => { setWsUp(false); if (!stop) setTimeout(open, 2000); };
      ws.onmessage = (m) => {
        const f = JSON.parse(String(m.data)) as ServerFrame;
        const c = cons.current;
        switch (f.type) {
          case "turn.start": c?.fire(f.sessionId, "#ff7a1a"); pulse(f.sessionId); addFeed({ icon: "▶", color: "#ff7a1a", text: <><b>{nameOf(f.sessionId)}</b>'s agent started a turn</> }); refresh(); break;
          case "turn.text": pushLive(f.sessionId, f.text); break;
          case "turn.tool": c?.fire(f.sessionId, TOOL_COLORS[f.name] ?? "#5b8cff"); pushLive(f.sessionId, `⏺ ${f.name} ${f.summary}`); break;
          case "turn.tool_result": if (f.denied) { c?.flash(f.sessionId, "#ff5d6c"); pushLive(f.sessionId, "⛔ " + f.text.slice(0, 200)); addFeed({ icon: "⛔", color: "#ff5d6c", tone: "red", text: <><b>{nameOf(f.sessionId)}</b>'s agent was stopped by policy</> }); toast(`Policy blocked a tool call in ${nameOf(f.sessionId)}'s session`, "red"); } break;
          case "turn.done": c?.fire(f.sessionId, "#2ecf8b", true); addFeed({ icon: "✓", color: "#2ecf8b", text: <><b>{nameOf(f.sessionId)}</b> finished a turn <em>· {fmt.k(f.tokens)} tok · {fmt.usd(f.costUsd)}</em></> }); refresh(); break;
          case "turn.error": addFeed({ icon: "!", color: "#ff5d6c", tone: "red", text: <><b>{nameOf(f.sessionId)}</b>: {f.message}</> }); refresh(); break;
          case "gate.refused": c?.flash(f.sessionId, "#ffb000"); pushLive(f.sessionId, "⚠ refused: " + f.reason); addFeed({ icon: "⛨", color: "#ffb000", tone: "amber", text: <><b>{nameOf(f.sessionId)}</b>: refused <em>({f.rule ?? f.label})</em></> }); refresh(); break;
          case "collision.warning": {
            const others = ovRef.current?.sessions.filter((x) => x.status === "active" && f.with.some((w) => w.email === x.email) && x.id !== f.sessionId) ?? [];
            if (others.length) others.forEach((o) => c?.lightning(f.sessionId, o.id)); else c?.flash(f.sessionId, "#ff5d6c");
          } toast(`Collision: ${f.paths.join(", ")} — also ${f.with.map((w) => w.email.split("@")[0]).join(", ")}`, "red"); break;
          case "session.blocked": refresh(); break;
          case "notice": setNotice({ level: f.level, text: f.text }); toast(f.text, f.level === "bad" ? "red" : f.level === "warn" ? "amber" : ""); loadClaudeRef.current(); break;
          case "spine.event":
            if (f.kind === "mr.opened") { toast(`${f.actor.split("@")[0]} opened a merge request in ${f.repo}`, "green"); addFeed({ icon: "⇡", color: "#2ecf8b", text: <><b>{f.actor.split("@")[0]}</b> opened a merge request <em>· {f.repo}</em></> }); }
            if (f.kind === "session.start") { addFeed({ icon: "+", color: "#a07bff", text: <><b>{f.actor.split("@")[0]}</b> connected <em>· {f.repo}</em></> }); refresh(); }
            if (f.kind === "presence.online") { addFeed({ icon: "●", color: "#2ecf8b", text: <><b>{(f.payload as any).name ?? f.actor}</b> opened the OpenWallet Terminal</> }); toast(`${(f.payload as any).name ?? f.actor} is online`, "green"); refresh(); }
            if (f.kind === "presence.offline") { addFeed({ icon: "○", color: "#5f6886", text: <><b>{(f.payload as any).name ?? f.actor}</b> closed the terminal</> }); refresh(); }
            if (f.kind === "collision") addFeed({ icon: "⚡", color: "#ff5d6c", tone: "red", text: <>Collision in <b>{f.repo}</b> <em>{((f.payload as any).paths ?? []).join(", ")}</em></> });
            break;
        }
      };
    };
    open();
    return () => { stop = true; ws?.close(); };
  }, []);

  useEffect(() => {
    if (view !== "live" || !canvasRef.current) return;
    cons.current = new Constellation(canvasRef.current);
    return () => { cons.current?.destroy(); cons.current = null; };
  }, [view, !!ov]);
  useEffect(() => {
    const active = (ov?.sessions ?? []).filter((s) => s.status === "active");
    const withSession = new Set(active.map((s) => s.email));
    cons.current?.setNodes([
      ...active.map((s) => ({ id: s.id, label: s.name.split(" ")[0], sub: s.repo, color: colorFor(s.email), working: ov!.running.includes(s.id) })),
      // connected people who haven't opened a session yet still show up — dashed, breathing
      ...(ov?.online ?? []).filter((o) => !withSession.has(o.email)).map((o) => ({
        id: "user:" + o.email, label: o.name.split(" ")[0], sub: "online · no session yet", color: colorFor(o.email), working: false, idle: true,
      })),
    ]);
  }, [ov, view]);

  useEffect(() => {
    const b = railRef.current?.querySelector<HTMLElement>("button.on");
    if (b) setInd(b.offsetTop + 12);
  }, [view, ov]);

  const actions = useMemo(() => [
    ...(Object.keys(TITLES) as View[]).map((v) => ({ label: `Go to ${TITLES[v][0]}`, run: () => go(v) })),
    { label: `Theme: ${theme} → ${theme === "system" ? "dark" : theme === "dark" ? "light" : "system"}`, run: cycleTheme },
    { label: ov?.frozen ? "Resume TenAI (unfreeze)" : "Freeze TenAI — stop all agents", run: () => call("/admin/api/freeze", { on: !ov?.frozen }).then(refresh) },
    ...(ov?.sessions.filter((s) => s.status === "active").map((s) => ({ label: `Open ${s.name}'s session · ${s.repo}`, run: () => { go("sessions"); setDrawer(s.id); } })) ?? []),
    { label: "Sign out", run: () => { setToken(null); location.reload(); } },
  ], [ov, theme]);
  const matches = actions.filter((a) => a.label.toLowerCase().includes(q.toLowerCase()));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPal((p) => !p); setQ(""); setPalIdx(0); }
      if (e.key === "Escape") { setPal(false); setDrawer(null); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  if (!ov) return <div className="login"><div className="empty">Loading TenAI…</div></div>;
  const [title, sub] = TITLES[view];
  return (
    <div className="app">
      <nav className="rail" ref={railRef}>
        <div className="logo">P10</div>
        <div className="rail-ind" style={{ transform: `translateY(${ind}px)` }} />
        {(Object.keys(TITLES) as View[]).map((v) => (
          <button key={v} className={view === v ? "on" : ""} onClick={() => go(v)} title={TITLES[v][0]}>{ICONS[v]}<span>{TITLES[v][0]}</span></button>
        ))}
        <div className="grow" />
        <button className="theme-btn" onClick={cycleTheme} title={`Theme: ${theme} (click to change)`}>{THEME_ICON[theme]}<span>{theme}</span></button>
      </nav>
      <main className="main">
        <header className="top">
          <div><h1>{title}</h1><div className="sub">{sub}</div></div>
          <div className="sp" />
          {claudePill?.account && (() => {
            const f = claudePill.usage?.fiveHour, used = f ? Math.round(f.utilization * 100) : null;
            return <button className={`pill click ${used != null && used >= 85 ? "bad" : used != null && used >= 60 ? "warn" : ""}`} onClick={() => go("claude")} title="Claude account and usage">
              <i />{claudePill.account.label.split("·")[0].trim().slice(0, 28)}{used != null ? ` · ${100 - used}% left (5h)` : ""}
            </button>;
          })()}
          <span className={`pill ${wsUp ? "" : "warn"}`}><i />{wsUp ? "live" : "reconnecting"}</span>
          {ov.frozen && <span className="pill bad"><i />frozen</span>}
          <button className={`btn ${ov.frozen ? "go" : "danger"}`} onClick={() => { if (confirm(ov.frozen ? "Resume all agents?" : "Freeze TenAI? All running turns stop and new prompts are refused.")) call("/admin/api/freeze", { on: !ov.frozen }).then(refresh); }}>{ov.frozen ? "Resume" : "Freeze all"}</button>
          <button className="btn" onClick={() => setPal(true)}><span className="kbd">⌘K</span></button>
        </header>
        {notice && <div className={`banner ${notice.level}`}><span>{notice.level === "bad" ? "⛔" : "⚠"} {notice.text}</span><button className="btn sm" onClick={() => setNotice(null)}>Dismiss</button></div>}
        <div className="body" key={view}>
          {view === "live" && <LiveView ov={ov} feed={feed} canvasRef={canvasRef} />}
          {view === "sessions" && <SessionsView ov={ov} flash={flash} open={setDrawer} />}
          {view === "spine" && <SpineView toast={toast} />}
          {view === "changes" && <ChangesView />}
          {view === "people" && <PeopleView ov={ov} refresh={refresh} />}
          {view === "tokens" && <TokensView ov={ov} />}
          {view === "claude" && <ClaudeView onChange={loadClaude} />}
          {view === "gate" && <GateView toast={toast} />}
          {view === "ledger" && <LedgerView />}
        </div>
      </main>
      {drawer && <SessionDrawer id={drawer} ov={ov} live={live.current} close={() => setDrawer(null)} refresh={refresh} />}
      {pal && (
        <>
          <div className="scrim" onClick={() => setPal(false)} />
          <div className="pal">
            <input autoFocus placeholder="Jump to a view, a session, or an action…" value={q}
              onChange={(e) => { setQ(e.target.value); setPalIdx(0); }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") setPalIdx((i) => Math.min(matches.length - 1, i + 1));
                if (e.key === "ArrowUp") setPalIdx((i) => Math.max(0, i - 1));
                if (e.key === "Enter" && matches[palIdx]) { matches[palIdx].run(); setPal(false); }
              }} />
            {matches.slice(0, 9).map((a, i) => <div key={a.label} className={`it ${i === palIdx ? "on" : ""}`} onMouseEnter={() => setPalIdx(i)} onClick={() => { a.run(); setPal(false); }}>{a.label}<span className="kbd">↵</span></div>)}
          </div>
        </>
      )}
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}</div>
    </div>
  );
}

function Root() {
  const [authed, setAuthed] = useState(!!getToken());
  return authed ? <Shell /> : <Login onIn={() => setAuthed(true)} />;
}

createRoot(document.getElementById("root")!).render(<Root />);
