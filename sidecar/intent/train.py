"""Train and judge the TenAI intent gate: TF-IDF word+char n-grams + calibrated linear SVM.

A model is judged on the fixed GOLDEN exam (hand-written, never trained on) and on a held-out slice of
human labels from the dashboard inbox. It may only go live when it clears the gates:
out-of-scope recall >= 0.95, code false-refusal <= 0.05 on GOLDEN (one miss in 33 code prompts), and no worse than live on the label exam.
Usage (bootstrap v1): .venv/bin/python train.py [out=model.joblib]
"""
import hashlib
import sys

import joblib
from sklearn.calibration import CalibratedClassifierCV
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.pipeline import FeatureUnion, Pipeline
from sklearn.svm import LinearSVC

from seeds import GOLDEN, generate

THRESHOLD = 0.6
LABELS = ("code_task", "code_question", "out_of_scope")
HUMAN_WEIGHT = 3  # a human label counts as three seeds: real prompts beat templates
EXAM_MIN = 20     # below this many labels every label trains; holding out 1 of 3 would just waste it


def build():
    features = FeatureUnion([
        ("word", TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, min_df=1, lowercase=True)),
        ("char", TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), sublinear_tf=True, min_df=2, lowercase=True)),
    ])
    return Pipeline([("f", features), ("clf", CalibratedClassifierCV(LinearSVC(C=0.8, class_weight="balanced"), cv=5))])


def decide(model, text):
    """The gate's real question is code vs not: score a code label by P(code_task)+P(code_question),
    so task/question ambiguity never reads as low confidence and refuses an engineer."""
    p = dict(zip(model.classes_, map(float, model.predict_proba([text])[0])))
    code = p["code_task"] + p["code_question"]
    if p["out_of_scope"] > code:
        return "out_of_scope", p["out_of_scope"], p
    return ("code_task" if p["code_task"] >= p["code_question"] else "code_question"), code, p


def in_exam(text: str) -> bool:
    """Deterministic 25% of human labels are kept out of training to judge versions on real prompts."""
    return int(hashlib.sha256(text.strip().lower().encode()).hexdigest(), 16) % 4 == 0


GOLDEN_TEXTS = {t.strip().lower() for t, _ in GOLDEN}


def split_labels(labels):
    # a label that IS a golden-exam prompt never trains: it would grade the model on its own homework
    clean = [(t, l) for t, l in labels if l in LABELS and t.strip() and t.strip().lower() not in GOLDEN_TEXTS]
    if len(clean) < EXAM_MIN:
        return clean, []
    return [x for x in clean if not in_exam(x[0])], [x for x in clean if in_exam(x[0])]


def train(labels=()):
    train_labels, _ = split_labels(labels)
    data = generate() + [x for x in train_labels for _ in range(HUMAN_WEIGHT)]
    X, y = [t for t, _ in data], [l for _, l in data]
    skipped = sum(1 for t, _ in labels if t.strip().lower() in GOLDEN_TEXTS)
    return build().fit(X, y), {"seeds": len(generate()), "human_labels": len(train_labels), "skipped_golden": skipped}


def evaluate(model, items):
    """Allowed-vs-refused accuracy; that decision is what an engineer feels."""
    oos = oos_caught = code = code_refused = right = 0
    misses = []
    for text, gold in items:
        label, score, _ = decide(model, text)
        allowed = label != "out_of_scope" and score >= THRESHOLD
        want = gold != "out_of_scope"
        right += allowed == want
        if want:
            code += 1
            code_refused += not allowed
        else:
            oos += 1
            oos_caught += not allowed
        if allowed != want:
            misses.append({"text": text, "gold": gold, "label": label, "score": round(score, 3)})
    n = len(items)
    return {
        "n": n, "accuracy": round(right / n, 4) if n else None,
        "oos_recall": round(oos_caught / oos, 4) if oos else None,
        "false_refusal": round(code_refused / code, 4) if code else None,
        "misses": misses[:20],
    }


def gates(cand_golden, cand_exam, live_exam):
    out = [
        {"name": "Catches off-topic (golden)", "want": ">= 95%", "got": cand_golden["oos_recall"], "ok": (cand_golden["oos_recall"] or 0) >= 0.95},
        {"name": "Refuses code rarely (golden)", "want": "<= 5%", "got": cand_golden["false_refusal"], "ok": (cand_golden["false_refusal"] or 0) <= 0.05},
    ]
    if cand_exam["n"]:
        ok = live_exam is None or (cand_exam["accuracy"] or 0) >= (live_exam["accuracy"] or 0)
        want = f">= {live_exam['accuracy'] * 100:.1f}%" if live_exam and live_exam["accuracy"] is not None else "any"
        out.append({"name": "Real prompts ≥ live (label exam)", "want": want, "got": cand_exam["accuracy"], "ok": ok})
    return out


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "model.joblib"
    model, info = train()
    g = evaluate(model, GOLDEN)
    print(f"train={info['seeds']}  golden n={g['n']} acc={g['accuracy']} oos_recall={g['oos_recall']} false_refusal={g['false_refusal']}")
    for m in g["misses"]:
        print("  miss:", m)
    if (g["oos_recall"] or 0) < 0.95 or (g["false_refusal"] or 0) > 0.05:
        print("NOT SHIPPED: golden bars not met")
        sys.exit(1)
    joblib.dump({"model": model, "threshold": THRESHOLD, "version": 1}, out)
    print(f"saved {out}")


if __name__ == "__main__":
    main()
