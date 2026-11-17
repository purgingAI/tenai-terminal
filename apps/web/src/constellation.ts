/**
 * Live constellation: the TenAI core in the middle, every active session orbiting it as a node coloured
 * by person. Turns fire particles core→node, refusals bounce amber, denied tools and collisions flash red.
 * Canvas + requestAnimationFrame, paused when hidden, still frame under reduced motion.
 */
export interface Orbiter { id: string; label: string; sub: string; color: string; working: boolean; idle?: boolean }
type Burst = { from: "core" | string; to: "core" | string; color: string; t: number; speed: number };
type Flash = { id: string; color: string; t: number };
type Bolt = { a: string; b: string; t: number; seed: number };

/** Particle colour per tool, so the constellation shows what agents are doing (read / search / edit / git). */
export const TOOL_COLORS: Record<string, string> = { Read: "#5b8cff", Grep: "#28c9c9", Glob: "#28c9c9", Edit: "#a07bff", Write: "#a07bff", MultiEdit: "#a07bff", Bash: "#ffb000" };

export class Constellation {
  private ctx: CanvasRenderingContext2D;
  private nodes: Orbiter[] = [];
  private bursts: Burst[] = [];
  private flashes: Flash[] = [];
  private bolts: Bolt[] = [];
  private raf = 0;
  private start = performance.now();
  private reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    const loop = () => { this.draw(); this.raf = requestAnimationFrame(loop); };
    if (this.reduced) this.draw(); else this.raf = requestAnimationFrame(loop);
  }

  destroy() { cancelAnimationFrame(this.raf); }
  setNodes(n: Orbiter[]) { this.nodes = n; if (this.reduced) this.draw(); }
  fire(id: string, color: string, inbound = false) {
    this.bursts.push({ from: inbound ? id : "core", to: inbound ? "core" : id, color, t: 0, speed: 0.012 + Math.random() * 0.01 });
  }
  flash(id: string, color: string) { this.flashes.push({ id, color, t: 0 }); }
  /** Collision: a jagged red bolt between the two sessions editing the same file. */
  lightning(a: string, b: string) { this.bolts.push({ a, b, t: 0, seed: Math.random() * 1000 }); this.flash(a, "#ff5d6c"); this.flash(b, "#ff5d6c"); }

  private pos(id: string | "core", w: number, h: number, now: number): [number, number] {
    if (id === "core") return [w / 2, h / 2];
    const i = this.nodes.findIndex((n) => n.id === id);
    if (i < 0) return [w / 2, h / 2];
    const ring = Math.min(w, h) * (0.3 + (i % 2) * 0.1);
    const a = (i / Math.max(1, this.nodes.length)) * Math.PI * 2 + (this.reduced ? 0 : (now - this.start) / 26000) * (i % 2 ? -1 : 1);
    return [w / 2 + Math.cos(a) * ring * 1.35, h / 2 + Math.sin(a) * ring];
  }

  private draw() {
    const c = this.canvas, dpr = devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const x = this.ctx;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, h);
    const now = performance.now();
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue("--ink").trim() || "#eef0f7", muted = css.getPropertyValue("--muted").trim() || "#9aa2bd";

    // orbit rings
    x.strokeStyle = "rgba(255,122,26,0.10)"; x.lineWidth = 1;
    for (const r of [0.3, 0.4]) { x.beginPath(); x.ellipse(w / 2, h / 2, Math.min(w, h) * r * 1.35, Math.min(w, h) * r, 0, 0, Math.PI * 2); x.stroke(); }

    // links
    for (const n of this.nodes) {
      const [nx, ny] = this.pos(n.id, w, h, now);
      const g = x.createLinearGradient(w / 2, h / 2, nx, ny);
      g.addColorStop(0, "rgba(255,122,26,0.35)"); g.addColorStop(1, n.color + "55");
      x.strokeStyle = g; x.lineWidth = n.working ? 2 : 1; x.beginPath(); x.moveTo(w / 2, h / 2); x.lineTo(nx, ny); x.stroke();
    }

    // core
    const breathe = this.reduced ? 1 : 1 + Math.sin(now / 900) * 0.06;
    const halo = x.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, 70 * breathe);
    halo.addColorStop(0, "rgba(255,176,0,0.55)"); halo.addColorStop(0.5, "rgba(255,122,26,0.18)"); halo.addColorStop(1, "rgba(240,48,42,0)");
    x.fillStyle = halo; x.beginPath(); x.arc(w / 2, h / 2, 70 * breathe, 0, Math.PI * 2); x.fill();
    const core = x.createLinearGradient(w / 2 - 26, h / 2 - 26, w / 2 + 26, h / 2 + 26);
    core.addColorStop(0, "#ffb000"); core.addColorStop(0.5, "#ff7a1a"); core.addColorStop(1, "#f0302a");
    x.fillStyle = core; x.beginPath(); x.arc(w / 2, h / 2, 26, 0, Math.PI * 2); x.fill();
    x.fillStyle = "#fff"; x.font = "800 13px Outfit, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText("TenAI", w / 2, h / 2);

    // bursts
    this.bursts = this.bursts.filter((b) => b.t < 1);
    for (const b of this.bursts) {
      b.t += this.reduced ? 1 : b.speed;
      const [ax, ay] = this.pos(b.from, w, h, now), [bx, by] = this.pos(b.to, w, h, now);
      for (let k = 0; k < 5; k++) {
        const t = Math.max(0, b.t - k * 0.025);
        const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
        x.fillStyle = b.color; x.globalAlpha = 1 - k * 0.18; x.shadowColor = b.color; x.shadowBlur = 14;
        x.beginPath(); x.arc(px, py, 3.2 - k * 0.4, 0, Math.PI * 2); x.fill();
      }
      x.globalAlpha = 1; x.shadowBlur = 0;
    }

    // lightning between colliding sessions
    this.bolts = this.bolts.filter((b) => b.t < 1);
    for (const bolt of this.bolts) {
      bolt.t += this.reduced ? 1 : 0.025;
      const [ax, ay] = this.pos(bolt.a, w, h, now), [bx, by] = this.pos(bolt.b, w, h, now);
      const segs = 9, nx = -(by - ay), ny = bx - ax, len = Math.hypot(nx, ny) || 1;
      x.strokeStyle = "#ff5d6c"; x.lineWidth = 2.4; x.globalAlpha = Math.max(0, 1 - bolt.t) * (0.6 + 0.4 * Math.sin(bolt.t * 60));
      x.shadowColor = "#ff5d6c"; x.shadowBlur = 18; x.beginPath(); x.moveTo(ax, ay);
      for (let i = 1; i < segs; i++) {
        const k = i / segs, j = Math.sin(bolt.seed + i * 12.9 + Math.floor(bolt.t * 14)) * 16;
        x.lineTo(ax + (bx - ax) * k + (nx / len) * j, ay + (by - ay) * k + (ny / len) * j);
      }
      x.lineTo(bx, by); x.stroke(); x.globalAlpha = 1; x.shadowBlur = 0;
    }

    // nodes
    this.flashes = this.flashes.filter((f) => f.t < 1);
    for (const n of this.nodes) {
      const [nx, ny] = this.pos(n.id, w, h, now);
      const fl = this.flashes.find((f) => f.id === n.id);
      if (fl) {
        fl.t += 0.02;
        x.strokeStyle = fl.color; x.globalAlpha = 1 - fl.t; x.lineWidth = 3;
        x.beginPath(); x.arc(nx, ny, 22 + fl.t * 26, 0, Math.PI * 2); x.stroke(); x.globalAlpha = 1;
      }
      if (n.working && !this.reduced) {
        x.strokeStyle = n.color; x.globalAlpha = 0.5 + Math.sin(now / 200) * 0.3; x.lineWidth = 2;
        x.beginPath(); x.arc(nx, ny, 22, 0, Math.PI * 2); x.stroke(); x.globalAlpha = 1;
      }
      // connected but no session yet: a hollow, softly breathing node
      if (n.idle) {
        x.globalAlpha = 0.55 + (this.reduced ? 0 : Math.sin(now / 700) * 0.2);
        x.strokeStyle = n.color; x.lineWidth = 2; x.setLineDash([4, 3]);
        x.beginPath(); x.arc(nx, ny, 16, 0, Math.PI * 2); x.stroke(); x.setLineDash([]);
        x.fillStyle = n.color + "33"; x.fill(); x.globalAlpha = 1;
      } else {
        x.fillStyle = n.color; x.shadowColor = n.color; x.shadowBlur = 18;
        x.beginPath(); x.arc(nx, ny, 16, 0, Math.PI * 2); x.fill(); x.shadowBlur = 0;
      }
      x.fillStyle = "#fff"; x.font = "700 11px Outfit, sans-serif"; x.fillText(n.label.slice(0, 2).toUpperCase(), nx, ny);
      x.fillStyle = ink; x.font = "600 12px Outfit, sans-serif"; x.fillText(n.label, nx, ny + 30);
      x.fillStyle = muted; x.font = "500 10.5px JetBrains Mono, monospace"; x.fillText(n.sub, nx, ny + 45);
    }
    if (!this.nodes.length) {
      x.fillStyle = muted; x.font = "500 13px Outfit, sans-serif"; x.fillText("No live sessions — agents appear here when people connect", w / 2, h / 2 + 70);
    }
  }
}
