/**
 * AMP/1 — TypeScript port of ~/amp/app/protocol.py. Signatures are byte-identical with the Python hub:
 * canonical JSON = sorted keys, "," / ":" separators, non-ASCII escaped as \uXXXX (Python's
 * ensure_ascii default). Keep bodies free of floats: Python prints 1.0 where JS prints 1.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const VERSION = "1";
export type AmpType = "REQUEST" | "RESPONSE" | "EVENT" | "ACK" | "ERROR";
export const TYPES: ReadonlySet<AmpType> = new Set(["REQUEST", "RESPONSE", "EVENT", "ACK", "ERROR"]);

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface Envelope {
  amp: string;
  id: string;
  thread: string;
  ts: string;
  from: string;
  to: string;
  type: AmpType;
  intent: string;
  body: { text?: string; [k: string]: Json | undefined };
  sig?: string;
  token?: string;
}

const SIGNED_KEYS = ["amp", "id", "thread", "ts", "from", "to", "type", "intent", "body"] as const;

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function newId(prefix = "msg"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

/** Python json.dumps(ensure_ascii=True) string escaping. */
function pyString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (code < 0x20 || code > 0x7e) {
      // Python escapes per UTF-16 unit, so astral characters become a surrogate pair.
      for (let i = 0; i < ch.length; i++) out += "\\u" + ch.charCodeAt(i).toString(16).padStart(4, "0");
    } else out += ch;
  }
  return out + '"';
}

function pyDump(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("AMP bodies cannot carry NaN/Infinity");
    return String(v);
  }
  if (typeof v === "string") return pyString(v);
  if (Array.isArray(v)) return "[" + v.map(pyDump).join(",") + "]";
  if (typeof v === "object") {
    // undefined members are dropped, as JSON.stringify drops them on the wire (else "/new" with no title never verifies)
    const keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
    return "{" + keys.map((k) => pyString(k) + ":" + pyDump((v as Record<string, unknown>)[k])).join(",") + "}";
  }
  return pyString(String(v));
}

/** Deterministic string over the signed fields (everything except token+sig). */
export function canonical(env: Partial<Envelope>): string {
  const picked: Record<string, unknown> = {};
  for (const k of SIGNED_KEYS) picked[k] = (env as Record<string, unknown>)[k] ?? null;
  return pyDump(picked);
}

export function sign(env: Partial<Envelope>, secret: string): string {
  return createHmac("sha256", secret).update(canonical(env), "utf8").digest("hex");
}

export function verify(env: Partial<Envelope>, secret: string): boolean {
  const expected = Buffer.from(sign(env, secret), "hex");
  const given = Buffer.from(env.sig ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function make(
  from: string, to: string, intent: string, body: Envelope["body"] | string, secret: string,
  opts: { type?: AmpType; thread?: string; token?: string } = {},
): Envelope {
  const env: Envelope = {
    amp: VERSION, id: newId(), thread: opts.thread ?? newId("thr"), ts: nowIso(),
    from, to, type: opts.type ?? "REQUEST", intent,
    body: typeof body === "string" ? { text: body } : body,
  };
  env.sig = sign(env, secret);
  if (opts.token) env.token = opts.token;
  return env;
}

export function toPrompt(env: Envelope): string {
  const b = env.body ?? {};
  const hints = Object.entries(b).filter(([k]) => k !== "text").map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
  const head = `⟦AMP/1 ${env.type} ${env.intent}⟧\nid: ${env.id}   thread: ${env.thread}   from: ${env.from} → ${env.to}   ts: ${env.ts}\nsig: ${(env.sig ?? "").slice(0, 8)}…`;
  return head + (hints ? "\n" + hints : "") + "\n---\n" + String(b.text ?? "") + "\n⟦/AMP⟧";
}

const FENCE = /⟦AMP\/1\s+(\w+)\s+([\w.]+)⟧([\s\S]*?)⟦\/AMP⟧/g;

/** Extract AMP messages an agent embedded in free text (lossy: header + body text). */
export function parsePrompt(text: string): Array<{ type: string; intent: string; body: { text: string } }> {
  const out: Array<{ type: string; intent: string; body: { text: string } }> = [];
  for (const m of text.matchAll(FENCE)) {
    const inner = m[3];
    const bodyText = inner.includes("---") ? inner.split("---").slice(1).join("---").trim() : inner.trim();
    out.push({ type: m[1], intent: m[2], body: { text: bodyText } });
  }
  return out;
}
