import { expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { adfToText, downloadAttachments, fetchTicket, ticketKey, ticketPrompt } from "../src/jira";

test("ticket keys from keys and links", () => {
  expect(ticketKey("p1s-1311")).toBe("P1S-1311");
  expect(ticketKey("https://your-org.atlassian.net/browse/MPG-819")).toBe("MPG-819");
  expect(ticketKey("https://your-org.atlassian.net/jira/software/projects/P1S/boards/1?selectedIssue=P1S-1304")).toBe("P1S-1304");
  expect(ticketKey("fix the bug")).toBeNull();
});

test("Jira's document format becomes readable text", () => {
  const doc = { type: "doc", content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Acceptance" }] },
    { type: "paragraph", content: [{ type: "text", text: "Admin can " }, { type: "text", text: "block", marks: [{ type: "strong" }] }, { type: "hardBreak" }, { type: "mention", attrs: { text: "@Alex" } }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "per country" }] }] },
                                    { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "audit trail" }] }] }] },
    { type: "codeBlock", content: [{ type: "text", text: "GET /dp/block" }] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Role" }] }] }, { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Can block" }] }] }] }] },
  ] };
  expect(adfToText(doc)).toBe("## Acceptance\n\nAdmin can block\n@Alex\n\n- per country\n- audit trail\n\n```\nGET /dp/block\n```\n\n| Role | Can block |\n");
});

test("fetches a ticket, its comments and screenshots with the engineer's own token", async () => {
  let sawAuth = "";
  const srv = Bun.serve({ port: 0, fetch(req) {
    sawAuth = req.headers.get("authorization") ?? "";
    const u = new URL(req.url);
    if (u.pathname === "/rest/api/3/issue/P1S-1311") return Response.json({ key: "P1S-1311", fields: {
      summary: "Block developers per country", issuetype: { name: "Story" }, status: { name: "In Progress" }, priority: { name: "High" },
      assignee: { displayName: "Sagar Uniyal" }, reporter: { displayName: "Brandon Lim" }, labels: ["dp"], parent: { key: "P1S-1300", fields: { summary: "Portal" } },
      description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Admins block developers." }] }] },
      comment: { comments: [{ author: { displayName: "Alex" }, created: "2026-10-28T10:00:00", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Also merchants" }] }] } }] },
      attachment: [{ id: "9", filename: "screen 1.png", mimeType: "image/png", size: 3, content: `http://127.0.0.1:${srv.port}/att/9` },
                   { id: "10", filename: "notes.zip", mimeType: "application/zip", size: 3, content: `http://127.0.0.1:${srv.port}/att/10` }],
    } });
    if (u.pathname === "/att/9") return new Response("PNG");
    return new Response("no", { status: 404 });
  } });
  const c = { base: `http://127.0.0.1:${srv.port}`, email: "dev@example.com", token: "tok" };
  const t = await fetchTicket(c, "P1S-1311");
  expect(sawAuth).toBe("Basic " + Buffer.from("dev@example.com:tok").toString("base64"));
  expect([t.summary, t.type, t.status, t.assignee, t.parent, t.description]).toEqual(["Block developers per country", "Story", "In Progress", "Sagar Uniyal", "P1S-1300 Portal", "Admins block developers."]);
  const files = await downloadAttachments(c, t);
  expect(files.length).toBe(1);                                   // the zip is not sent to the agent
  expect(readFileSync(files[0], "utf8")).toBe("PNG");
  const prompt = ticketPrompt(t, "UAE first", files.length);
  expect(prompt).toContain("Jira ticket P1S-1311 — Block developers per country");
  expect(prompt).toContain("- Alex (2026-10-28): Also merchants");
  expect(prompt).toContain("Note from me: UAE first");
  expect(prompt).toContain("Wait for my go-ahead before editing.");
  await expect(fetchTicket(c, "NOPE-1")).rejects.toThrow(/No such ticket/);
  for (const f of files) if (existsSync(f)) unlinkSync(f);
  srv.stop(true);
});
