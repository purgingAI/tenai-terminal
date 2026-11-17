import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFiles } from "../src/attach";

test("dragged-in paths become attachments; other text and unknown paths stay", () => {
  const d = mkdtempSync(join(tmpdir(), "openwallet drop "));
  const shot = join(d, "Screenshot from 2026-10-29.png");
  const log = join(d, "err.log");
  writeFileSync(shot, "png");
  writeFileSync(log, "boom");
  const r = extractFiles(`fix this '${shot}' and ${log.replace(/ /g, "\\ ")} but not /etc/nothing.png or src/app/x.ts`);
  expect(r.files).toEqual([shot, log]);
  expect(r.text).toBe("fix this [attached: Screenshot from 2026-10-29.png] and [attached: err.log] but not /etc/nothing.png or src/app/x.ts");
  expect(extractFiles(`'${shot}'`).text).toBe("[attached: Screenshot from 2026-10-29.png]");
  expect(extractFiles("plain question").files).toEqual([]);
});
