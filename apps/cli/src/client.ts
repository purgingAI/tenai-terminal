/** WebSocket client: authenticates, then sends every frame as a signed AMP envelope. */
import { make } from "@tenai/amp";
import type { ClientFrame, ServerFrame } from "@tenai/wire";
import type { Creds } from "./creds";

export class TenaiClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<(f: ServerFrame) => void>();
  private closeListeners = new Set<(reason: string) => void>();
  private reconnectListeners = new Set<() => void>();
  private closedByUs = false;
  private reconnecting = false;

  constructor(private creds: Creds) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.creds.server.replace(/^http/, "ws") + "/ws");
      this.ws = ws;
      let opened = false;
      ws.onopen = () => { opened = true; ws.send(JSON.stringify({ type: "auth", token: this.creds.token })); resolve(); };
      ws.onerror = () => reject(new Error(`Cannot reach ${this.creds.server}`));
      ws.onmessage = (m) => {
        const f = JSON.parse(String(m.data)) as ServerFrame;
        for (const l of this.listeners) l(f);
      };
      ws.onclose = (e) => {
        // a socket that never opened is a failed attempt; the retry loop handles it, not this handler
        if (this.closedByUs || !opened || this.reconnecting) return;
        // 4001 = signed out / blocked / expired: don't hammer the server, tell the person
        if (e.code === 4001) { for (const l of this.closeListeners) l(e.reason || "signed out"); return; }
        for (const l of this.closeListeners) l(`connection lost (${e.reason || e.code}) — reconnecting…`);
        void this.reconnect();
      };
    });
  }

  /** Server restarts (deploys) drop every socket: come back on our own, then resume the session. */
  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    for (let attempt = 0; !this.closedByUs; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4))));
      try {
        await this.connect();
        this.reconnecting = false;
        for (const l of this.reconnectListeners) l();
        return;
      } catch { /* server still down — try again */ }
    }
    this.reconnecting = false;
  }

  onReconnect(fn: () => void): void {
    this.reconnectListeners.add(fn);
  }

  on(fn: (f: ServerFrame) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onClose(fn: (reason: string) => void): void {
    this.closeListeners.add(fn);
  }

  send(frame: ClientFrame): void {
    this.ws?.send(JSON.stringify(make(this.creds.modelId, "tenai", frame.type, frame as never, this.creds.ampSecret)));
  }

  async upload(sessionId: string, path: string): Promise<string> {
    const file = Bun.file(path);
    if (!(await file.exists())) throw new Error(`No such file: ${path}`);
    const name = path.split("/").pop()!;
    const res = await fetch(`${this.creds.server}/api/attachments?sessionId=${sessionId}&name=${encodeURIComponent(name)}`, {
      method: "POST", headers: { authorization: `Bearer ${this.creds.token}` }, body: await file.arrayBuffer(),
    });
    const j = (await res.json()) as { name?: string; error?: string };
    if (!res.ok || !j.name) throw new Error(j.error ?? "Upload failed");
    return j.name;
  }

  close(): void {
    this.closedByUs = true;
    this.ws?.close();
  }
}

export async function api<T>(server: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(server + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}
