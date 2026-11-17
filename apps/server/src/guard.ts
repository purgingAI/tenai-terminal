/**
 * Guardrails that run before the intent gate (no tokens spent on a refusal) and redaction applied to
 * everything sent back to a client. TenAI changes code; it never operates databases, Vault or servers.
 * Writing a migration or a SQL file is code and is allowed — running something against a live system is not.
 */

export interface GuardVerdict {
  allowed: boolean;
  rule?: string;
  reason?: string;
}

const RULES: Array<{ id: string; re: RegExp; reason: string }> = [
  {
    id: "db.operate",
    re: /\b(run|execute|apply|fire|truncate|drop|delete|update|insert|alter)\b[^.\n]{0,60}\b(on|against|in|into|from)\b[^.\n]{0,30}\b(prod(uction)?|dev|uat|live|the)?\s*(db|database|mysql|mongo(db)?|redis|clickhouse|rds|table)\b/i,
    reason: "TenAI changes code only; it does not run anything against databases.",
  },
  {
    id: "db.connect",
    re: /\b(connect|log ?in|ssh|login)\b[^.\n]{0,25}\b(to|into)\b[^.\n]{0,25}\b(db|database|mysql|mongo(db)?|redis|clickhouse|server|box|ec2|prod)\b/i,
    reason: "TenAI cannot connect to databases or servers.",
  },
  {
    id: "vault",
    re: /\b(vault)\b[^.\n]{0,40}\b(write|put|patch|change|update|set|delete|rotate|read|show|print|token)\b|\b(write|put|change|update|set|delete|rotate|read|show|print)\b[^.\n]{0,40}\bvault\b/i,
    reason: "TenAI never reads or changes Vault.",
  },
  {
    id: "infra",
    re: /\b(kubectl|helm|terraform\s+apply|aws\s+\w+|gcloud|az\s+\w+|systemctl|docker\s+(run|exec|push)|restart\s+(the\s+)?(server|service|pod|container)|deploy\s+(it\s+)?to\s+(prod|uat|dev|server))\b/i,
    reason: "TenAI does not operate servers, clusters or deployments; it opens merge requests.",
  },
  {
    id: "secrets",
    re: /\b(show|print|cat|reveal|give|send|dump|leak|export)\b[^.\n]{0,40}\b(password|passwd|secret|api[_ -]?key|token|credential|private key|\.env|\.credentials|claude[_ -]?token|oauth)\b|~\/\.(claude|ssh|aws|openwallet)\b/i,
    reason: "TenAI never reveals credentials or secrets.",
  },
  {
    id: "push.protected",
    re: /\b(push|merge|commit)\b[^.\n]{0,30}\b(to|into|on)\b[^.\n]{0,15}\b(env\/dev|env\/uat|env\/prod|main|master)\b/i,
    reason: "TenAI never pushes to protected branches; it raises a merge request for a human to merge.",
  },
  {
    id: "injection",
    re: /\b(ignore|disregard|forget)\b[^.\n]{0,30}\b(previous|above|prior|all|your)\b[^.\n]{0,20}\b(instructions|rules|prompt|guardrails)\b|\byou are now\b|\b(system prompt|developer mode|jailbreak)\b/i,
    reason: "That looks like an attempt to change TenAI's rules.",
  },
];

export function checkPrompt(text: string): GuardVerdict {
  for (const r of RULES) {
    if (r.re.test(text)) return { allowed: false, rule: r.id, reason: r.reason };
  }
  return { allowed: true };
}

const SECRET_PATTERNS: RegExp[] = [
  /\btenai_[0-9a-f]{32,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{10,}\b/g,
  /\bhvs\.[A-Za-z0-9_-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bATATT[A-Za-z0-9_=-]{20,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

// key=value / key: value — keeps the key so the text stays readable.
const KEY_VALUE = /\b(password|passwd|pwd|secret|api[_-]?key|token)(["']?\s*[:=]\s*["']?)([^\s"',;]{4,})/gi;

/** Masks secret-looking values in any text that leaves the server. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "***");
  return out.replace(KEY_VALUE, (_m, key: string, sep: string) => `${key}${sep}***`);
}
