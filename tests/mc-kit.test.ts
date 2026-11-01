import { describe, expect, test } from "bun:test";
import { adapterKit } from "../src/mc/kit";
import { fakeAdapter } from "../src/mc/fake-adapter";
import type { AgentSession } from "../src/ports/session";

const row = (over: Partial<AgentSession> = {}): AgentSession => ({
  ref: { runtime: "fake", connection: "c", externalId: "1" },
  title: "t",
  state: "running",
  startedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:01Z",
  link: "https://example.com/s/1",
  ...over,
});
const failed = (cs: { name: string; ok: boolean }[]) => cs.filter((c) => !c.ok).map((c) => c.name);

describe("adapter kit", () => {
  test("an honest fake passes", async () => {
    expect(failed(await adapterKit(fakeAdapter([row()], { caps: { cancel: true } })))).toEqual([]);
  });

  test("claiming cancel and throwing SessionUnsupported fails by name", async () => {
    const f = failed(await adapterKit(fakeAdapter([row()], { caps: { cancel: true }, lie: { cancel: true } })));
    expect(f).toEqual(["cancel: flag true matches behaviour"]);
  });

  test("a false verb that throws a plain Error fails", async () => {
    const a = fakeAdapter([row()]);
    a.cancel = async () => {
      throw new Error("boom");
    };
    expect(failed(await adapterKit(a))).toEqual(["cancel: flag false matches behaviour"]);
  });

  test("http links fail", async () => {
    const f = failed(await adapterKit(fakeAdapter([row({ link: "http://example.com/s/1" })])));
    expect(f).toEqual(["a link is https: or absent"]);
  });

  test("a row from another runtime fails", async () => {
    const other = row({ ref: { runtime: "other", connection: "c", externalId: "2" } });
    expect(failed(await adapterKit(fakeAdapter([other])))).toEqual(["every ref.runtime equals the adapter kind"]);
  });

  test("a row with an invented key fails the schema", async () => {
    const bad = { ...row(), transcript: "x" } as AgentSession;
    expect(failed(await adapterKit(fakeAdapter([bad])))).toContain(
      "list answers within 10 s and every row fits the schema",
    );
  });
});
