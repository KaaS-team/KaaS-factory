import { expect, test } from "bun:test";
import { validateManifest } from "../src/extension/manifest";

const base = {
  apiVersion: "factory.extension/v1",
  name: "acme-qa",
  fills: { capability: "qa" },
  inputs: ["diff", "plan"],
  timeout: "5m",
  retries: 1,
  cost: { maxUsd: 2 },
};
const check = { ...base, transport: { kind: "github-check", name: "acme", app: "acme-app" } };
const http = (url: string, extra: object = {}) => ({ ...base, ...extra, transport: { kind: "http", url } });
const problemsOf = (raw: unknown) => {
  const r = validateManifest(raw);
  if (r.ok) throw new Error("expected the manifest to fail");
  return r.problems;
};

test("a valid github-check manifest and a valid http manifest both validate and return timeoutMs", () => {
  const a = validateManifest(check);
  expect(a.ok).toBe(true);
  if (a.ok) {
    expect(a.manifest.timeoutMs).toBe(300_000);
    expect(a.manifest.blocking).toBe(true);
  }
  const b = validateManifest({ ...http("https://example.com/x"), timeout: "30s" });
  expect(b.ok).toBe(true);
  if (b.ok) expect(b.manifest.timeoutMs).toBe(30_000);
});

test("a github-check transport without its app fails", () => {
  const p = problemsOf({ ...base, transport: { kind: "github-check", name: "acme" } });
  expect(p).toEqual(["transport.app is required when transport.kind is github-check."]);
});

test("a tokenEnv outside FACTORY_EXT_ fails and a FACTORY_EXT_ one passes", () => {
  const p = problemsOf(http("https://example.com/x", { tokenEnv: "GH_TOKEN" }));
  expect(p.length).toBe(1);
  expect(p[0]?.startsWith("tokenEnv must be")).toBe(true);
  expect(problemsOf(http("https://example.com/x", { secretEnv: "GH_TOKEN" }))[0]?.startsWith("secretEnv")).toBe(true);
  expect(validateManifest(http("https://example.com/x", { tokenEnv: "FACTORY_EXT_ACME_TOKEN" })).ok).toBe(true);
});

test("merge, an unknown input and retries of 9 each fail", () => {
  const url = "https://example.com/x";
  expect(problemsOf({ ...http(url), fills: { capability: "merge" } })[0]).toContain("merge stays with the runner");
  expect(problemsOf(http(url, { inputs: ["diff", "secrets"] }))[0]?.startsWith("inputs names secrets")).toBe(true);
  expect(problemsOf(http(url, { retries: 9 }))[0]?.startsWith("retries must")).toBe(true);
});

test("a plain http url fails while loopback http and https pass", () => {
  expect(problemsOf(http("http://example.com/x"))[0]?.startsWith("transport.url must be https")).toBe(true);
  expect(validateManifest(http("http://127.0.0.1:9/x")).ok).toBe(true);
  expect(validateManifest(http("http://localhost:9/x")).ok).toBe(true);
  expect(validateManifest(http("http://[::1]:9/x")).ok).toBe(true);
  expect(validateManifest(http("https://example.com/x")).ok).toBe(true);
});

test("every problem is one plain sentence naming the dotted field, and nothing throws", () => {
  const bad = {
    apiVersion: "v2",
    name: "Bad Name",
    fills: {},
    transport: { kind: "ftp" },
    inputs: "x",
    timeout: "5h",
    retries: -1,
    cost: { maxUsd: -1 },
    blocking: "yes",
    tokenEnv: "X",
  };
  const p = problemsOf(bad);
  expect(p.length).toBe(10);
  const fields = [
    "apiVersion",
    "name",
    "fills.capability",
    "transport.kind",
    "inputs",
    "timeout",
    "retries",
    "cost.maxUsd",
    "blocking",
    "tokenEnv",
  ];
  fields.forEach((f, i) => {
    expect(p[i]?.startsWith(f)).toBe(true);
    expect(p[i]?.endsWith(".")).toBe(true);
  });
  for (const junk of [null, 7, "x", [], undefined]) expect(validateManifest(junk).ok).toBe(false);
});
