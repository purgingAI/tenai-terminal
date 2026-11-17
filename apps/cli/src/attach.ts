/**
 * Screenshots and files for the agent: a path dragged into the terminal (terminals paste it as text), /attach <path>,
 * or Ctrl+V with an image on the clipboard. Files are uploaded when the prompt is sent, so they work before a session exists.
 */
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const MAX = 10 * 1024 * 1024;
const KINDS = /\.(png|jpe?g|gif|webp|bmp|pdf|txt|log|json|csv|xml|ya?ml|html?|md|har)$/i;

/** Usable local file (exists, regular, ≤10 MB), with ~ and file:// resolved; null otherwise. */
export function localFile(raw: string): string | null {
  let p = raw.trim().replace(/^file:\/\//, "");
  try { p = decodeURIComponent(p); } catch { /* keep as typed */ }
  if (p.startsWith("~/")) p = join(process.env.HOME ?? process.env.USERPROFILE ?? "~", p.slice(2));
  try {
    const st = statSync(p);
    return st.isFile() && st.size <= MAX ? p : null;
  } catch {
    return null;
  }
}

/**
 * Pull dragged-in file paths out of a prompt: 'quoted', "quoted", back\ slashed, or plain absolute / ~ / C:\ paths
 * with a known extension that exist on this machine. Returns the files and the prompt with each path named instead.
 */
export function extractFiles(text: string): { files: string[]; text: string } {
  const files: string[] = [];
  const re = /'([^']+)'|"([^"]+)"|((?:file:\/\/|~\/|\/|[A-Za-z]:\\)(?:\\ |[^\s'"])+)/g;
  const out = text.replace(re, (whole, q1, q2, bare) => {
    const cand = (q1 ?? q2 ?? bare.replace(/\\ /g, " ")) as string;
    if (!KINDS.test(cand)) return whole;
    const f = localFile(cand);
    if (!f) return whole;
    files.push(f);
    return `[attached: ${basename(f)}]`;
  });
  return { files, text: out.trim() || "Look at the attached file." };
}

/** Save the clipboard's image to a temp PNG; null when the clipboard holds no image (or no clipboard tool exists). */
export function clipboardImage(): string | null {
  const out = join(tmpdir(), `openwallet-paste-${Date.now()}.png`);
  const run = (argv: string[]) => {
    try {
      const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
      return r.exitCode === 0 ? r.stdout : null;
    } catch {
      return null;
    }
  };
  if (process.platform === "darwin") {
    const script = `try\nset f to open for access POSIX file "${out}" with write permission\nwrite (the clipboard as «class PNGf») to f\nclose access f\nend try`;
    run(["osascript", "-e", script]);
  } else if (process.platform === "win32") {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $i=[Windows.Forms.Clipboard]::GetImage(); if ($i) { $i.Save('${out}', [System.Drawing.Imaging.ImageFormat]::Png) }`;
    run(["powershell", "-NoProfile", "-STA", "-Command", ps]);
  } else {
    const wayland = !!process.env.WAYLAND_DISPLAY;
    const types = run(wayland ? ["wl-paste", "--list-types"] : ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"])?.toString() ?? "";
    const type = types.split("\n").map((t) => t.trim()).find((t) => /^image\/(png|jpeg|jpg|webp|bmp)$/.test(t));
    if (!type) return null;
    const data = run(wayland ? ["wl-paste", "--type", type] : ["xclip", "-selection", "clipboard", "-t", type, "-o"]);
    if (!data?.length) return null;
    Bun.write(out, data);
    return out;
  }
  return existsSync(out) && statSync(out).size > 0 ? out : null;
}
