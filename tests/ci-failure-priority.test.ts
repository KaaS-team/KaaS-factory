import { describe, expect, test } from "bun:test";
import {
  type BumpOptions,
  type CiFailure,
  DEFAULT_BUMP,
  groupFailures,
  orderByBump,
  priorityBumps,
} from "../src/ci-failure-priority";
import { dispatchJobs } from "../src/dispatch";
import { mergeConfig } from "../src/config";
import { LABEL } from "../src/labels";
import { FactoryState } from "../src/state";
import { baseIssue, FakeGitHub } from "./harness";

const NOW = 1_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const opts: BumpOptions = { ...DEFAULT_BUMP, now: NOW };
const fail = (check: string, error: string, daysAgo = 1): CiFailure => ({ check, error, at: NOW - daysAgo * DAY });

describe("grouping CI failures", () => {
  test("groups by check and error, ignoring case and spacing, and drops failures outside the window", () => {
    const groups = groupFailures(
      [
        fail("Mutations", "find matches twice"),
        fail("mutations", "Find  matches twice"),
        fail("mutations", "timeout"),
        fail("mutations", "find matches twice", 30),
      ],
      opts,
    );
    expect([...groups]).toEqual([
      ["mutations\nfind matches twice", 2],
      ["mutations\ntimeout", 1],
    ]);
  });

  test("one level per perLevel failures of the same check and error, capped, only for issues naming the check", () => {
    const failures = [
      ...Array.from({ length: 6 }, () => fail("mutations", "find matches twice")),
      ...Array.from({ length: 3 }, () => fail("lint", "format")),
      fail("typecheck", "TS2322"),
    ];
    const issues = [
      { number: 168, text: "Mutation conflicts: the mutations check fails" },
      { number: 187, text: "lint is flaky" },
      { number: 200, text: "typecheck error" },
      { number: 201, text: "unrelated" },
    ];
    expect(priorityBumps(failures, issues, opts)).toEqual(
      new Map([
        [168, 2],
        [187, 1],
      ]),
    );
    expect(priorityBumps(failures, issues, { ...opts, maxLevels: 1 }).get(168)).toBe(1);
  });
});

describe("scheduler ordering", () => {
  test("orderByBump puts bumped jobs first and keeps issue order among equals", () => {
    const jobs = [{ issue: 1 }, { issue: 2 }, { issue: 3 }];
    expect(orderByBump(jobs, new Map())).toEqual(jobs);
    expect(orderByBump(jobs, new Map([[3, 2]])).map((j) => j.issue)).toEqual([3, 1, 2]);
  });

  test("dispatchJobs runs the bumped issue before a lower-numbered one", async () => {
    const github = new FakeGitHub([baseIssue(2, [LABEL.ready]), baseIssue(9, [LABEL.ready])]);
    const state = new FactoryState(":memory:");
    const config = mergeConfig({ repo: "acme/widgets", maxOpenFactoryPrs: 3 });
    const plain = await dispatchJobs({ github, state }, config);
    expect(plain.jobs.map((j) => j.issue)).toEqual([2, 9]);
    const bumped = await dispatchJobs({ github, state }, config, new Map([[9, 1]]));
    expect(bumped.jobs.map((j) => j.issue)).toEqual([9, 2]);
  });
});
