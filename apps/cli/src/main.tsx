#!/usr/bin/env bun
/**
 * openwallet — the OpenWallet Terminal. `openwallet` shows the banner, signs in with an email code on first run, then opens
 * the terminal: type a question or a change in plain English, `/` for the command menu, Tab for a suggestion.
 */
import type { ServerFrame } from "@tenai/wire";
import { Box, render, Static, Text, useApp, useInput } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createInterface } from "node:readline/promises";
import { banner, paint } from "./banner";
import { api, TenaiClient } from "./client";
import { clipboardImage, extractFiles, localFile } from "./attach";
import { downloadAttachments, fetchTicket, JIRA_DEFAULT, loadJira, saveJira, ticketKey, ticketPrompt, whoAmI } from "./jira";
import { clearCreds, type Creds, DEFAULT_SERVER, loadCreds, saveCreds } from "./creds";

const VERSION = "1.4.0";

const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/** One quick look at the server's CLI version; never blocks start-up for more than 1.5 s. */
async function updateNotice(server: string): Promise<void> {
  try {
    const r = await fetch(server + "/api/cli", { signal: AbortSignal.timeout(1500) });
    const { version } = (await r.json()) as { version: string | null };
    if (version && newer(version, VERSION)) {
      console.log(paint.rgb(0.1, `  ⬆ Update available: ${VERSION} → ${version}`) + paint.dim("  ·  run ") + paint.bold("openwallet update") + "\n");
    }
  } catch { /* offline or old server: ignore */ }
}
const C = { amber: "#ffb000", orange: "#ff7a1a", red: "#f0302a", ink: "#eef0f7", muted: "#9aa2bd", dim: "#5f6886", blue: "#5b8cff", green: "#2ecf8b", violet: "#a07bff", teal: "#28c9c9" };

type Item =
  | { id: number; kind: "welcome"; name: string; modelId: string; admin: boolean; repos: string[] }
  | { id: number; kind: "you"; text: string }
  | { id: number; kind: "peer"; name: string; text: string }
  | { id: number; kind: "agent"; text: string }
  | { id: number; kind: "tool"; name: string; summary: string }
  | { id: number; kind: "denied"; text: string }
  | { id: number; kind: "refused"; text: string }
  | { id: number; kind: "system"; text: string }
  | { id: number; kind: "warn"; text: string }
  | { id: number; kind: "done"; tokens: number; cost: number; secs: number }
  | { id: number; kind: "diff"; files: string[]; patch: string }
  | { id: number; kind: "shipped"; text: string }
  | { id: number; kind: "suggest"; title: string; list: string[] };

let nextId = 1;

// ---- commands (the "/" menu) ----
interface Cmd { name: string; args?: string; desc: string; needsSession?: boolean }
const COMMANDS: Cmd[] = [
  { name: "/repo", args: "<name>", desc: "start a session in a repository" },
  { name: "/ticket", args: "<KEY>", desc: "start from a Jira ticket: reads it (and its screenshots), plans across repos, branches named after it" },
  { name: "/undo", args: "[repo]", desc: "put the files back as they were before the last turn (one repo or all); repeat to go further", needsSession: true },
  { name: "/review", desc: "go through every change one by one: keep it, drop it, or ask about it", needsSession: true },
  { name: "/contracts", desc: "backend fields/endpoints you removed or renamed that Admin Console or the portal still use", needsSession: true },
  { name: "/invite", args: "<name>", desc: "pair: bring a teammate into this session — you both see every turn and either can prompt", needsSession: true },
  { name: "/join", args: "[id]", desc: "join a session you were invited to (or were handed)" },
  { name: "/members", desc: "who is in this session", needsSession: true },
  { name: "/handoff", args: "<name>", desc: "give this session (changes + the agent's memory of it) to a teammate", needsSession: true },
  { name: "/leave", desc: "drop out of someone else's session", needsSession: true },
  { name: "/mine", args: "[word]", desc: "your unmerged branches in every repo, e.g. /mine developer portal" },
  { name: "/branch", args: "<repo>:<name> [more…]", desc: "put one repo of the session on existing branch(es) — /ship pushes onto the first, copies to the rest" },
  { name: "/fresh", args: "<repo>", desc: "put a repo back on a fresh branch (its /ship opens a merge request)", needsSession: true },
  { name: "/check", args: "[repo]", desc: "compile what changed (type-check / Gradle compile) — the agent runs this too", needsSession: true },
  { name: "/status", desc: "every repo in this session: its branch, where /ship sends it", needsSession: true },
  { name: "/also", args: "<branch…>", desc: "also copy this session's change onto these branches on /ship (/also none clears)", needsSession: true },
  { name: "/branches", args: "[filter]", desc: "find branches in this repo, e.g. /branches missing" },
  { name: "/new", args: "[title]", desc: "fresh session (new branch) in the current repo", needsSession: true },
  { name: "/diff", desc: "show this session's changes", needsSession: true },
  { name: "/ship", args: "<message>", desc: "ship every repo you changed (checks cross-repo contracts first; --force to override)", needsSession: true },
  { name: "/suggest", desc: "questions you can ask about this repo right now" },
  { name: "/appeal", args: "[why]", desc: "TenAI refused a code question? send it to the admins to teach the gate" },
  { name: "/who", desc: "who is working on what right now, across every repo" },
  { name: "/mrs", desc: "open merge requests into this repo's base branch, and the files they change" },
  { name: "/note", args: "[@path] <text>", desc: "pin a note for the team (and every agent) on this repo or a path" },
  { name: "/notes", desc: "team notes for this repo" },
  { name: "/unnote", args: "<id>", desc: "remove a note you wrote" },
  { name: "/attach", args: "<path>", desc: "attach a screenshot or log to your next prompt (or drag the file in, or Ctrl+V a copied screenshot)" },
  { name: "/cancel", desc: "stop the running turn (or press Esc)", needsSession: true },
  { name: "/sessions", desc: "your open sessions" },
  { name: "/resume", args: "<id>", desc: "reattach to a session" },
  { name: "/end", desc: "end this session", needsSession: true },
  { name: "/help", desc: "commands and keys" },
  { name: "/logout", desc: "sign out of this machine" },
  { name: "/update", desc: "get the newest OpenWallet Terminal (restarts)" },
  { name: "/quit", desc: "exit (Ctrl+C)" },
];
const HELP = [
  ...COMMANDS.map((c) => `${(c.name + " " + (c.args ?? "")).padEnd(18)} ${c.desc}`),
  "",
  "Keys: / opens the menu · ↑↓ pick · Tab completes or uses the suggestion · Esc stops a turn · ↑↓ on an empty line = history",
  "Just type in English: questions about code, history (\"what did Alex change in beneficiary last week?\") or changes.",
].join("\n");

// ---- loader words + plain-language activity ----
const VERBS = ["OpenWalleting", "Ten-eyeing", "Remitting", "Settling", "Reconciling", "Clearing", "Routing", "Ledgering",
  "Beneficiary-ing", "Cross-bordering", "Forexing", "Wallet-walking", "Tenifying", "Merchanting", "Treasurying", "Spine-reading"];
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GRAD = [C.amber, "#ffa00a", "#ff8e14", C.orange, "#f8602a", C.red, "#f8602a", C.orange, "#ff8e14", "#ffa00a"];

