import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CAPABILITIES, checkValue, registryProblems, SETTINGS, settingByKey } from "../src/settings/registry";

test("the shipped registry has no problems", () => {
  expect(registryProblems()).toEqual([]);
});

test("checkValue names the allowed modes for a bad value and accepts a good one", () => {
  const bad = checkValue("capabilities.review.mode", "sometimes");
  expect(bad.length).toBe(1);
  for (const m of ["off", "byo", "ours"]) expect(bad[0]).toContain(m);
  expect(bad[0]).toContain("capabilities.review.mode");
  expect(checkValue("capabilities.review.mode", "byo")).toEqual([]);
});

test("every capability has a mode and a provider key", () => {
  for (const c of CAPABILITIES) {
    expect(settingByKey(`capabilities.${c}.mode`)?.storage).toBe("file");
    expect(settingByKey(`capabilities.${c}.provider`)?.type).toBe("string");
  }
});

test("every toggle the dashboard server accepts is a runtime entry", () => {
  const src = readFileSync(new URL("../dashboard/server.ts", import.meta.url), "utf8");
  const runtime = SETTINGS.filter((s) => s.storage === "runtime");
  for (const name of ["auto_start", "auto_approve_low_risk"]) {
    expect(src.includes(name)).toBe(true);
    expect(settingByKey(`toggles.${name}`)?.storage).toBe("runtime");
  }
  expect(src.split("getToggle(").length - 1).toBe(runtime.length);
});

test("a duplicated key is named", () => {
  const first = SETTINGS[0];
  if (!first) throw new Error("empty registry");
  const problems = registryProblems([...SETTINGS, first]);
  expect(problems.some((p) => p.includes(first.key) && p.includes("twice"))).toBe(true);
});

test("a ceiling that points nowhere is reported", () => {
  const list = SETTINGS.filter((s) => s.kind !== "policy");
  expect(registryProblems(list).some((p) => p.includes("ceiling"))).toBe(true);
});

test("a capability without a mode key is reported", () => {
  const list = SETTINGS.filter((s) => s.key !== "capabilities.qa.mode");
  expect(registryProblems(list).some((p) => p.includes("qa"))).toBe(true);
});
