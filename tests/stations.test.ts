// The Line view's blocks, from dashboard/public/lib/stations.js.
import { describe, expect, test } from "bun:test";
import { stationStates } from "../dashboard/public/lib/stations.js";

const attempt = (stage: string, ok: boolean) => ({ stage, agent: "claude", duration_ms: 1000, cost_usd: 0, ok });
const pick = (run: { stage: string; status: string }, stages: ReturnType<typeof attempt>[]) =>
  Object.fromEntries(stationStates(run, stages).map((s) => [s.name, s.done ? "done" : s.failed ? "failed" : s.live ? "live" : ""]));

describe("stationStates", () => {
  test("a triage that refused the issue and parked it fills its block", () => {
    expect(pick({ stage: "triage", status: "needs-human" }, [attempt("triage", true)]).triage).toBe("done");
  });

  test("a plan awaiting approval is done; build has not started", () => {
    expect(pick({ stage: "plan", status: "awaiting-approval" }, [attempt("triage", true), attempt("plan", true)])).toMatchObject({ triage: "done", plan: "done", build: "" });
  });

  test("only the block where the run stopped for a person is waiting", () => {
    const waiting = (run: { stage: string; status: string }, stages: ReturnType<typeof attempt>[]) => stationStates(run, stages).filter((s) => s.waiting).map((s) => s.name);
    expect(waiting({ stage: "plan", status: "awaiting-approval" }, [attempt("triage", true), attempt("plan", true)])).toEqual(["plan"]);
    expect(waiting({ stage: "verify", status: "needs-human" }, [attempt("build", true), attempt("verify", false)])).toEqual([]);
    expect(waiting({ stage: "build", status: "running" }, [attempt("build", true)])).toEqual([]);
  });

  test("a verify that parked without a pass is failed, not empty", () => {
    expect(pick({ stage: "verify", status: "needs-human" }, [attempt("build", true), attempt("verify", false)]).verify).toBe("failed");
  });

  test("a running stage is live, not done", () => {
    expect(pick({ stage: "build", status: "running" }, [attempt("build", true)]).build).toBe("live");
  });
});
