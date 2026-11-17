import { describe, expect, test } from "bun:test";
import { canonical, make, parsePrompt, sign, toPrompt, verify } from "../src/index";
import vectors from "./vectors.json";

describe("AMP/1 — byte-identical with the Python hub", () => {
  for (const c of vectors.cases) {
    test(`canonical + sig match Python for ${c.env.id}`, () => {
      expect(canonical(c.env as never)).toBe(c.canonical);
      expect(sign(c.env as never, vectors.secret)).toBe(c.sig);
    });
  }

  test("make() produces a verifiable envelope; tampering breaks it", () => {
    const env = make("alex", "orchestrator", "claim.files", { text: "x", paths: ["A.java"] }, "s3cret", { token: "tok_1" });
    expect(verify(env, "s3cret")).toBe(true);
    expect(verify(env, "wrong")).toBe(false);
    expect(verify({ ...env, body: { text: "y" } }, "s3cret")).toBe(false);
    // token is not part of the signature
    expect(verify({ ...env, token: "other" }, "s3cret")).toBe(true);
  });

  test("prompt form round-trips type, intent and text", () => {
    const env = make("a", "b", "plan.feature", "add a flag", "s");
    const [parsed] = parsePrompt("noise " + toPrompt(env) + " more");
    expect(parsed).toEqual({ type: "REQUEST", intent: "plan.feature", body: { text: "add a flag" } });
  });
});

test("an undefined member signs like the JSON that is actually sent", () => {
  const { canonical } = require("../src/index");
  const withUndef = canonical({ intent: "session.open", body: { type: "session.open", repo: "r", title: undefined } } as never);
  const sent = canonical(JSON.parse(JSON.stringify({ intent: "session.open", body: { type: "session.open", repo: "r", title: undefined } })));
  expect(withUndef).toBe(sent);
});
