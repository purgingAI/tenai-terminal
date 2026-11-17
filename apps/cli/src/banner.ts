/** Start-up banner, printed into the scrollback before the terminal opens (like Claude Code's logo). */
const ART = [
  "██████╗  █████╗ ██╗   ██╗ ██╗ ██████╗ ",
  "██╔══██╗██╔══██╗╚██╗ ██╔╝███║██╔═████╗",
  "██████╔╝███████║ ╚████╔╝ ╚██║██║██╔██║",
  "██╔═══╝ ██╔══██║  ╚██╔╝   ██║████╔╝██║",
  "██║     ██║  ██║   ██║    ██║╚██████╔╝",
  "╚═╝     ╚═╝  ╚═╝   ╚═╝    ╚═╝ ╚═════╝ ",
];
const STOPS: Array<[number, number, number]> = [[255, 176, 0], [255, 122, 26], [240, 48, 42]];

function at(t: number): [number, number, number] {
  const seg = Math.min(STOPS.length - 2, Math.floor(t * (STOPS.length - 1)));
  const f = t * (STOPS.length - 1) - seg;
  const [a, b] = [STOPS[seg], STOPS[seg + 1]];
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * f)) as [number, number, number];
}

const color = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const rgb = (c: [number, number, number], s: string) => (color ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${s}\x1b[0m` : s);
const dim = (s: string) => (color ? `\x1b[38;2;154;162;189m${s}\x1b[0m` : s);
const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[22m` : s);

export function banner(version: string, server: string): string {
  const w = ART[0].length;
  // diagonal gradient: amber top-left → red bottom-right
  const art = ART.map((line, r) => [...line].map((ch, c) => rgb(at(Math.min(1, (c / w) * 0.8 + (r / ART.length) * 0.2)), ch)).join(""));
  const sub = "T  E  R  M  I  N  A  L";
  return [
    "",
    ...art.map((l) => "  " + l),
    "  " + rgb(at(0.5), bold(sub)) + dim(`   v${version}`),
    "",
    "  " + dim("TenAI agents for the OpenWallet codebase  ·  ") + dim(server.replace(/^https?:\/\//, "")),
    "",
  ].join("\n");
}

export const paint = { rgb: (t: number, s: string) => rgb(at(t), s), dim, bold };
