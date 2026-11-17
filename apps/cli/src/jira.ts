/**
 * Jira, read from the engineer's own machine with their own Atlassian API token: the ticket text and its screenshots
 * go to the agent like anything they would paste, and the token never reaches the TenAI server.
 * Set up once with `openwallet jira` (saved in ~/.openwallet/jira.json, readable only by you) or JIRA_EMAIL + JIRA_API_TOKEN.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".openwallet");
const FILE = join(DIR, "jira.json");
export const JIRA_DEFAULT = "https://your-org.atlassian.net";

export interface JiraCreds { base: string; email: string; token: string }
export interface JiraTicket {
  key: string; url: string; summary: string; type: string; status: string; priority: string;
  assignee: string; reporter: string; labels: string[]; parent: string | null;
  description: string; comments: Array<{ author: string; at: string; text: string }>;
  attachments: Array<{ id: string; filename: string; mimeType: string; size: number; content: string }>;
}

export function loadJira(): JiraCreds | null {
  if (process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN) {
    return { base: process.env.JIRA_URL || JIRA_DEFAULT, email: process.env.JIRA_EMAIL, token: process.env.JIRA_API_TOKEN };
  }
  try { return JSON.parse(readFileSync(FILE, "utf8")) as JiraCreds; } catch { return null; }
}

export function saveJira(c: JiraCreds): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(c), { mode: 0o600 });
  chmodSync(FILE, 0o600);
}

/** "P1S-1311", "p1s-1311" or a browse/selectedIssue URL → "P1S-1311". */
export function ticketKey(raw: string): string | null {
  const m = raw.match(/(?:selectedIssue=|browse\/|^)\s*([A-Za-z][A-Za-z0-9]+-\d+)\b/);
  return m ? m[1].toUpperCase() : null;
}

const auth = (c: JiraCreds) => "Basic " + Buffer.from(`${c.email}:${c.token}`).toString("base64");

