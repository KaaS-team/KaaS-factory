import { expect, test } from "bun:test";
import { checkResidency, residencyRecord } from "../src/residency";

const EU = "bedrock-runtime.eu-west-1.amazonaws.com";
const US = "bedrock-runtime.us-east-1.amazonaws.com";
const NONE = "api.example.com";

test("eu accepts an eu host and rejects a us host", () => {
  expect(checkResidency("eu", EU)).toEqual({ ok: true, region: "eu-west-1" });
  expect(checkResidency("eu", US).ok).toBe(false);
});

test("us accepts a us host and rejects an eu host", () => {
  expect(checkResidency("us", US)).toEqual({ ok: true, region: "us-east-1" });
  expect(checkResidency("us", EU).ok).toBe(false);
});

test("eu rejects a host with no region label", () => {
  const r = checkResidency("eu", NONE);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("api.example.com names no region, so eu cannot be shown");
});

test("any accepts all three", () => {
  for (const h of [EU, US, NONE]) expect(checkResidency("any", h).ok).toBe(true);
});

test("residencyRecord holds the region and no model field", () => {
  const rec = residencyRecord(EU, "eu");
  expect(rec).toEqual({ policy: "eu", host: EU, region: "eu-west-1" });
  expect(Object.keys(rec)).not.toContain("model");
});
