// The watcher survives a poll whose fetch times out: it logs the failure and polls again (#186).

import { describe, expect, test } from "bun:test";
import { mergeConfig } from "../src/config";
import { GitHub, type GhIssue, type GhPr } from "../src/github";
import { FactoryState } from "../src/state";
import { startWatch } from "../src/watch";

class TimingOutGh extends GitHub {
  polls = 0;
  override async listPrs(): Promise<GhPr[]> {
    this.polls++;
    if (this.polls === 1) throw new DOMException("The operation timed out.", "TimeoutError");
    return [];
  }
  override async listIssuesByLabel(): Promise<GhIssue[]> {
    return [];
  }
  override async listIssuesByLabels(): Promise<Map<string, GhIssue[]>> {
    return new Map();
  }
  override async listOpenIssues(): Promise<GhIssue[]> {
    return [];
  }
}

describe("startWatch and a network timeout", () => {
  test("a poll that times out is logged and the next poll still runs", async () => {
    const github = new TimingOutGh();
    const state = new FactoryState(":memory:");
    const config = mergeConfig({ repo: "acme/widgets", pollIntervalSeconds: 3600 });
    const logged: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    const ticks: unknown[] = [];
    const stop = startWatch({ github, state } as never, config, (r) => ticks.push(r), 10);
    try {
      await Bun.sleep(50);
      expect(github.polls).toBe(1);
      expect(logged.some((a) => String(a[0]).includes("poll failed"))).toBe(true);
      state.recordDelivery({ id: "x", event: "issues", action: "labeled", repo: "acme/widgets" });
      await Bun.sleep(50);
      expect(github.polls).toBe(2);
      expect(ticks).toHaveLength(1);
    } finally {
      console.error = realError;
      stop();
    }
  });
});
