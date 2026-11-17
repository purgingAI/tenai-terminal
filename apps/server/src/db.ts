import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',          -- user | admin
  blocked INTEGER NOT NULL DEFAULT 0,
  daily_token_budget INTEGER NOT NULL,
  created INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS otp (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires INTEGER NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  hour_start INTEGER NOT NULL,
  hour_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  model_id TEXT NOT NULL,                       -- the "agent model" id this connection is shown as
  amp_secret TEXT NOT NULL,                     -- per-session HMAC key for AMP frames
  expires INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS term_sessions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  model_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  worktree TEXT NOT NULL,
  branch TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_session TEXT,
  status TEXT NOT NULL,                         -- active | blocked | ended
  started INTEGER NOT NULL,
  ended INTEGER
);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  email TEXT NOT NULL,
  prompt TEXT NOT NULL,                         -- redacted
  gate_label TEXT,
  gate_score REAL,
  outcome TEXT NOT NULL,                        -- queued | running | done | refused | failed | cancelled
  detail TEXT,
  started INTEGER NOT NULL,
  ended INTEGER
);
CREATE TABLE IF NOT EXISTS usage (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  email TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  email TEXT NOT NULL,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  created INTEGER NOT NULL,
  released INTEGER
);
CREATE INDEX IF NOT EXISTS idx_claims_active ON claims(repo, released);
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  email TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  sha TEXT,
  files TEXT NOT NULL,                          -- JSON array
  diffstat TEXT,
  mr_url TEXT,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS spine_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  repo TEXT,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
-- Every step of a turn, for replay in the dashboard (text is already redacted)
CREATE TABLE IF NOT EXISTS turn_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,                            -- start | tool | denied | text | done | error
  name TEXT,
  text TEXT
);
CREATE INDEX IF NOT EXISTS turn_events_turn ON turn_events(turn_id, seq);

-- Claude subscription usage over time (one row per change), for the burn-rate forecast
CREATE TABLE IF NOT EXISTS claude_usage_samples (
  ts INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  five_hour REAL,
  five_resets INTEGER,
  seven_day REAL,
  seven_resets INTEGER,
  status TEXT
);
CREATE INDEX IF NOT EXISTS claude_usage_samples_ts ON claude_usage_samples(ts);

-- Gate inbox: refused, borderline and appealed prompts waiting for a human label (they train the next gate version)
CREATE TABLE IF NOT EXISTS gate_reviews (
  id TEXT PRIMARY KEY,
  turn_id TEXT,
  email TEXT NOT NULL,
  text TEXT NOT NULL,
  model_label TEXT,
  model_score REAL,
  model_version INTEGER,
  reason TEXT NOT NULL,                          -- refused | borderline | appeal
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open',           -- open | labelled | dismissed
  label TEXT,
  labelled_by TEXT,
  labelled_at INTEGER,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gate_reviews_status ON gate_reviews(status, created);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  // additive migrations for databases created before the column existed
  const cols = new Set((db.query("PRAGMA table_info(turns)").all() as Array<{ name: string }>).map((c) => c.name));
  for (const [c, t] of [["gate_version", "INTEGER"], ["shadow_label", "TEXT"], ["shadow_score", "REAL"], ["shadow_version", "INTEGER"]])
    if (!cols.has(c)) db.exec(`ALTER TABLE turns ADD COLUMN ${c} ${t}`);
  // sessions opened on an existing branch (/branch): /ship pushes onto it instead of opening a new MR
  const scols = new Set((db.query("PRAGMA table_info(term_sessions)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!scols.has("target_branch")) db.exec("ALTER TABLE term_sessions ADD COLUMN target_branch TEXT");
  if (!scols.has("also_branches")) db.exec("ALTER TABLE term_sessions ADD COLUMN also_branches TEXT");
  if (!scols.has("ticket")) db.exec("ALTER TABLE term_sessions ADD COLUMN ticket TEXT");
  // people working in someone else's session (/invite); the owner stays term_sessions.email
  db.exec(`CREATE TABLE IF NOT EXISTS session_members (
    session_id TEXT NOT NULL, email TEXT NOT NULL, added_by TEXT NOT NULL, added_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, email))`);
  // the files of every repo before each turn, so /undo can go back (commits kept alive by refs/tenai/ckpt/*)
  db.exec(`CREATE TABLE IF NOT EXISTS session_checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_id TEXT, label TEXT NOT NULL,
    created INTEGER NOT NULL, snap TEXT NOT NULL)`);
  // one worktree per repo in a session (sessions span every repo); sessions without rows are single-repo (older)
  db.exec(`CREATE TABLE IF NOT EXISTS session_repos (
    session_id TEXT NOT NULL, repo TEXT NOT NULL, dir TEXT NOT NULL, branch TEXT NOT NULL,
    target_branch TEXT, also_branches TEXT, PRIMARY KEY (session_id, repo))`);
  return db;
}
