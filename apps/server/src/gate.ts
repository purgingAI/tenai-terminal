/**
 * Intent gate: is this prompt about the codebase? Asks the Python ONNX sidecar first; if the sidecar is
 * down, falls back to keyword rules so the server keeps working (and keeps refusing chit-chat).
 * Anything refused here costs zero Claude tokens.
 */

export type GateLabel = "code_task" | "code_question" | "out_of_scope";

export interface GateDecision {
  label: GateLabel;
  score: number;
  /** Live model version (sidecar only) and the staged challenger's opinion, if one runs in shadow. */
  version?: number;
  shadow?: { label: GateLabel; score: number; version: number };
  source: "sidecar" | "rules" | "followup";
  allowed: boolean;
  clarify?: string;
}

const CODE_WORDS = /\b(code|codebase|repo|repository|class|method|function|endpoint|api|controller|service|dto|entity|repository|bug|fix|refactor|test|tests|unit test|build|compile|branch|merge request|\bmr\b|commit|diff|module|component|angular|react|java|spring|kotlin|typescript|javascript|python|sql|migration|liquibase|schema|null ?pointer|exception|stack ?trace|log|config|yml|yaml|json|pom|gradle|npm|dependency|import|interface|enum|field|column|validation|regex|query|jpa|hibernate|mongo|kafka|scheduler|cron|processor|controller|html|css|scss|ui|page|screen|button|modal|form|route|guard|interceptor|pipe|pr)\b/i;
const TASK_VERBS = /\b(add|implement|create|write|change|update|modify|fix|refactor|rename|remove|delete|move|extract|replace|migrate|upgrade|bump|optimi[sz]e|improve|handle|support|make|build|generate|cover|wire|hook up|port)\b/i;
const QUESTION = /\b(what|where|why|how|which|who|when|explain|show me|find|trace|does|is there|can you tell|walk me through|summari[sz]e|list)\b|\?\s*$/i;
const FOLLOW_UP = /^\s*(yes|yep|ok(ay)?|sure|go ahead|do it|continue|proceed|ship it|looks good|lgtm|also\b|and\b|then\b|now\b|same for|try again|retry|undo|revert|again)\b/i;

export function ruleGate(text: string): { label: GateLabel; score: number } {
  const code = CODE_WORDS.test(text) || /[\w-]+\.(java|ts|tsx|js|py|kt|html|scss|sql|yml|yaml|xml|json|go)\b/.test(text)
    || /[A-Z][a-z]+[A-Z]\w+/.test(text) || /`[^`]+`/.test(text);
  if (!code) return { label: "out_of_scope", score: 0.7 };
  if (TASK_VERBS.test(text)) return { label: "code_task", score: 0.75 };
  if (QUESTION.test(text)) return { label: "code_question", score: 0.75 };
  return { label: "code_question", score: 0.55 };
}

export interface GateOptions {
  sidecarUrl: string;
  threshold?: number;
  /** Label of this session's previous code turn, if it was within the follow-up window. */
  previousCodeLabel?: GateLabel | null;
  timeoutMs?: number;
}

export async function classify(text: string, opts: GateOptions): Promise<GateDecision> {
  const threshold = opts.threshold ?? 0.6;
  if (opts.previousCodeLabel && opts.previousCodeLabel !== "out_of_scope" && (FOLLOW_UP.test(text) || text.trim().length <= 40)) {
    return { label: opts.previousCodeLabel, score: 1, source: "followup", allowed: true };
  }
  let label: GateLabel;
  let score: number;
  let version: number | undefined;
  let shadow: GateDecision["shadow"];
  let source: GateDecision["source"] = "sidecar";
  try {
    const res = await fetch(opts.sidecarUrl + "/classify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
    });
    if (!res.ok) throw new Error(`sidecar ${res.status}`);
    const j = (await res.json()) as { label: GateLabel; score: number; version?: number; shadow?: GateDecision["shadow"] };
    label = j.label;
    score = j.score;
    version = j.version;
    shadow = j.shadow;
  } catch {
    ({ label, score } = ruleGate(text));
    source = "rules";
  }
  if (label === "out_of_scope") return { label, score, source, version, shadow, allowed: false };
  if (score < threshold) {
    return {
      label, score, source, version, shadow, allowed: false,
      clarify: "I can only help with work on the OpenWallet codebases. Tell me which repo, file or feature this is about and what you want changed or explained.",
    };
  }
  return { label, score, source, version, shadow, allowed: true };
}

/** Allowed prompts the model was unsure about still go to the inbox, so the next version learns them. */
export const BORDERLINE = 0.75;
/** Refusals at or above this confidence skip the inbox (they would bury the useful ones). */
export const CONFIDENT_REFUSAL = 0.9;

export const REFUSAL =
  "TenAI only works on the OpenWallet codebases — questions about the code or changes to it. That request is outside what it can do.";
