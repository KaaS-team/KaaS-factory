import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryConfig } from "../src/config";
import {
  decide,
  type Evidence,
  HEAD_RUNS,
  newTestFiles,
  type PromotionDeps,
  promote,
  recordPromotion,
} from "../src/promotion";
import type { ProofGit, ProofResult } from "../src/proof";

type Change = { status: string; path: string };

// Fake git: `head` is the exit code of the test on head (one per call), `onBase` the exit code with the implementation reverted.
function fakes(
  changes: Change[],
  opts: { head?: number[]; onBase?: number; mutants?: { mutants: number; survived: string[] } } = {},
) {
  const head = [...(opts.head ?? [0, 0, 0])];
  let reverted = false;
  const git: ProofGit = {
    changes: async () => changes,
    restoreFromBase: async () => {
      reverted = true;
    },
    remove: async () => {
      reverted = true;
    },
    restoreHead: async () => {
      reverted = false;
    },
    dirty: async () => [],
    test: async () => ({ stdout: "", stderr: "", code: reverted ? (opts.onBase ?? 1) : (head.shift() ?? 0) }),
  };
  const deps: PromotionDeps = {
    git,
    mutants: async () => opts.mutants ?? { mutants: 2, survived: ["src/a.ts:1"] },
    diff: async () => "",
  };
  return deps;
}

const CHANGES: Change[] = [
  { status: "A", path: "src/a.ts" },
  { status: "A", path: "tests/a.test.ts" },
];

const run = (deps: PromotionDeps) => promote(deps, "/w", "main", "bun test");

describe("promote", () => {
  test("passes three times, bites on base, kills one of two mutants: promoted", async () => {
    const [r] = await run(fakes(CHANGES));
    expect(r?.decision).toBe("promote");
    expect(r?.evidence).toMatchObject({
      file: "tests/a.test.ts",
      headPasses: 3,
      failsOnBase: true,
      mutants: 2,
      survived: 1,
    });
  });

  test("one failure on head: delete", async () => {
    expect((await run(fakes(CHANGES, { head: [0, 1, 0] })))[0]?.decision).toBe("delete");
  });

  test("passes on base: delete", async () => {
    expect((await run(fakes(CHANGES, { onBase: 0 })))[0]?.decision).toBe("delete");
  });

  test("kills no mutant: delete", async () => {
    const m = { mutants: 2, survived: ["a:1", "b:2"] };
    expect((await run(fakes(CHANGES, { mutants: m })))[0]?.decision).toBe("delete");
  });

  test("no mutable line promotes on the other three", async () => {
    expect((await run(fakes(CHANGES, { mutants: { mutants: 0, survived: [] } })))[0]?.decision).toBe("promote");
  });

  test("the file name is quoted in the command", async () => {
    const seen: string[] = [];
    const deps = fakes([{ status: "A", path: "tests/it's.test.ts" }]);
    const test = deps.git.test;
    deps.git.test = (w, cmd) => {
      seen.push(cmd);
      return test(w, cmd);
    };
    await run(deps);
    expect(seen[0]).toBe("bun test 'tests/it'\\''s.test.ts'");
  });
});

describe("newTestFiles", () => {
  test("a fixture and a modified test are not session tests", () => {
    expect(
      newTestFiles([
        { status: "A", path: "tests/fixtures/data.json" },
        { status: "A", path: "tests/helper.ts" },
        { status: "M", path: "tests/old.test.ts" },
        { status: "A", path: "pkg/test_x.py" },
        { status: "A", path: "tests/new.test.ts" },
      ]),
    ).toEqual(["pkg/test_x.py", "tests/new.test.ts"]);
  });

  test("at most three files are judged", () => {
    const changes = ["a", "b", "c", "d"].map((n) => ({ status: "A", path: `tests/${n}.test.ts` }));
    expect(newTestFiles(changes)).toHaveLength(3);
  });
});

describe("decide", () => {
  const base: Evidence = {
    file: "f",
    headPasses: HEAD_RUNS,
    failsOnBase: true,
    mutants: 0,
    survived: 0,
    seconds: 1,
    layer: "L0",
  };
  test("every condition is needed", () => {
    expect(decide(base)).toBe("promote");
    expect(decide({ ...base, headPasses: 2 })).toBe("delete");
    expect(decide({ ...base, failsOnBase: false })).toBe("delete");
    expect(decide({ ...base, mutants: 1, survived: 1 })).toBe("delete");
  });
});

describe("recordPromotion", () => {
  const config = (fileCmd?: string) =>
    ({
      base: "main",
      gates: [{ name: "test", cmd: "bun test", ...(fileCmd ? { fileCmd } : {}), required: true, role: "test" }],
    }) as unknown as FactoryConfig;
  const proof = (status: ProofResult["status"]): ProofResult => ({
    status,
    reverted: [],
    tests: [],
    cmd: "",
    tail: "",
  });

  test("writes promotion.json when the proof bit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "promotion-"));
    try {
      await recordPromotion(dir, config("bun test"), 7, proof("bites"), fakes(CHANGES));
      const file = join(dir, ".factory/runs/issue-7/promotion.json");
      expect(JSON.parse(readFileSync(file, "utf8")).decisions[0].decision).toBe("promote");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writes nothing when the proof did not bite or there is no fileCmd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "promotion-"));
    try {
      await recordPromotion(dir, config("bun test"), 7, proof("passes-without"), fakes(CHANGES));
      await recordPromotion(dir, config(), 7, proof("bites"), fakes(CHANGES));
      expect(existsSync(join(dir, ".factory"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