function describe(name: string, summary: string): string {
  const s = summary.length > 70 ? summary.slice(0, 67) + "…" : summary;
  switch (name) {
    case "Read": return `Reading ${s}`;
    case "Grep": return `Searching the code for “${s}”`;
    case "Glob": return `Looking for files like ${s}`;
    case "Edit": case "Write": case "MultiEdit": return `Editing ${s}`;
    case "Bash":
      if (/^git log\b.*--author/.test(summary)) return `Going through ${summary.match(/--author[= ]"?([^"\s]+)/)?.[1] ?? "their"}'s commits`;
      if (/^git log\b.*--merges/.test(summary)) return "Reading recent merge requests";
      if (/^git log\b/.test(summary)) return "Digging through git history";
      if (/^git show\b/.test(summary)) return `Opening commit ${summary.split(/\s+/)[2]?.slice(0, 10) ?? ""}`;
      if (/^git diff\b/.test(summary)) return "Comparing changes";
      if (/^git (add|commit)\b/.test(summary)) return "Committing the change locally";
      return `Running ${s}`;
    default: return `${name} ${s}`;
  }
}

/** Pick a repo from the question so people can just start typing. */
function guessRepo(text: string, repos: string[]): string | null {
  const t = text.toLowerCase();
  const hints: Array<[RegExp, string]> = [
    [/\b(shield|angular|component|screen|ui|page|sidebar|frontend|front-end)\b/, "shield"],
    [/\b(developer portal|dev portal|portal|devhub)\b/, "developer-portal"],
    [/\b(api|backend|service|processor|controller|java|hbl|ubl|citybank|terrapay|beneficiar\w*|transaction|kafka|liquibase|scheduler)\b/, "core-api"],
  ];
  for (const [re, key] of hints) if (re.test(t)) { const r = repos.find((x) => x.includes(key)); if (r) return r; }
  return repos.find((r) => r.includes("core-api")) ?? repos[0] ?? null;
}

// ---- light markdown for agent answers: # headings, **bold**, `code`, - bullets ----
function MdLine({ line }: { line: string }) {
  const h = line.match(/^(#{1,4})\s+(.*)$/);
  if (h) return <Text bold color={C.orange}>{h[2].replace(/\*\*/g, "")}</Text>;
  const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
  const body = bullet ? bullet[2] : line;
  const parts = body.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <Text color={C.ink}>
      {bullet ? <Text color={C.amber}>{bullet[1]}• </Text> : null}
      {parts.map((p, i) => p.startsWith("**") ? <Text key={i} bold>{p.slice(2, -2)}</Text>
        : p.startsWith("`") ? <Text key={i} color={C.teal}>{p.slice(1, -1)}</Text> : <Text key={i}>{p}</Text>)}
    </Text>
  );
}

// ---- view pieces ----
function Welcome({ item }: { item: Extract<Item, { kind: "welcome" }> }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.orange} paddingX={2} marginBottom={1}>
      <Text><Text color={C.orange}>✻ </Text><Text bold color={C.ink}>Welcome, {item.name.split(" ")[0]}!</Text><Text color={C.muted}>  your agent is {item.modelId}{item.admin ? " · admin" : ""}</Text></Text>
      <Text color={C.muted}>  Type a question or a change in plain English. <Text color={C.amber}>/</Text> for commands · <Text color={C.amber}>Tab</Text> uses a suggestion · <Text color={C.amber}>Esc</Text> stops a turn</Text>
      <Text color={C.muted}>  Repos: {item.repos.map((r, i) => <Text key={r} color={[C.blue, C.teal, C.violet][i % 3]}>{r}{i < item.repos.length - 1 ? "  " : ""}</Text>)}</Text>
    </Box>
  );
}

function Row({ item }: { item: Item }) {
  switch (item.kind) {
    case "welcome": return <Welcome item={item} />;
    case "peer": return <Box marginTop={1}><Text><Text color={C.violet} bold>› {item.name}: </Text><Text color={C.ink}>{item.text}</Text></Text></Box>;
    case "you": return <Box marginTop={1}><Text><Text color={C.orange} bold>› </Text><Text color={C.ink} bold>{item.text}</Text></Text></Box>;
    case "agent": return <Box marginLeft={2} flexDirection="column">{item.text.split("\n").map((l, i) => <MdLine key={i} line={l} />)}</Box>;
    case "tool": return <Box marginLeft={2}><Text color={C.blue}>⏺ </Text><Text color={C.muted}>{describe(item.name, item.summary)}</Text></Box>;
    case "denied": return <Box marginLeft={4}><Text color={C.red}>⛔ {item.text}</Text></Box>;
    case "refused": return <Text color={C.amber}>⚠ {item.text}</Text>;
    case "warn": return <Text color={C.red} bold>⚡ {item.text}</Text>;
    case "system": return <Text color={C.muted}>{item.text}</Text>;
    case "done": return <Box marginLeft={2}><Text color={C.green}>✓ done</Text><Text color={C.dim}>  {item.secs}s · {item.tokens.toLocaleString()} tokens · ${item.cost.toFixed(4)}</Text></Box>;
    case "diff":
      return (
        <Box flexDirection="column" marginLeft={2}>
          <Text color={C.teal}>Changed: {item.files.join(", ") || "nothing yet"}</Text>
          {item.patch.split("\n").slice(0, 120).map((l, i) => (
            <Text key={i} color={l.startsWith("+") && !l.startsWith("+++") ? C.green : l.startsWith("-") && !l.startsWith("---") ? C.red : C.muted}>{l}</Text>
          ))}
        </Box>
      );
    case "shipped": return <Text color={C.green} bold>🚀 {item.text}</Text>;
    case "suggest":
      return (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          <Text color={C.dim}>{item.title}</Text>
          {item.list.map((s, i) => <Text key={i}><Text color={C.amber}>  {i + 1}. </Text><Text color={C.muted}>{s}</Text></Text>)}
        </Box>
      );
  }
}

function Loader({ phase, activity, started }: { phase: string; activity: string; started: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 90); return () => clearInterval(t); }, []);
  // a new word every ~2.7s, like Claude Code's "Thinking…" variants
  const verb = useMemo(() => VERBS[Math.floor(Math.random() * VERBS.length)], [Math.floor(tick / 30)]);
  const secs = Math.floor((Date.now() - started) / 1000);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={GRAD[tick % GRAD.length]}>{FRAMES[tick % FRAMES.length]} </Text>
        <Text color={GRAD[(tick + 3) % GRAD.length]} bold>{phase || verb}…</Text>
        <Text color={C.dim}>  ({secs}s · esc to stop)</Text>
      </Text>
      {activity ? <Text color={C.muted}>  ⎿ {activity}</Text> : null}
    </Box>
  );
}

