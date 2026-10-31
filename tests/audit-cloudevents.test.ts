import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditEventData, emitAudit } from "../src/audit-cloudevents";
import { EventBus } from "../src/engine/bus";
import { FactoryState } from "../src/state";
import { PlaneStore } from "../dashboard/plane/store";

const row = {
  at: "2026-01-02T03:04:05.000Z",
  actor: "ada",
  role: "owner",
  route: "POST /api/toggles",
  issue: 7,
  status: 200,
};

function bus(sent: { url: string; body: string; type: string }[]) {
  const state = new FactoryState(":memory:");
  const b = new EventBus({
    store: state,
    sinks: [{ url: "https://siem.example/in", secretEnv: "SIEM_SECRET" }],
    source: "factory/acme/widgets",
    env: { SIEM_SECRET: "s" },
    autoDeliver: false,
    fetch: async (url, init) => {
      sent.push({
        url,
        body: String(init.body),
        type: String((init.headers as Record<string, string>)["content-type"]),
      });
      return new Response("ok");
    },
  });
  return b;
}

describe("audit rows as CloudEvents", () => {
  test("a row becomes a signed CloudEvents JSON post to the sink", async () => {
    const sent: { url: string; body: string; type: string }[] = [];
    const b = bus(sent);
    emitAudit(b, row);
    expect(await b.deliver()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe("application/cloudevents+json");
    const ev = JSON.parse(sent[0]!.body);
    expect(ev.specversion).toBe("1.0");
    expect(ev.type).toBe("factory.audit.recorded");
    expect(ev.subject).toBe("POST /api/toggles");
    expect(ev.data).toEqual({ ...row, outcome: "success" });
  });

  test("outcome separates success, refusal and failure", () => {
    expect(auditEventData({ ...row, status: 302 }).outcome).toBe("success");
    expect(auditEventData({ ...row, status: 403 }).outcome).toBe("refused");
    expect(auditEventData({ ...row, status: 500 }).outcome).toBe("failure");
    expect(auditEventData({ ...row, status: 404 }).outcome).toBe("failure");
  });

  test("no bus is a no-op", () => {
    expect(() => emitAudit(undefined, row)).not.toThrow();
  });

  test("PlaneStore.record calls onRecord with the stored row, and a throwing hook does not fail the write", () => {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "audit-ce-"));
    try {
      const store = new PlaneStore(join(dir, "plane.db"));
      const seen: number[] = [];
      store.onRecord.push(() => {
        throw new Error("sink down");
      });
      store.onRecord.push((r) => seen.push(r.id));
      const quiet = console.error;
      console.error = () => {};
      try {
        store.record({ actor: "ada", role: "owner", route: "POST /x", issue: null, status: 200 });
      } finally {
        console.error = quiet;
      }
      expect(seen).toEqual([1]);
      expect(store.audit().map((r) => r.route)).toEqual(["POST /x"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
