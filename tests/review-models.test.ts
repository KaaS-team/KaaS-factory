// The reviewer never runs on the builder's model, and high risk adds a second reviewer.
import { expect, test } from "bun:test";
import { CommandExecutor } from "../src/agents/executor";
import { factRefusals, type PrFacts } from "../src/pr-facts";
import { reviewerModels, reviewModel } from "../src/review-models";

test("the reviewer runs on a different model from the builder, and high risk adds a second", async () => {
  expect(reviewerModels("opus", "low", ["opus", "sonnet", "gpt"])).toEqual(["sonnet"]);
  expect(reviewerModels("opus", "high", ["opus", "sonnet", "gpt"])).toEqual(["sonnet", "gpt"]);
  expect(reviewerModels("opus", "low", ["opus"])).toEqual([]);
  expect(reviewModel("opus", "opus", ["opus", "sonnet"])).toBe("sonnet");
  expect(reviewModel("gpt", "opus", ["gpt"])).toBe("gpt");

  // The executor applies it: verify and build share one agent, so verify swaps to another model.
  const agents = {
    a: { command: ["bash", "-c", 'printf "%s" "$0" > "$OUT"', "{{model}}"], model: "opus", models: { deep: "sonnet" } },
  };
  const out = `${process.env.TMPDIR ?? "/tmp"}/review-model-${crypto.randomUUID()}`;
  const ex = new CommandExecutor(
    agents as never,
    { triage: "a", plan: "a", build: "a", verify: "a", pr: "a" } as never,
  );
  process.env.OUT = out;
  try {
    await ex
      .runStage({ stage: "verify", prompt: "", cwd: process.env.TMPDIR ?? "/tmp" } as never)
      .catch(() => undefined);
    expect(await Bun.file(out).text()).toBe("sonnet");
  } finally {
    delete process.env.OUT;
  }

  const facts = (reviewers: { model: string; blockers: number }[], level = "low") =>
    ({
      tamper: [],
      ui: {},
      risk: { level, blastRadius: { owners: [], protected: [] } },
      review: { builderModel: "opus", reviewers },
    }) as unknown as PrFacts;
  const sevens = (f: PrFacts) =>
    factRefusals(f, "full")
      .filter((r) => r.detail.startsWith("7:"))
      .map((r) => r.detail);
  expect(sevens(facts([{ model: "opus", blockers: 0 }]))).toEqual(["7: 0 reviewers on another model, 1 needed"]);
  expect(sevens(facts([{ model: "sonnet", blockers: 0 }]))).toEqual([]);
  expect(sevens(facts([{ model: "sonnet", blockers: 0 }], "high"))).toEqual([
    "7: 1 reviewers on another model, 2 needed",
  ]);
});
