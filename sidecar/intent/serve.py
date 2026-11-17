"""TenAI intent sidecar with a model registry (loopback only; the TenAI server is its only client).

  POST /classify {"text"}            → live decision {label, score, probs, version} (+ shadow decision if one is staged)
  GET  /health                       → {ok, live, shadow}
  GET  /versions                     → every version with its exam results
  POST /train {"labels": [[text, label], ...], "by"} → train the next version, judge it vs live, save it (never promotes)
  POST /shadow {"version" | null}    → run a version silently next to live on real traffic
  POST /promote {"version", "by"}    → make a version live (only one that passed its gates)

Registry: models/v<N>.joblib + models/v<N>.json (metrics, gates, who/when), models/live.txt, models/shadow.txt.
The server falls back to its own keyword rules when this is down, so a crash here never blocks anyone.
Usage: .venv/bin/python serve.py [bootstrap=model.joblib] [port=8471]
"""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import joblib

from seeds import GOLDEN
from train import THRESHOLD, decide, evaluate, gates, split_labels, train

HERE = Path(__file__).resolve().parent
REG = HERE / "models"
MAX_BODY = 2 * 1024 * 1024
lock = threading.RLock()
loaded: dict[int, object] = {}


def meta(v: int) -> dict:
    return json.loads((REG / f"v{v}.json").read_text())


def versions() -> list[int]:
    return sorted(int(p.stem[1:]) for p in REG.glob("v*.json"))


def pointer(name: str):
    p = REG / f"{name}.txt"
    return int(p.read_text()) if p.exists() and p.read_text().strip() else None


def set_pointer(name: str, v):
    (REG / f"{name}.txt").write_text("" if v is None else str(v))


def model(v: int):
    if v not in loaded:
        loaded[v] = joblib.load(REG / f"v{v}.joblib")["model"]
    return loaded[v]


def bootstrap(path: str):
    """First start: adopt the deployed model.joblib as v1, judged on the golden exam."""
    REG.mkdir(exist_ok=True)
    if versions():
        return
    m = joblib.load(path)["model"]
    joblib.dump({"model": m, "threshold": THRESHOLD, "version": 1}, REG / "v1.joblib")
    g = evaluate(m, GOLDEN)
    (REG / "v1.json").write_text(json.dumps({"version": 1, "created": int(time.time() * 1000), "by": "bootstrap", "golden": g,
                                             "exam": None, "gates": gates(g, {"n": 0}, None), "passed": True, "train": {"human_labels": 0}}))
    set_pointer("live", 1)


def train_next(labels, by):
    with lock:
        live_v = pointer("live")
        m, info = train(labels)
        v = (versions() or [0])[-1] + 1
        _, exam = split_labels(labels)
        g = evaluate(m, GOLDEN)
        cand_exam = evaluate(m, exam)
        live_exam = evaluate(model(live_v), exam) if live_v and exam else None
        live_golden = meta(live_v)["golden"] if live_v else None
        gs = gates(g, cand_exam, live_exam)
        rec = {"version": v, "created": int(time.time() * 1000), "by": by, "train": info, "golden": g, "exam": cand_exam,
               "live_at_train": {"version": live_v, "golden": live_golden, "exam": live_exam}, "gates": gs, "passed": all(x["ok"] for x in gs)}
        joblib.dump({"model": m, "threshold": THRESHOLD, "version": v}, REG / f"v{v}.joblib")
        (REG / f"v{v}.json").write_text(json.dumps(rec))
        loaded[v] = m
        # keep the registry small: live, shadow and the 6 newest
        keep = {pointer("live"), pointer("shadow"), *versions()[-6:]}
        for old in versions():
            if old not in keep:
                (REG / f"v{old}.joblib").unlink(missing_ok=True)
                (REG / f"v{old}.json").unlink(missing_ok=True)
                loaded.pop(old, None)
        return rec


def decision(v, text):
    label, score, probs = decide(model(v), text)
    return {"label": label, "score": round(score, 4), "probs": {k: round(x, 4) for k, x in probs.items()}, "version": v}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        if n <= 0 or n > MAX_BODY:
            raise ValueError("body required (max 2MB)")
        return json.loads(self.rfile.read(n))

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": True, "live": pointer("live"), "shadow": pointer("shadow")})
        if self.path == "/versions":
            return self._send(200, {"live": pointer("live"), "shadow": pointer("shadow"), "versions": [meta(v) for v in reversed(versions())]})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        try:
            b = self._body()
        except (ValueError, json.JSONDecodeError) as e:
            return self._send(400, {"error": str(e)})
        try:
            if self.path == "/classify":
                text = str(b.get("text", ""))[:4000]
                with lock:
                    live, shadow = pointer("live"), pointer("shadow")
                    out = decision(live, text)
                    if shadow and shadow != live:
                        out["shadow"] = decision(shadow, text)
                return self._send(200, out)
            if self.path == "/train":
                labels = [(str(t), str(l)) for t, l in b.get("labels", [])]
                return self._send(200, train_next(labels, str(b.get("by", "?"))))
            if self.path == "/shadow":
                v = b.get("version")
                with lock:
                    if v is not None and int(v) not in versions():
                        return self._send(404, {"error": f"no version {v}"})
                    set_pointer("shadow", None if v is None else int(v))
                return self._send(200, {"ok": True, "shadow": pointer("shadow")})
            if self.path == "/promote":
                v = int(b["version"])
                with lock:
                    if v not in versions():
                        return self._send(404, {"error": f"no version {v}"})
                    if not meta(v)["passed"]:
                        return self._send(409, {"error": f"v{v} did not pass its gates"})
                    prev = pointer("live")
                    model(v)  # load before switching so the first request isn't slow
                    set_pointer("live", v)
                    if pointer("shadow") == v:
                        set_pointer("shadow", None)
                return self._send(200, {"ok": True, "live": v, "previous": prev})
        except Exception as e:  # noqa: BLE001 — report, never die
            return self._send(500, {"error": f"{type(e).__name__}: {e}"})
        self._send(404, {"error": "not found"})

    def log_message(self, *_):  # prompts are code-adjacent text; don't spray them into logs
        pass


if __name__ == "__main__":
    bootstrap(sys.argv[1] if len(sys.argv) > 1 else "model.joblib")
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8471
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
