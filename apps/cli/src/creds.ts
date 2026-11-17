/** Saved sign-in for the OpenWallet Terminal: ~/.openwallet/credentials.json, readable only by the user. */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Creds {
  server: string;
  token: string;
  ampSecret: string;
  modelId: string;
  email: string;
  name: string;
  role: string;
  lastSessionId?: string;
}

const DIR = join(homedir(), ".openwallet");
const FILE = join(DIR, "credentials.json");

export function loadCreds(): Creds | null {
  if (!existsSync(FILE)) return null;
  try { return JSON.parse(readFileSync(FILE, "utf8")) as Creds; } catch { return null; }
}

export function saveCreds(c: Creds): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(FILE, 0o600);
}

export function clearCreds(): void {
  rmSync(FILE, { force: true });
}

// The installed binary is built with --define process.env.OPENWALLET_DEFAULT_SERVER=<the server it was downloaded from>.
export const DEFAULT_SERVER = process.env.OPENWALLET_SERVER ?? process.env.OPENWALLET_DEFAULT_SERVER ?? "http://127.0.0.1:8470";