async function get(c: JiraCreds, path: string): Promise<Response> {
  const res = await fetch(c.base.replace(/\/$/, "") + path, { headers: { authorization: auth(c), accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401) throw new Error("Jira didn't accept your email/API token. Run `openwallet jira` again (create a token at id.atlassian.com → Security → API tokens).");
  if (res.status === 404) throw new Error("No such ticket, or you can't see it in Jira.");
  if (!res.ok) throw new Error(`Jira answered ${res.status}`);
  return res;
}

/** Who you are to Jira — used to check a token when it's saved. */
export async function whoAmI(c: JiraCreds): Promise<string> {
  const j = (await (await get(c, "/rest/api/3/myself")).json()) as { displayName?: string; emailAddress?: string };
  return j.displayName || j.emailAddress || c.email;
}

export async function fetchTicket(c: JiraCreds, key: string): Promise<JiraTicket> {
  const fields = "summary,description,issuetype,status,priority,assignee,reporter,labels,attachment,comment,parent";
  const j = (await (await get(c, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`)).json()) as { key: string; fields: any };
  const f = j.fields;
  return {
    key: j.key, url: `${c.base.replace(/\/$/, "")}/browse/${j.key}`, summary: f.summary ?? "",
    type: f.issuetype?.name ?? "", status: f.status?.name ?? "", priority: f.priority?.name ?? "",
    assignee: f.assignee?.displayName ?? "unassigned", reporter: f.reporter?.displayName ?? "",
    labels: f.labels ?? [], parent: f.parent ? `${f.parent.key} ${f.parent.fields?.summary ?? ""}`.trim() : null,
    description: adfToText(f.description).trim(),
    comments: (f.comment?.comments ?? []).slice(-6).map((x: any) => ({ author: x.author?.displayName ?? "?", at: String(x.created ?? "").slice(0, 10), text: adfToText(x.body).trim() })),
    attachments: (f.attachment ?? []).map((a: any) => ({ id: String(a.id), filename: a.filename, mimeType: a.mimeType ?? "", size: a.size ?? 0, content: a.content })),
  };
}

/** Save the ticket's screenshots/PDFs (at most `max`, ≤10 MB each) to temp files for upload with the prompt. */
export async function downloadAttachments(c: JiraCreds, t: JiraTicket, max = 6): Promise<string[]> {
  const out: string[] = [];
  for (const a of t.attachments.filter((x) => /^image\/|pdf$/.test(x.mimeType) && x.size <= 10 * 1024 * 1024).slice(0, max)) {
    try {
      const res = await fetch(a.content, { headers: { authorization: auth(c) }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) continue;
      const p = join(tmpdir(), `openwallet-${t.key}-${a.id}-${a.filename.replace(/[^\w.-]/g, "_")}`);
      writeFileSync(p, new Uint8Array(await res.arrayBuffer()));
      out.push(p);
    } catch { /* skip that one */ }
  }
  return out;
}

/** Atlassian Document Format → plain text that keeps lists, headings, code and tables readable. */
export function adfToText(node: any, depth = 0): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  const kids = (n: any) => (n.content ?? []).map((c: any) => adfToText(c, depth)).join("");
  switch (node.type) {
    case "doc": return (node.content ?? []).map((c: any) => adfToText(c, depth)).join("\n").replace(/\n{3,}/g, "\n\n");
    case "paragraph": return kids(node) + "\n";
    case "text": return node.text ?? "";
    case "hardBreak": return "\n";
    case "heading": return "#".repeat(node.attrs?.level ?? 2) + " " + kids(node) + "\n";
    case "bulletList": return (node.content ?? []).map((li: any) => "  ".repeat(depth) + "- " + adfToText(li, depth + 1).trim()).join("\n") + "\n";
    case "orderedList": return (node.content ?? []).map((li: any, i: number) => "  ".repeat(depth) + `${i + 1}. ` + adfToText(li, depth + 1).trim()).join("\n") + "\n";
    case "listItem": return (node.content ?? []).map((c: any) => adfToText(c, depth)).join("");
    case "codeBlock": return "```\n" + kids(node) + "\n```\n";
    case "blockquote": return kids(node).split("\n").map((l: string) => (l ? "> " + l : l)).join("\n");
    case "mention": return node.attrs?.text ?? "@someone";
    case "emoji": return node.attrs?.text ?? "";
    case "inlineCard": case "blockCard": return node.attrs?.url ?? "";
    case "mediaSingle": case "mediaGroup": case "media": return "[attachment]\n";
    case "table": return (node.content ?? []).map((row: any) => "| " + (row.content ?? []).map((cell: any) => adfToText(cell, depth).replace(/\n+/g, " ").trim()).join(" | ") + " |").join("\n") + "\n";
    case "rule": return "---\n";
    default: return kids(node);
  }
}

/** What the agent gets: the ticket, then the instruction to plan before touching code. */
export function ticketPrompt(t: JiraTicket, extra: string, attached: number): string {
  return [
    `Jira ticket ${t.key} — ${t.summary}`,
    `${t.type} · ${t.status} · priority ${t.priority} · assignee ${t.assignee} · reporter ${t.reporter}${t.labels.length ? " · labels " + t.labels.join(", ") : ""}${t.parent ? ` · parent ${t.parent}` : ""}`,
    `Link: ${t.url}`,
    "", "Description:", t.description || "(empty)",
    t.comments.length ? "\nLatest comments:\n" + t.comments.map((c) => `- ${c.author} (${c.at}): ${c.text.replace(/\s+/g, " ").slice(0, 600)}`).join("\n") : "",
    attached ? `\n${attached} attachment${attached === 1 ? "" : "s"} from the ticket ${attached === 1 ? "is" : "are"} attached below.` : "",
    extra ? `\nNote from me: ${extra}` : "",
    "\nDon't change code yet. Read the relevant code in every repo this touches, then give me a short plan: what changes in which repo and file, " +
      "anything in the ticket that is unclear or contradicts the current code, and questions for me. Wait for my go-ahead before editing.",
  ].filter(Boolean).join("\n").slice(0, 18_000);
}

export const jiraConfigured = () => !!loadJira() || existsSync(FILE);
