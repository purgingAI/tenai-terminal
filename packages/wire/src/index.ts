/**
 * Every WebSocket frame between the OpenWallet Terminal (CLI/web) and the server. Client frames travel as the
 * `body` of a signed AMP envelope; server frames are plain JSON. Shared by server, CLI and web.
 */
import { z } from "zod";

// ---- client → server (AMP intent = frame type) ----
export const ClientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.open"), repo: z.string(), title: z.string().max(120).optional(), branch: z.string().max(200).optional(),
    also: z.array(z.string().max(200)).max(5).default([]),
    ticket: z.object({ key: z.string().max(40), url: z.string().max(300), summary: z.string().max(300) }).optional() }),
  z.object({ type: z.literal("session.also"), sessionId: z.string(), branches: z.array(z.string().max(200)).max(5) }),
  // point one repo of the session at an existing branch (null = a fresh branch), with extra branches to copy onto
  z.object({ type: z.literal("session.use"), sessionId: z.string(), repo: z.string(), branch: z.string().max(200).nullable(),
    also: z.array(z.string().max(200)).max(5).default([]) }),
  z.object({ type: z.literal("session.resume"), sessionId: z.string() }),
  z.object({
    type: z.literal("prompt.submit"), sessionId: z.string(), text: z.string().min(1).max(20_000),
    attachments: z.array(z.string()).max(8).default([]),
  }),
  z.object({ type: z.literal("turn.cancel"), sessionId: z.string() }),
  z.object({ type: z.literal("diff.request"), sessionId: z.string() }),
  z.object({ type: z.literal("ship"), sessionId: z.string(), title: z.string().min(3).max(120), description: z.string().max(2000).default(""), force: z.boolean().default(false) }),
  z.object({ type: z.literal("session.end"), sessionId: z.string() }),
  // pairing: bring a teammate in, hand the session over, or drop out of someone else's
  z.object({ type: z.literal("session.invite"), sessionId: z.string(), who: z.string().min(2).max(120) }),
  z.object({ type: z.literal("session.handoff"), sessionId: z.string(), who: z.string().min(2).max(120) }),
  z.object({ type: z.literal("session.leave"), sessionId: z.string() }),
  z.object({ type: z.literal("spine.subscribe"), since: z.number().default(0) }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// ---- server → client ----
export type ServerFrame =
  | { type: "hello"; email: string; name: string; modelId: string; role: string; repos: string[] }
  | { type: "session.opened"; sessionId: string; repo: string; branch: string; resumed: boolean; target?: string | null; also?: string[] }
  | { type: "gate.refused"; sessionId: string; reason: string; rule?: string; label?: string }
  | { type: "queue.position"; sessionId: string; position: number }
  | { type: "turn.start"; sessionId: string; turnId: string }
  | { type: "turn.text"; sessionId: string; turnId: string; text: string }
  | { type: "turn.tool"; sessionId: string; turnId: string; name: string; summary: string }
  | { type: "turn.tool_result"; sessionId: string; turnId: string; ok: boolean; denied: boolean; text: string }
  | { type: "turn.done"; sessionId: string; turnId: string; text: string; tokens: number; costUsd: number }
  | { type: "turn.error"; sessionId: string; turnId: string; message: string }
  | { type: "collision.warning"; sessionId: string; paths: string[]; with: Array<{ email: string; path: string }> }
  | { type: "diff"; sessionId: string; files: string[]; patch: string }
  | { type: "shipped"; sessionId: string; sha: string; files: string[]; mrUrl: string | null; diffstat: string; pushedTo?: string;
      ports?: Array<{ branch: string; ok: boolean; sha?: string; already?: boolean; error?: string }>;
      /** One entry per repo shipped (sessions span repos). */
      results?: Array<{ repo: string; sha: string; diffstat: string; mrUrl: string | null; pushedTo?: string; files: string[];
        ports?: Array<{ branch: string; ok: boolean; sha?: string; already?: boolean; error?: string }>; error?: string }> }
  | { type: "session.invited"; sessionId: string; from: string; fromEmail: string; label: string; handoff: boolean }
  | { type: "turn.prompt"; sessionId: string; turnId: string; email: string; name: string; text: string }
  | { type: "session.repos"; sessionId: string; repos: Array<{ repo: string; branch: string; target: string | null; also: string[] }> }
  | { type: "spine.event"; seq: number; ts: number; kind: string; actor: string; repo: string | null; payload: Record<string, unknown> }
  | { type: "session.blocked"; sessionId?: string; reason: string }
  | { type: "notice"; level: "info" | "warn" | "bad"; text: string }
  | { type: "hint"; sessionId: string; text: string }
  | { type: "error"; message: string };
