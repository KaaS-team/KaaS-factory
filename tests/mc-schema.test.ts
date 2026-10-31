import { describe, expect, test } from "bun:test";
import { fromRunStatus, schemaProblem, SESSION_EVENT_SCHEMA, SESSION_SCHEMA, SESSION_STATES } from "../src/mc/schema";
import type { AgentSession, SessionState } from "../src/ports/session";
import type { RunStatus } from "../src/state";

const row = (): AgentSession => ({
  ref: { runtime: "factory", connection: "local", externalId: "1" },
  title: "fix the bug",
  state: "running",
  startedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:01Z",
  costUsd: null,
});

describe("session schema", () => {
  test("state enum and SessionState agree both ways", () => {
    const props = SESSION_SCHEMA.properties as { state: { enum: string[] } };
    const all: Record<SessionState, true> = {
      queued: true,
      running: true,
      waiting: true,
      succeeded: true,
      failed: true,
      cancelled: true,
      unknown: true,
    };
    expect([...props.state.enum].sort()).toEqual(Object.keys(all).sort());
    expect([...SESSION_STATES].sort() as string[]).toEqual(Object.keys(all).sort());
  });

  test("a good row fits", () => {
    expect(schemaProblem(SESSION_SCHEMA, row())).toBeUndefined();
  });

  test("an unknown key fails, in the row and in its ref", () => {
    expect(schemaProblem(SESSION_SCHEMA, { ...row(), transcript: "x" })).toContain("transcript");
    const r = row();
    expect(schemaProblem(SESSION_SCHEMA, { ...r, ref: { ...r.ref, host: "h" } })).toContain("host");
  });

  test("a 201-character title fails and 200 fits", () => {
    expect(schemaProblem(SESSION_SCHEMA, { ...row(), title: "x".repeat(201) })).toContain("200");
    expect(schemaProblem(SESSION_SCHEMA, { ...row(), title: "x".repeat(200) })).toBeUndefined();
  });

  test("an event text over 280 characters fails", () => {
    const e = { ref: row().ref, at: "t", kind: "note", text: "x".repeat(281) };
    expect(schemaProblem(SESSION_EVENT_SCHEMA, e)).toContain("280");
    expect(schemaProblem(SESSION_EVENT_SCHEMA, { ...e, text: "ok" })).toBeUndefined();
  });

  test("every run status maps to a state", () => {
    const statuses: RunStatus[] = [
      "running",
      "needs-info",
      "awaiting-approval",
      "verifying",
      "rejected",
      "shipped",
      "failed",
      "needs-human",
      "cancelled",
    ];
    for (const s of statuses) expect(SESSION_STATES).toContain(fromRunStatus(s));
    expect(fromRunStatus("verifying")).toBe("running");
    expect(fromRunStatus("needs-human")).toBe("waiting");
    expect(fromRunStatus("shipped")).toBe("succeeded");
    expect(fromRunStatus("rejected")).toBe("failed");
  });
});
