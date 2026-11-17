/**
 * Optional Teams channel posts (shipped merge requests, shared-account alerts) through a Teams Workflows
 * "post to a channel when a webhook request is received" URL. The URL is a secret: stored 0600, never echoed.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const ALLOWED = /^https:\/\/[\w.-]+\.(logic\.azure\.com|webhook\.office\.com|powerplatform\.com|api\.powerplatform\.com|office\.com)(:\d+)?\//i;

export class Teams {
  constructor(private file: string | undefined) {}

  private url(): string | undefined {
    return this.file && existsSync(this.file) ? readFileSync(this.file, "utf8").trim() || undefined : undefined;
  }

  connected(): boolean { return !!this.url(); }

  async set(url: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.file) return { ok: false, error: "TENAI_TEAMS_WEBHOOK_FILE is not configured on the server." };
    if (!ALLOWED.test(url.trim())) return { ok: false, error: "That doesn't look like a Teams Workflows webhook URL (https://…logic.azure.com/… or …powerplatform.com/…)." };
    const test = await this.send(url.trim(), "TenAI is connected ✓", "Shipped merge requests and shared-usage alerts from the OpenWallet Terminal will appear here.", "Good");
    if (!test.ok) return test;
    writeFileSync(this.file + ".tmp", url.trim(), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
    return { ok: true };
  }

  disconnect(): void { if (this.file) rmSync(this.file, { force: true }); }

  async post(title: string, text: string, tone: "Good" | "Warning" | "Attention" | "Default" = "Default", link?: { title: string; url: string }) {
    const url = this.url();
    if (!url) return { ok: false, error: "not connected" };
    return this.send(url, title, text, tone, link);
  }

  private async send(url: string, title: string, text: string, tone: string, link?: { title: string; url: string }) {
    const card = {
      type: "AdaptiveCard", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", version: "1.4",
      body: [
        { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", color: tone, wrap: true },
        { type: "TextBlock", text, wrap: true, spacing: "Small" },
      ],
      actions: link ? [{ type: "Action.OpenUrl", title: link.title, url: link.url }] : [],
    };
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }] }),
      });
      return res.ok ? { ok: true } : { ok: false, error: `Teams answered ${res.status}` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