function App({ creds, client }: { creds: Creds; client: TenaiClient }) {
  const { exit } = useApp();
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [hIndex, setHIndex] = useState(-1);
  const [session, setSession] = useState<{ id: string; repo: string; branch: string; target?: string | null; also?: string[] } | null>(null);
  // every repo of the session (sessions span repos); empty for older single-repo sessions
  const [slots, setSlots] = useState<Array<{ repo: string; branch: string; target: string | null; also: string[] }>>([]);
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const [branchList, setBranchList] = useState<{ repo: string; names: Array<{ name: string; protected: boolean; mr: number | null }> } | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const [status, setStatus] = useState<"connecting" | "idle" | "working" | "queued">("connecting");
  const [phase, setPhase] = useState("");
  const [activity, setActivity] = useState("");
  const [started, setStarted] = useState(Date.now());
  const [spine, setSpine] = useState<string[]>([]);
  const [pendingAttachments, setPending] = useState<string[]>([]); // local paths, uploaded with the next prompt
  const pendingRef = useRef(pendingAttachments);
  pendingRef.current = pendingAttachments;
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [sIndex, setSIndex] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const pendingPrompt = useRef<string | null>(null);
  const pendingSwitch = useRef(false);
  const pendingTicket = useRef<string | null>(null);
  const lastInvite = useRef<string | null>(null);
  type HunkView = { repo: string; id: string; file: string; header: string; lines: string[]; adds: number; dels: number; newFile: boolean };
  const [review, setReview] = useState<{ hunks: HunkView[]; i: number; kept: number; dropped: number; busy: boolean } | null>(null);
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const welcomed = useRef(false);
  const suggestionsRef = useRef<string[]>([]);
  suggestionsRef.current = suggestions;
  const turnKind = useRef({ edited: false, history: false });
  const startedRef = useRef(started);
  startedRef.current = started;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const push = (it: Omit<Item, "id"> | Array<Omit<Item, "id">>) =>
    setItems((xs) => [...xs, ...(Array.isArray(it) ? it : [it]).map((x) => ({ ...x, id: nextId++ }) as Item)]);

  const loadSuggestions = async (repo: string, show: boolean) => {
    try {
      const r = await api<{ suggestions: string[] }>(creds.server, `/api/suggestions?repo=${encodeURIComponent(repo)}`, undefined, creds.token);
      setSuggestions(r.suggestions); setSIndex(0);
      if (show && r.suggestions.length) push({ kind: "suggest", title: `Try asking (${repo}) — Tab puts one in the prompt:`, list: r.suggestions });
    } catch { /* suggestions are a nicety */ }
  };

  const busyStart = (ph: string, act: string) => { setStatus("working"); setPhase(ph); setActivity(act); setStarted(Date.now()); };

  const submitPrompt = async (sid: string, raw: string) => {
    // files dragged into the prompt (the terminal pastes their paths) go along with the ones from /attach and Ctrl+V
    const { files, text } = extractFiles(raw);
    const local = [...pendingRef.current, ...files];
    setPending([]);
    turnKind.current = { edited: false, history: /\b(who|changed|commits?|merged?|push(ed)?|history|last week|yesterday)\b/i.test(text) };
    const names: string[] = [];
    if (local.length) {
      busyStart("Uploading", local.map((f) => f.split(/[\\/]/).pop()).join(", "));
      for (const f of local) {
        try { names.push(await client.upload(sid, f)); }
        catch (e) { push({ kind: "refused", text: `Couldn't attach ${f}: ${(e as Error).message}` }); }
      }
      if (names.length) push({ kind: "system", text: `📎 ${names.length} file${names.length === 1 ? "" : "s"} attached` });
    }
    busyStart("Checking your request", "intent gate · guardrails");
    client.send({ type: "prompt.submit", sessionId: sid, text, attachments: names });
  };

  useEffect(() => {
    const off = client.on((f: ServerFrame) => {
      switch (f.type) {
        case "hello":
          setRepos(f.repos);
          setStatus("idle");
          if (!welcomed.current) push({ kind: "welcome", name: f.name, modelId: f.modelId, admin: f.role === "admin", repos: f.repos });
          if (welcomed.current && !creds.lastSessionId) break;
          welcomed.current = true;
          if (creds.lastSessionId) client.send({ type: "session.resume", sessionId: creds.lastSessionId });
          else void loadSuggestions(f.repos.find((r) => r.includes("core-api")) ?? f.repos[0], true);
          break;
        case "session.opened": {
          setSession({ id: f.sessionId, repo: f.repo, branch: f.branch, target: f.target, also: f.also ?? [] });
          saveCreds({ ...creds, lastSessionId: f.sessionId });
          creds.lastSessionId = f.sessionId;
          if (f.sessionId !== sessionRef.current?.id) setSlots([]);
          push({ kind: "system", text: `${f.resumed ? "↺ Resumed" : "● Session"} ${f.sessionId.slice(0, 8)}` });
          const queued = pendingPrompt.current;
          pendingPrompt.current = null;
          if (queued) submitPrompt(f.sessionId, queued);
          else { setStatus("idle"); setPhase(""); setActivity(""); void loadSuggestions(f.repo, !f.resumed); }
          break;
        }
        case "gate.refused":
          setStatus("idle"); setPhase(""); setActivity("");
          push({ kind: "refused", text: f.reason });
          if (f.rule === "intent") {
            push({ kind: "system", text: "  Was that about the code? Type /appeal (add why if you like) — an admin reviews it and the gate learns." });
            setSuggestions(["/appeal ", ...suggestionsRef.current.filter((x) => x !== "/appeal ")]); setSIndex(0);
          }
          break;
        case "queue.position": setStatus("queued"); setPhase("Waiting for a free agent"); setActivity(`position ${f.position} in the queue`); break;
        case "turn.start": setStatus("working"); setPhase(""); setActivity("reading the spine and repo context"); break;
        case "turn.text": setActivity("writing the answer"); push({ kind: "agent", text: f.text }); break;
        case "turn.tool":
          if (/^(Edit|Write|MultiEdit)$/.test(f.name)) turnKind.current.edited = true;
          if (f.name === "Bash" && /^git (log|show)/.test(f.summary)) turnKind.current.history = true;
          setActivity(describe(f.name, f.summary));
          push({ kind: "tool", name: f.name, summary: f.summary });
          break;
        case "turn.tool_result": if (f.denied) push({ kind: "denied", text: f.text.replace(/^.*?TenAI policy:/s, "TenAI policy:").slice(0, 200) }); break;
        case "turn.done": {
          setStatus("idle"); setPhase(""); setActivity("");
          push({ kind: "done", tokens: f.tokens, cost: f.costUsd, secs: Math.round((Date.now() - startedRef.current) / 1000) });
          const k = turnKind.current;
          if (pendingTicket.current) {
            pendingTicket.current = null;
            setSuggestions(["Go ahead with the plan", "/review", "/contracts"]); setSIndex(0);
            push({ kind: "suggest", title: "Next — Tab to use:", list: ["Go ahead with the plan (answering any questions above first)", "/undo if you don't like a turn", "/review before /ship"] });
            break;
          }
          const next = k.edited
            ? ["/diff", "/ship <title for the merge request>", "Write a unit test for this change", "Explain the change in two lines for the MR description"]
            : k.history
              ? ["Show the full diff of the most recent one", "Who else touched these files recently?", "Is anything in these changes risky?"]
              : ["Show me exactly where that is in the code", "What would it take to change it?", "Who changed this last?"];
          // a command the agent told them to type ("`/branch feature/x feature/y`") is the first thing Tab offers
          const cmds = [...new Set([...f.text.matchAll(/(?:`|^[ \t]*)(\/(?:branch|repo|also|mine|branches) [^`\n]+)/gm)].map((m) => m[1].trim()))]
            .filter((c) => !/[<>]/.test(c)).slice(0, 3);
          setSuggestions([...cmds, ...next]); setSIndex(0);
          push({ kind: "suggest", title: "Next — Tab to use:", list: [...cmds, ...next].slice(0, 3) });
          break;
        }
        case "turn.error": setStatus("idle"); setPhase(""); setActivity(""); push({ kind: "refused", text: f.message === "cancelled" ? "Stopped." : `Agent error: ${f.message}` }); break;
        case "collision.warning": {
          const mr = f.with.filter((w) => w.email.startsWith("open MR"));
          const branches = f.with.filter((w) => w.email.includes("'s branch "));
          const people = f.with.filter((w) => !w.email.startsWith("open MR") && !w.email.includes("'s branch "));
          if (branches.length) push({ kind: "warn", text: `${f.paths.join(", ")} is also changed on ${branches.map((w) => w.email).join(", ")} (pushed in the last day)` });
          if (people.length) push({ kind: "warn", text: `${f.paths.join(", ")} is also being edited by ${people.map((w) => w.email).join(", ")}` });
          if (mr.length) push({ kind: "warn", text: `${f.paths.join(", ")} is also changed in ${mr.map((w) => w.email).join(", ")} — coordinate so the MRs don't conflict` });
          break;
        }
        case "hint": push({ kind: "system", text: f.text }); break;
        case "turn.prompt":
          if (f.email !== creds.email) { push({ kind: "peer", name: f.name, text: f.text }); turnKind.current = { edited: false, history: false }; setStarted(Date.now()); }
          break;
        case "session.invited":
          lastInvite.current = f.sessionId;
          push({ kind: "warn", text: f.handoff
            ? `🔁 ${f.from} handed you their session (${f.label}) — its changes and the agent's memory of it are yours now.${f.sessionId === sessionRef.current?.id ? "" : " /join to open it."}`
            : `🤝 ${f.from} invited you into their session (${f.label}). /join to work in it together.` });
          setSuggestions(["/join"]); setSIndex(0);
          break;
        case "diff": setStatus("idle"); push({ kind: "diff", files: f.files, patch: f.patch }); break;
        case "session.repos": {
          const before = slotsRef.current;
          setSlots(f.repos);
          // show the layout on open/resume, and any repo whose branch changed since
          const changed = f.repos.filter((r) => { const b = before.find((x) => x.repo === r.repo); return !b || b.target !== r.target || b.also.join() !== r.also.join(); });
          if (changed.length) push({ kind: "system", text: changed.map((r) => `  ${r.repo.padEnd(24)} ${r.target ? `⎇ ${r.target} — /ship pushes onto it${r.also.length ? `, copies to ${r.also.join(", ")}` : ""}` : "fresh branch — /ship opens a merge request"}`).join("\n") +
            (before.length ? "" : "\n  Ask for changes in any of them. /branch <repo>:<name> puts a repo on an existing branch (the agent can do it too).") });
          if (pendingSwitch.current) { pendingSwitch.current = false; setStatus("idle"); setPhase(""); setActivity(""); }
          break;
        }
        case "shipped": {
          setStatus("idle"); setPhase(""); setActivity("");
          const results = f.results ?? [{ repo: "", sha: f.sha, diffstat: f.diffstat, mrUrl: f.mrUrl, pushedTo: f.pushedTo, files: f.files, ports: f.ports }];
          for (const r of results) {
            const tag = r.repo ? `${r.repo}: ` : "";
            if (r.error) { push({ kind: "refused", text: `${tag}not shipped — ${r.error}` }); continue; }
            push({ kind: "shipped", text: r.pushedTo
              ? `${tag}pushed ${r.sha.slice(0, 8)} onto ${r.pushedTo} (${r.diffstat})${r.mrUrl ? " — its MR updates: " + r.mrUrl : ""}`
              : `${tag}shipped ${r.sha.slice(0, 8)} (${r.diffstat}) ${r.mrUrl ? "→ " + r.mrUrl : "— branch pushed"}` });
            for (const pt of r.ports ?? []) {
              push(pt.ok
                ? { kind: "shipped", text: pt.already ? `${tag}${pt.branch} already had this change — nothing to push` : `${tag}copied onto ${pt.branch} (${pt.sha?.slice(0, 8)})` }
                : { kind: "refused", text: `${tag}not copied to ${pt.branch}: ${pt.error}.` });
            }
          }
          break;
        }
        case "spine.event":
          // the spine replays history on connect; only show what is happening now
          if (f.actor !== creds.email && Date.now() - f.ts < 15 * 60_000) {
            const p = f.payload as any;
            const who = f.actor.split("@")[0];
            const line = f.kind === "claim" ? `${who} is editing ${(p.paths ?? []).join(", ")} in ${f.repo}`
              : f.kind === "mr.opened" ? `${who} opened an MR in ${f.repo}${p.mrUrl ? " " + p.mrUrl : ""}`
              : f.kind === "collision" ? `collision in ${f.repo}: ${(p.paths ?? []).join(", ")}`
              : `${who} ${f.kind.replace(".", " ")} ${f.repo ?? ""}`;
            setSpine((s) => [...s.slice(-2), line]);
          }
          break;
        case "notice": push({ kind: f.level === "info" ? "system" : "warn", text: f.text }); break;
        case "session.blocked": setStatus("idle"); setPhase(""); setActivity(""); push({ kind: "warn", text: `Blocked: ${f.reason}` }); break;
        case "error": pendingSwitch.current = false; setStatus((s) => (s === "connecting" ? s : "idle")); setPhase(""); setActivity(""); push({ kind: "refused", text: f.message }); break;
      }
    });
    client.onClose((reason) => { setStatus("connecting"); push({ kind: "warn", text: `Disconnected: ${reason}` }); });
    client.onReconnect(() => { push({ kind: "system", text: "✓ Reconnected" }); client.send({ type: "spine.subscribe", since: 0 }); });
    client.send({ type: "spine.subscribe", since: 0 });
    return off;
  }, []);

  const run = async (line: string) => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(" ");
    if (!cmd.startsWith("/")) {
      push({ kind: "you", text: line });
      if (!sessionRef.current) {
        const repo = guessRepo(line, repos);
        if (!repo) return push({ kind: "refused", text: "No repositories are configured on the server." });
        pendingPrompt.current = line;
        busyStart("Opening a session", `${repo} · creating your branch`);
        push({ kind: "system", text: "Opening a session with every repo checked out." });
        return client.send({ type: "session.open", repo });
      }
      return submitPrompt(sessionRef.current.id, line);
    }
    const s = sessionRef.current;
    switch (cmd) {
      case "/help": return push({ kind: "system", text: HELP });
      case "/quit": case "/exit": client.close(); return exit();
      case "/logout": clearCreds(); client.close(); return exit();
      case "/update":
        push({ kind: "system", text: "Quit and run:  openwallet update" });
        return;
      case "/suggest":
        return loadSuggestions(s?.repo ?? repos.find((r) => r.includes("core-api")) ?? repos[0], true);
      case "/who": {
        const rows = await api<any[]>(creds.server, "/api/who", undefined, creds.token);
        if (!rows.length) return push({ kind: "system", text: "Nobody else is connected right now." });
        return push({ kind: "suggest", title: `Working now (${rows.length}):`, list: rows.map((r) =>
          `${r.working ? "● " : "○ "}${r.name}${r.email === creds.email ? " (you)" : ""} · ${r.repo}${r.editing.length ? ` · editing ${r.editing.slice(0, 3).join(", ")}${r.editing.length > 3 ? "…" : ""}` : ""}${r.last_prompt ? ` · “${r.last_prompt.slice(0, 60)}”` : ""}`) });
      }
      case "/mrs": {
        const repo = s?.repo ?? repos.find((r) => r.includes("core-api")) ?? repos[0];
        const rows = await api<any[]>(creds.server, `/api/mrs?repo=${encodeURIComponent(repo)}`, undefined, creds.token);
        if (!rows.length) return push({ kind: "system", text: `No open merge requests in ${repo} (or GitLab isn't reachable yet).` });
        return push({ kind: "suggest", title: `Open MRs in ${repo} (${rows.length}):`, list: rows.slice(0, 15).map((m) =>
          `!${m.iid} ${m.draft ? "[draft] " : ""}${m.title.slice(0, 60)} — ${m.author} · ${m.fileCount} file${m.fileCount === 1 ? "" : "s"}`) });
      }
      case "/note": {
        const repo = s?.repo ?? repos.find((r) => r.includes("core-api")) ?? repos[0];
        const m = arg.match(/^@(\S+)\s+([\s\S]+)$/);
        const [path, text] = m ? [m[1], m[2]] : ["", arg];
        if (!text.trim()) return push({ kind: "refused", text: "Usage: /note <text>   or   /note @path/to/dir <text>" });
        try {
          const n = await api<{ id: number; path: string }>(creds.server, "/api/notes", { repo, path, text }, creds.token);
          return push({ kind: "system", text: `📌 Note #${n.id} pinned on ${repo}${n.path ? "/" + n.path : ""} — every agent in this repo now sees it.` });
        } catch (e) { return push({ kind: "refused", text: (e as Error).message }); }
      }
      case "/notes": {
        const repo = s?.repo ?? repos.find((r) => r.includes("core-api")) ?? repos[0];
        const rows = await api<any[]>(creds.server, `/api/notes?repo=${encodeURIComponent(repo)}`, undefined, creds.token);
        if (!rows.length) return push({ kind: "system", text: `No notes on ${repo}. Add one with /note.` });
        return push({ kind: "suggest", title: `Team notes · ${repo}:`, list: rows.map((n) => `#${n.id} ${n.path ? `[${n.path}] ` : ""}${n.text} — ${n.email.split("@")[0]}`) });
      }
      case "/unnote": {
        const r = await api<{ ok: boolean; error?: string }>(creds.server, `/api/notes/${Number(arg)}/remove`, {}, creds.token);
        return push(r.ok ? { kind: "system", text: `Note #${arg} removed.` } : { kind: "refused", text: r.error ?? "Could not remove it." });
      }
      case "/appeal": {
        if (!s) return push({ kind: "refused", text: "Nothing to appeal yet." });
        try {
          const r = await api<{ ok: boolean; error?: string }>(creds.server, "/api/appeal", { sessionId: s.id, note: arg }, creds.token);
          if (r.ok) { setSuggestions((xs) => xs.filter((x) => x !== "/appeal ")); setSIndex(0); }
          return push(r.ok ? { kind: "system", text: "✓ Appeal sent. An admin will label it and the next gate version learns from it. Meanwhile, naming the repo, file or feature usually gets through." }
            : { kind: "refused", text: r.error ?? "Appeal failed." });
        } catch (e) { return push({ kind: "refused", text: (e as Error).message }); }
      }
      case "/repo":
        if (!arg || !repos.includes(arg)) return push({ kind: "suggest", title: "Repositories — /repo <name>:", list: repos });
        if (s && slotsRef.current.some((r) => r.repo === arg)) return push({ kind: "system", text: `${arg} is already in this session (every repo is). Ask away, or /branch ${arg}:<name> to put it on an existing branch.` });
        busyStart("Opening a session", `${arg} · creating your branch`);
        return client.send({ type: "session.open", repo: arg });
      case "/branches": {
        const repo = s?.repo ?? repos.find((r) => r.includes("core-api")) ?? repos[0];
        const rows = await api<Array<{ name: string; protected: boolean; mr: number | null }>>(creds.server, `/api/branches?repo=${encodeURIComponent(repo)}&q=${encodeURIComponent(arg)}`, undefined, creds.token);
        if (!rows.length) return push({ kind: "system", text: `No branches in ${repo} match “${arg}”.` });
        return push({ kind: "suggest", title: `Branches in ${repo}${arg ? ` matching “${arg}”` : ""} — /branch <name> to work on one:`,
          list: rows.slice(0, 25).map((b) => `${b.name}${b.mr ? `  (MR !${b.mr})` : ""}${b.protected ? "  🔒 protected — via MR only" : ""}`) });
      }
      case "/branch": {
        if (!arg) return push({ kind: "refused", text: "Which branch? /mine or /branches <word> to search, then /branch <name> [more branches]." });
        // "<repo>:<branch>" picks the repo too (git branch names can't contain ":")
        let [first, ...more] = rest;
        let repo = s?.repo ?? repos.find((r) => r.includes("core-api")) ?? repos[0];
        if (first.includes(":")) { [repo, first] = [first.slice(0, first.indexOf(":")), first.slice(first.indexOf(":") + 1)]; }
        if (!repos.includes(repo)) return push({ kind: "refused", text: `Unknown repo ${repo}. /repo lists them.` });
        more = more.map((b) => b.replace(/^[^:]+:/, ""));
        busyStart("Switching branch", `${repo} · fetching ${first}${more.length ? ` (+${more.length} more)` : ""}`);
        // a session spanning repos switches that repo in place; otherwise (none yet, or an older one) open one
        if (s && slotsRef.current.length > 1) { pendingSwitch.current = true; return client.send({ type: "session.use", sessionId: s.id, repo, branch: first, also: more }); }
        return client.send({ type: "session.open", repo, branch: first, also: more });
      }
      case "/fresh": {
        if (!s || slotsRef.current.length < 2) return push({ kind: "refused", text: "Start a session first." });
        const repo = arg || s.repo;
        if (!repos.includes(repo)) return push({ kind: "refused", text: `Unknown repo ${repo}.` });
        busyStart("Switching branch", `${repo} · fresh branch from its base`);
        pendingSwitch.current = true;
        return client.send({ type: "session.use", sessionId: s.id, repo, branch: null, also: [] });
      }
      case "/check": {
        if (!s) return push({ kind: "refused", text: "Start a session first." });
        busyStart("Compiling", arg ? `${arg} · type-check / compile` : "every repo you changed");
        try {
          const rows = await api<Array<{ repo: string; ok: boolean; command: string; seconds: number; output: string }>>(creds.server, "/api/check", { sessionId: s.id, repo: arg || undefined }, creds.token);
          setStatus("idle"); setPhase(""); setActivity("");
          for (const r of rows) push(r.ok ? { kind: "shipped", text: `${r.repo}: ✓ ${r.output.split("\n")[0]} (${r.seconds}s)` } : { kind: "refused", text: `${r.repo}: ✗ ${r.command} (${r.seconds}s)\n${r.output}` });
        } catch (e) { setStatus("idle"); setPhase(""); setActivity(""); push({ kind: "refused", text: (e as Error).message }); }
        return;
      }
      case "/status": {
        if (!slotsRef.current.length) return push({ kind: "system", text: s ? `${s.repo} ⎇ ${s.target ?? s.branch}` : "No session." });
        return push({ kind: "system", text: slotsRef.current.map((r) => `  ${r.repo.padEnd(24)} ${r.target ? `⎇ ${r.target} (pushes here)${r.also.length ? ` + copies to ${r.also.join(", ")}` : ""}` : `fresh ${r.branch} (merge request)`}`).join("\n") });
      }
      case "/also": {
        if (!s) return push({ kind: "refused", text: "Start a session first (/branch <name> or /repo <name>)." });
        if (!arg) return push({ kind: "system", text: s.also?.length ? `/ship also copies onto: ${s.also.join(", ")}  (/also none clears)` : "No extra branches. /also <branch> [more] adds them." });
        return client.send({ type: "session.also", sessionId: s.id, branches: arg === "none" ? [] : rest.map((b) => b.replace(/^[^:]+:/, "")) });
      }
      case "/mine": {
        push({ kind: "system", text: "Looking through every repo for your unmerged branches…" });
        const rows = await api<Array<{ repo: string; name: string; updated: string; ahead: number; commits: Array<{ subject: string }>; fileCount: number; related: string[]; mr: number | null }>>(
          creds.server, `/api/mine?q=${encodeURIComponent(arg)}`, undefined, creds.token);
        if (!rows.length) return push({ kind: "system", text: arg ? `None of your unmerged branches match “${arg}”. Try /mine with no word.` : "No unmerged branches with your commits in the last 120 days." });
        const seen = new Set<string>();
        const list: string[] = [];
        for (const b of rows.slice(0, 12)) {
          if (seen.has(b.repo + b.name)) continue;
          // copies among your own matching branches go in the same /branch command (the server takes up to 5 extra)
          const group = [b.name, ...b.related.filter((r) => rows.some((x) => x.repo === b.repo && x.name === r))].slice(0, 4);
          group.forEach((g) => seen.add(b.repo + g));
          list.push(`${b.repo} · ${b.name} · ${b.updated} · ${b.commits.length} commit${b.commits.length === 1 ? "" : "s"} by you · ${b.fileCount} files${b.mr ? ` · MR !${b.mr}` : ""}\n` +
            `      ${b.commits.slice(0, 2).map((c) => c.subject.slice(0, 70)).join(" | ")}\n` +
            (b.related.length ? `      copies of its commits also on: ${b.related.slice(0, 3).join(", ")}${b.related.length > 3 ? ` +${b.related.length - 3} more` : ""}\n` : "") +
            `      → /branch ${b.repo}:${group.join(" ")}`);
        }
        const firstCmd = list[0].split("→ ")[1];
        setSuggestions([firstCmd]); setSIndex(0);
        return push({ kind: "suggest", title: `Your unmerged work${arg ? ` matching “${arg}”` : ""} — copy a → line (Tab fills the first):`, list });
      }
      case "/new":
        if (!s) return push({ kind: "refused", text: "Use /repo <name> first." });
        busyStart("Opening a session", `${s.repo} · creating a fresh branch`);
        return client.send({ type: "session.open", repo: s.repo, title: arg || undefined });
      case "/resume": return client.send({ type: "session.resume", sessionId: arg });
      case "/sessions": {
        const list = await api<Array<{ id: string; repo: string; branch: string; owner: string | null }>>(creds.server, "/api/sessions", undefined, creds.token);
        return push({ kind: "system", text: list.map((x) => `${x.id.slice(0, 8)}…  ${x.repo}  ${x.branch}${x.owner ? `  (shared by ${x.owner.split("@")[0]})` : ""}   (/resume ${x.id})`).join("\n") || "No open sessions." });
      }
      case "/invite":
        if (!s) return push({ kind: "refused", text: "Start a session first." });
        if (!arg) return push({ kind: "refused", text: "Who? /invite alex (name, email name or email)." });
        return client.send({ type: "session.invite", sessionId: s.id, who: arg });
      case "/handoff":
        if (!s) return push({ kind: "refused", text: "No session to hand over." });
        if (!arg) return push({ kind: "refused", text: "To whom? /handoff alex" });
        return client.send({ type: "session.handoff", sessionId: s.id, who: arg });
      case "/join": {
        let id = arg || lastInvite.current || "";
        if (id && id.length < 36) {
          const list = await api<Array<{ id: string }>>(creds.server, "/api/sessions", undefined, creds.token);
          id = list.find((x) => x.id.startsWith(id))?.id ?? id;
        }
        if (!id) return push({ kind: "refused", text: "No invite yet. /sessions lists the sessions shared with you." });
        busyStart("Joining", "opening the shared session");
        return client.send({ type: "session.resume", sessionId: id });
      }
      case "/members": {
        if (!s) return push({ kind: "refused", text: "No session yet." });
        const m = await api<{ owner: { email: string; name: string }; members: Array<{ email: string; name: string }> }>(creds.server, `/api/members?sessionId=${s.id}`, undefined, creds.token);
        return push({ kind: "system", text: `Owner: ${m.owner.name}${m.owner.email === creds.email ? " (you)" : ""}\n` + (m.members.length ? m.members.map((x) => `  · ${x.name}${x.email === creds.email ? " (you)" : ""}`).join("\n") : "  nobody else yet — /invite <name>") });
      }
      case "/leave":
        if (!s) return;
        client.send({ type: "session.leave", sessionId: s.id });
        saveCreds({ ...creds, lastSessionId: undefined });
        creds.lastSessionId = undefined;
        setSession(null); setSlots([]);
        return;
      case "/cancel": return s && client.send({ type: "turn.cancel", sessionId: s.id });
      case "/diff": return s ? client.send({ type: "diff.request", sessionId: s.id }) : push({ kind: "refused", text: "No session yet." });
      case "/ship": {
        if (!s) return push({ kind: "refused", text: "No session yet." });
        const force = /^--force\b/.test(arg);
        const title = arg.replace(/^--force\s*/, "");
        if (title.length < 3 || title.startsWith("<")) return push({ kind: "refused", text: "Give the merge request a title: /ship <title>" });
        busyStart("Shipping", force ? "contracts check skipped (--force) · pushing" : "checking cross-repo contracts · squashing · pushing");
        return client.send({ type: "ship", sessionId: s.id, title, description: "", force });
      }
      case "/ticket": {
        const key = ticketKey(rest[0] ?? "");
        if (!key) return push({ kind: "refused", text: "Which ticket? /ticket P1S-1311 (or paste the Jira link)." });
        const jira = loadJira();
        if (!jira) return push({ kind: "refused", text: "Connect Jira once: quit (Ctrl+C), run `openwallet jira`, paste your Atlassian API token (id.atlassian.com → Security → API tokens). It stays on this computer." });
        busyStart("Reading Jira", `${key} · ticket, comments, screenshots`);
        try {
          const t = await fetchTicket(jira, key);
          const files = await downloadAttachments(jira, t);
          setStatus("idle"); setPhase(""); setActivity("");
          push({ kind: "system", text: `🎫 ${t.key} · ${t.summary}\n   ${t.type} · ${t.status} · ${t.priority} · assignee ${t.assignee}${files.length ? ` · ${files.length} attachment${files.length === 1 ? "" : "s"}` : ""}\n   ${t.url}` });
          setPending((p) => [...p, ...files]);
          pendingRef.current = [...pendingRef.current, ...files];
          // a fresh session per ticket: its branches are named after the ticket and the MRs link back to it
          const repo = guessRepo(`${t.summary} ${t.description}`, repos) ?? repos[0];
          pendingPrompt.current = ticketPrompt(t, rest.slice(1).join(" "), files.length);
          pendingTicket.current = t.key;
          busyStart("Opening a session", `every repo · branches named ${t.key}`);
          return client.send({ type: "session.open", repo, title: `${t.key} ${t.summary}`.slice(0, 110), ticket: { key: t.key, url: t.url, summary: t.summary.slice(0, 290) } });
        } catch (e) { setStatus("idle"); setPhase(""); setActivity(""); return push({ kind: "refused", text: (e as Error).message }); }
      }
      case "/undo": {
        if (!s) return push({ kind: "refused", text: "No session yet." });
        try {
          const r = await api<{ label: string | null; repos: Array<{ repo: string; files: string[] }> }>(creds.server, "/api/undo", { sessionId: s.id, repo: arg || undefined }, creds.token);
          if (!r.label) return push({ kind: "system", text: "Nothing to undo." });
          return push({ kind: "system", text: `↶ Back to before “${r.label}”\n` + r.repos.map((x) => `   ${x.repo}: ${x.files.slice(0, 6).join(", ")}${x.files.length > 6 ? ` +${x.files.length - 6}` : ""}`).join("\n") + "\n   (/undo again goes further back · nothing pushed was touched)" });
        } catch (e) { return push({ kind: "refused", text: (e as Error).message }); }
      }
      case "/contracts": {
        if (!s) return push({ kind: "refused", text: "No session yet." });
        const found = await api<Array<{ kind: string; name: string; repo: string; file: string; uses: Array<{ repo: string; file: string; line: number; text: string }> }>>(creds.server, `/api/contracts?sessionId=${s.id}`, undefined, creds.token);
        if (!found.length) return push({ kind: "system", text: "✓ No backend field or endpoint was removed or renamed in this session." });
        const broken = found.filter((f) => f.uses.length);
        return push({ kind: broken.length ? "warn" : "system", text: (broken.length ? `${broken.length} change${broken.length === 1 ? "" : "s"} would break other repos:\n` : "Removed or renamed, and nothing else uses them:\n") +
          found.map((f) => `  ${f.kind} “${f.name}” (${f.repo}/${f.file.split("/").pop()})${f.uses.length ? "\n" + f.uses.slice(0, 5).map((u) => `      ↳ ${u.repo}/${u.file}:${u.line}  ${u.text.slice(0, 80)}`).join("\n") : "  — not used elsewhere"}`).join("\n") });
      }
      case "/review": {
        if (!s) return push({ kind: "refused", text: "No session yet." });
        const hunks = await api<HunkView[]>(creds.server, `/api/hunks?sessionId=${s.id}`, undefined, creds.token);
        if (!hunks.length) return push({ kind: "system", text: "No changes to review." });
        push({ kind: "system", text: `Reviewing ${hunks.length} change${hunks.length === 1 ? "" : "s"} — y keep · n drop · e ask about it · q stop` });
        return setReview({ hunks, i: 0, kept: 0, dropped: 0, busy: false });
      }
      case "/attach": {
        const f = localFile(arg.replace(/^['"]|['"]$/g, "").replace(/\\ /g, " "));
        if (!f) return push({ kind: "refused", text: `Can't attach “${arg}”: no such file, or bigger than 10 MB.` });
        setPending((p) => [...p, f]);
        return push({ kind: "system", text: `📎 ${f.split(/[\\/]/).pop()} will go with your next prompt.` });
      }
      case "/end":
        if (!s) return;
        client.send({ type: "session.end", sessionId: s.id });
        saveCreds({ ...creds, lastSessionId: undefined });
        setSession(null);
        return push({ kind: "system", text: "Session ended." });
      default: return push({ kind: "refused", text: `Unknown command ${cmd}. Type / for the menu.` });
    }
  };

  // the repo branch completion is for: "/branch <repo>:…" names it, otherwise the session's
  const completionRepo = input.match(/^\/branch\s+([^:\s]+):/)?.[1] ?? session?.repo ?? repos.find((r) => r.includes("core-api")) ?? repos[0];
  // ---- "/" menu: commands, then repo names after "/repo " ----
  const menu = useMemo((): Array<{ label: string; desc: string; complete: string; runNow: boolean }> => {
    if (!input.startsWith("/")) return [];
    const m = input.match(/^\/repo\s+(.*)$/);
    if (m) return repos.filter((r) => r.startsWith(m[1])).map((r) => ({ label: r, desc: r === session?.repo ? "current" : "", complete: `/repo ${r}`, runNow: true }));
    const b = input.match(/^(\/(?:branch|also)\s+(?:\S+\s+)*)(\S*)$/);
    // after a finished name + space, Enter runs what was typed (no menu hijacking it)
    if (b && branchList?.repo === completionRepo && (b[2] || /^\/\w+\s+$/.test(b[1]))) {
      const colon = b[2].indexOf(":"); // "/branch core-api:feat…" completes the part after the repo
      if (colon >= 0) { b[1] += b[2].slice(0, colon + 1); b[2] = b[2].slice(colon + 1); }
      const q = b[2].toLowerCase();
      return branchList.names.filter((x) => !x.protected && x.name.toLowerCase().includes(q))
        .sort((x, y) => Number(y.name.toLowerCase() === q) - Number(x.name.toLowerCase() === q)).slice(0, 9)
        .map((x) => ({ label: x.name, desc: x.mr ? `MR !${x.mr}` : "", complete: `${b[1]}${x.name}`, runNow: true }));
    }
    if (/\s/.test(input)) return [];
    return COMMANDS.filter((c) => c.name.startsWith(input)).map((c) => ({
      label: c.name + (c.args ? " " + c.args : ""), desc: c.desc + (c.needsSession && !session ? "  (needs a session)" : ""),
      complete: c.name + (c.args ? " " : ""), runNow: !c.args,
    }));
  }, [input, repos, session, branchList, completionRepo]);
  useEffect(() => setMenuIndex(0), [input]);
  // first time someone types "/branch ", fetch the repo's branch list for live completion
  useEffect(() => {
    if (!/^\/(branch|also)\s/.test(input)) return;
    const repo = completionRepo;
    if (!repo || branchList?.repo === repo) return;
    api<Array<{ name: string; protected: boolean; mr: number | null }>>(creds.server, `/api/branches?repo=${encodeURIComponent(repo)}`, undefined, creds.token)
      .then((names) => setBranchList({ repo, names })).catch(() => undefined);
  }, [input]);

  const submit = (line: string) => {
    // stray control characters (terminal escape leftovers) must not turn "/branch x" into a prompt for the agent
    const l = line.replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (!l) return;
    setHistory((h) => [...h, l]); setHIndex(-1);
    void run(l);
  };

  useInput((ch, key) => {
    const busy = status === "working" || status === "queued";
    const rv = reviewRef.current;
    if (rv) {
      const h = rv.hunks[rv.i];
      const finish = (r: NonNullable<typeof rv>) => {
        setReview(null);
        push({ kind: "system", text: `Review done: kept ${r.kept}, dropped ${r.dropped}${r.dropped ? " (/undo brings dropped ones back)" : ""}.` });
      };
      if (rv.busy) return;
      if (key.escape || ch === "q") return finish(rv);
      if (ch === "y" || key.return) {
        const next = { ...rv, i: rv.i + 1, kept: rv.kept + 1 };
        return next.i >= next.hunks.length ? finish(next) : setReview(next);
      }
      if (ch === "n" && h && sessionRef.current) {
        setReview({ ...rv, busy: true });
        api<HunkView[]>(creds.server, "/api/hunks/drop", { sessionId: sessionRef.current.id, repo: h.repo, id: h.id }, creds.token)
          .then((fresh) => {
            // the dropped change is gone from the fresh list, so the same position now holds the next one
            const next = { hunks: fresh, i: rv.i, kept: rv.kept, dropped: rv.dropped + 1, busy: false };
            if (next.i >= fresh.length) finish(next); else setReview(next);
          })
          .catch((e) => { setReview({ ...rv, busy: false }); push({ kind: "refused", text: (e as Error).message }); });
        return;
      }
      if (ch === "e" && h) {
        finish(rv);
        setInput(`Explain this change in ${h.repo}/${h.file} (${h.header}) and why it's needed: `);
        return;
      }
      return;
    }
    if (key.ctrl && ch === "c") {
      if (busy && sessionRef.current) { client.send({ type: "turn.cancel", sessionId: sessionRef.current.id }); return; }
      client.close();
      return exit();
    }
    if (key.escape) {
      if (busy && sessionRef.current) client.send({ type: "turn.cancel", sessionId: sessionRef.current.id });
      else setInput("");
      return;
    }
    if (menu.length) {
      if (key.upArrow) return setMenuIndex((i) => (i - 1 + menu.length) % menu.length);
      if (key.downArrow) return setMenuIndex((i) => (i + 1) % menu.length);
      const pick = menu[Math.min(menuIndex, menu.length - 1)];
      if (key.tab) return setInput(pick.complete);
      if (key.return) {
        if (pick.runNow) { setInput(""); return submit(pick.complete); }
        if (input.trim() !== pick.complete.trim()) return setInput(pick.complete);
      }
    }
    if (key.tab) {
      if (!input && suggestions.length) { setInput(suggestions[sIndex % suggestions.length]); setSIndex((i) => i + 1); }
      return;
    }
    if (key.upArrow) { const i = hIndex < 0 ? history.length - 1 : Math.max(0, hIndex - 1); if (history[i] !== undefined) { setHIndex(i); setInput(history[i]); } return; }
    if (key.downArrow) { const i = hIndex + 1; if (i >= history.length) { setHIndex(-1); setInput(""); } else { setHIndex(i); setInput(history[i]); } return; }
    if (key.backspace || key.delete) return setInput((s) => s.slice(0, -1));
    if (key.ctrl && ch === "v") {
      const img = clipboardImage();
      if (!img) return push({ kind: "refused", text: "No image on the clipboard. Copy a screenshot first, drag the file into the terminal, or use /attach <path>." });
      setPending((p) => [...p, img]);
      return push({ kind: "system", text: "📎 Screenshot pasted — it goes with your next prompt." });
    }
    if (key.ctrl || key.meta) return;
    // A chunk can carry several keys at once (fast typing, paste): "fix it⏎" must type then submit.
    const chunk = key.return ? "\r" : ch;
    let buffer = input;
    for (const c of chunk) {
      if (c === "\r" || c === "\n") { const l = buffer; buffer = ""; submit(l); }
      else buffer += c;
    }
    setInput(buffer);
  });

  const badge = ({ connecting: [C.muted, "● connecting"], idle: [C.green, "● ready"], working: [C.orange, "● working"], queued: [C.amber, "● queued"] } as const)[status];
  const busy = status === "working" || status === "queued";
  const ghost = !input && !busy && suggestions.length ? suggestions[sIndex % suggestions.length] : "";

  return (
    <Box flexDirection="column">
      <Static items={items}>{(it) => <Row key={it.id} item={it} />}</Static>
      {busy && <Loader phase={phase} activity={activity} started={started} />}
      {spine.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {spine.map((s, i) => <Text key={i} color={C.violet}>◆ {s}</Text>)}
        </Box>
      )}
      {review && review.hunks[review.i] && (() => {
        const h = review.hunks[review.i];
        const body = h.lines.slice(0, 36);
        return (
          <Box flexDirection="column" borderStyle="round" borderColor={C.teal} paddingX={1} marginTop={1}>
            <Text><Text color={C.teal} bold>Change {review.i + 1}/{review.hunks.length}</Text><Text color={C.ink}>  {h.repo}/{h.file}</Text>
              <Text color={C.dim}>  {h.newFile ? "new file · " : ""}<Text color={C.green}>+{h.adds}</Text> <Text color={C.red}>−{h.dels}</Text>  {h.header}</Text></Text>
            {body.map((l, i) => <Text key={i} color={l.startsWith("+") ? C.green : l.startsWith("-") ? C.red : C.muted}>{l.slice(0, 160) || " "}</Text>)}
            {h.lines.length > body.length && <Text color={C.dim}>… {h.lines.length - body.length} more lines</Text>}
            <Text color={C.dim}>{review.busy ? "dropping…" : <><Text color={C.green} bold>y</Text> keep   <Text color={C.red} bold>n</Text> drop   <Text color={C.amber} bold>e</Text> ask about it   <Text bold>q</Text> stop   · kept {review.kept} · dropped {review.dropped}</>}</Text>
          </Box>
        );
      })()}
      {!review && <Box borderStyle="round" borderColor={busy ? C.dim : C.orange} paddingX={1} marginTop={1}>
        <Text color={C.orange} bold>› </Text>
        {input ? <Text color={C.ink}>{input}<Text color={C.orange}>▌</Text></Text>
          : <Text color={C.dim}>{ghost ? `Try "${ghost}"  ⇥ Tab` : busy ? "Esc to stop…" : "Ask about the code, its history, or a change…  (/ for commands)"}</Text>}
      </Box>}
      {menu.length > 0 ? (
        <Box flexDirection="column" paddingX={2}>
          {menu.slice(0, 9).map((m, i) => (
            <Text key={m.label}>
              <Text color={i === menuIndex ? C.orange : C.muted} bold={i === menuIndex}>{i === menuIndex ? "❯ " : "  "}{m.label.padEnd(22)}</Text>
              <Text color={i === menuIndex ? C.ink : C.dim}>{m.desc}</Text>
            </Text>
          ))}
        </Box>
      ) : (
        <Box paddingX={2} justifyContent="space-between">
          <Text color={C.dim}>
            {creds.name} · {session ? <Text color={C.teal}>{slots.length > 1
                ? slots.map((r) => r.target ? `${r.repo.replace(/-global$/, "")} ⎇ ${r.target}${r.also.length ? ` +${r.also.length}` : ""}` : null).filter(Boolean).join(" · ") || `${slots.length} repos · fresh branches`
                : <>{session.repo} ⎇ {session.target ? `${session.target} (pushes here)` : session.branch}{session.also?.length ? ` +${session.also.length} more` : ""}</>}</Text> : "no session — just start typing"}
            {pendingAttachments.length ? `  ·  📎 ${pendingAttachments.map((f) => f.split(/[\\/]/).pop()).join(", ")}` : ""}
          </Text>
          <Text color={badge[0]}>{badge[1]}</Text>
        </Box>
      )}
    </Box>
  );
}

