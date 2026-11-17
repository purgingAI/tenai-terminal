/**
 * Cross-repo contract check: a backend change that removes or renames a DTO field or an endpoint path breaks the
 * Admin Console / portal code that still uses it — and the backend compiles fine, so nothing catches it until someone
 * clicks the screen. This reads the session's own diff (no AI, no tokens), lists what disappeared, and searches the
 * session's OTHER repos for it. Heuristic by design: it names candidates with file:line; the agent or the engineer decides.
 */

export interface Removed { kind: "field" | "path"; name: string; file: string; repo: string }
export interface Finding extends Removed { uses: Array<{ repo: string; file: string; line: number; text: string }> }

// too generic to search for: every repo is full of them
const COMMON = new Set(["id", "name", "type", "code", "status", "value", "data", "date", "amount", "message", "description", "title",
  "email", "phone", "mobile", "country", "currency", "count", "total", "active", "enabled", "error", "result", "response", "request",
  "user", "userId", "createdAt", "updatedAt", "createDate", "updateDate", "createdBy", "updatedBy", "version", "key", "label", "url"]);

const JAVA_FIELD = /^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:private|protected|public)\s+(?:final\s+|static\s+)*(?!class\b|interface\b|enum\b|record\b)[\w.<>,?\s[\]]+?\s+(\w+)\s*(?:=[^;]*)?;\s*$/;
const JSON_PROP = /@JsonProperty\(\s*(?:value\s*=\s*)?"([^"]+)"/;
const MAPPING = /@(?:Get|Post|Put|Delete|Patch|Request)Mapping\s*\(([^)]*)\)/;
const STRINGS = /"([^"]*)"/g;

/** A Java file that carries data across the wire (DTOs, requests, responses, entities). */
const isContractFile = (f: string) => /\.java$/.test(f) && /(dto|request|response|entity|model|payload|vo)\b|(DTO|Dto|Request|Response|Entity|Payload|VO)\.java$/i.test(f);

/** What a backend diff (-U0) removed from its API surface: fields of DTO-like classes and mapping paths. */
export function removedFromDiff(repo: string, diff: string): Removed[] {
  const out: Removed[] = [];
  for (const block of diff.split(/^(?=diff --git )/m)) {
    const file = block.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? block.match(/^--- a\/(.+)$/m)?.[1];
    if (!file || !file.endsWith(".java")) continue;
    const minus = block.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1));
    const plus = block.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");
    if (isContractFile(file)) {
      for (const l of minus) {
        const json = l.match(JSON_PROP)?.[1];
        if (json && !plus.includes(`"${json}"`)) out.push({ kind: "field", name: json, file, repo });
        const f = l.match(JAVA_FIELD)?.[1];
        // still declared on an added line (type or annotation changed only) → not removed
        if (f && !new RegExp(`\\b${f}\\s*(=[^;]*)?;`).test(plus)) out.push({ kind: "field", name: f, file, repo });
      }
    }
    for (const l of minus) {
      const m = l.match(MAPPING);
      if (!m) continue;
      for (const [, p] of m[1].matchAll(STRINGS)) if (p.length > 1 && p.includes("/") && !plus.includes(`"${p}"`)) out.push({ kind: "path", name: p, file, repo });
    }
  }
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.kind}:${r.name}`;
    if (seen.has(k) || (r.kind === "field" && (COMMON.has(r.name) || r.name.length < 4))) return false;
    seen.add(k);
    return true;
  });
}

/** The most specific piece of a path worth searching for in front-end code: its last literal segment(s). */
export function pathNeedle(p: string): string | null {
  const segs = p.split("/").filter((s) => s && !s.startsWith("{"));
  if (!segs.length) return null;
  const tail = segs.slice(-2).join("/");
  return tail.length >= 5 ? tail : null;
}