async function login(server: string): Promise<Creds> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(paint.dim("  Sign in with your @example.com email. We'll send you a 6-digit code.\n"));
    let email = "";
    for (;;) {
      email = (await rl.question(paint.rgb(0.4, "  › ") + "OpenWallet email: ")).trim().toLowerCase();
      try { await api(server, "/auth/otp/request", { email }); break; }
      catch (e) { console.log(paint.rgb(1, `  ${(e as Error).message}`)); }
    }
    for (let tries = 0; ; tries++) {
      const code = (await rl.question(paint.rgb(0.4, "  › ") + `Code sent to ${email}: `)).trim();
      try {
        const r = await api<Omit<Creds, "server">>(server, "/auth/otp/verify", { email, code });
        const creds = { server, ...r };
        saveCreds(creds);
        console.log(paint.rgb(0.2, `\n  ✓ Signed in as ${r.name}`) + paint.dim(` · your agent is ${r.modelId}\n`));
        return creds;
      } catch (e) {
        console.log(paint.rgb(1, `  ${(e as Error).message}`));
        if (tries >= 4) throw new Error("Too many wrong codes. Run openwallet again to get a new one.");
      }
    }
  } finally {
    rl.close();
  }
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
  } else if (cmd === "update") {
    const server = loadCreds()?.server ?? DEFAULT_SERVER;
    console.log(paint.dim(`  Updating the OpenWallet Terminal from ${server}…\n`));
    const p = Bun.spawn(["bash", "-c", `set -o pipefail; curl -fsSL '${server.replace(/'/g, "")}/install' | bash`], { stdio: ["inherit", "inherit", "inherit"] });
    process.exit(await p.exited);
  } else if (cmd === "jira") {
    // one-time: your own Atlassian API token, kept on this computer only (~/.openwallet/jira.json, 0600)
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const email = (await rl.question(`  Atlassian email [${loadCreds()?.email ?? ""}]: `)).trim() || loadCreds()?.email || "";
    process.stdout.write("  API token (from id.atlassian.com → Security → API tokens; not shown): ");
    const token = await new Promise<string>((resolve) => {
      // read without echo
      let buf = "";
      process.stdin.setRawMode?.(true);
      const on = (d: Buffer) => {
        for (const ch of d.toString()) {
          if (ch === "\r" || ch === "\n") { process.stdin.setRawMode?.(false); process.stdin.off("data", on); process.stdout.write("\n"); return resolve(buf.trim()); }
          if (ch === "\u0003") process.exit(1);
          if (ch === "\u007f") buf = buf.slice(0, -1); else buf += ch;
        }
      };
      rl.pause();
      process.stdin.on("data", on);
      process.stdin.resume();
    });
    rl.close();
    const c = { base: process.env.JIRA_URL || JIRA_DEFAULT, email, token };
    try {
      const who = await whoAmI(c);
      saveJira(c);
      console.log(`  ✓ Jira connected as ${who}. In the terminal: /ticket P1S-1311`);
    } catch (e) { console.log(`  ✗ ${(e as Error).message}`); process.exit(1); }
    process.exit(0);
  } else if (cmd === "logout") {
    clearCreds();
    console.log("Signed out.");
  } else {
    const server = cmd === "login" && args[0] ? args[0] : loadCreds()?.server ?? DEFAULT_SERVER;
    console.log(banner(VERSION, server));
    await updateNotice(server);
    let creds = cmd === "login" ? null : loadCreds();
    if (!creds) creds = await login(server);
    const client = new TenaiClient(creds);
    await client.connect();
    render(<App creds={creds} client={client} />, { exitOnCtrlC: false });
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
