// Ported from owainlewis/assembler@7cac671 test/runtime.test.ts:9-17,54-57 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: validateConfig throws one error and here configProblems lists all of them; "argument input requires {prompt}" has no equivalent (a command with no placeholder gets the prompt on stdin); the prompt is checked through renderCommand and Bun.spawn instead of execute().

import { expect, test } from "bun:test";
import { configProblems } from "../../../src/config";
import { renderCommand } from "../../../src/agents/executor";

const cfg = (agents: object, stages: object = {}) => configProblems({ repo: "a/b", agents, stages });

test("prompts remain literal arguments, including shell syntax", async () => {
  const prompt = '`touch bad` $(echo bad) "quotes"\nline';
  const { argv, usesStdin } = renderCommand([process.execPath, "-e", "console.log(process.argv[1])", "{{prompt}}"], {
    prompt,
    promptFile: "",
    model: "",
  });
  expect(usesStdin).toBe(false);
  const proc = Bun.spawn(argv, { stdout: "pipe" });
  expect((await new Response(proc.stdout).text()).trim()).toBe(prompt);
});

test("invalid agent configuration fails before execution", () => {
  expect(cfg({ x: { command: ["x"] } }, { default: "missing" }).join("\n")).toMatch(/not an agent in config\.agents/);
  expect(cfg({ x: { command: ["{{prompt}}"] } }).join("\n")).toMatch(/executable cannot be a placeholder/);
  expect(cfg({ x: { command: [] } }).join("\n")).toMatch(/must not be empty/);
  expect(cfg({ x: { command: ["  "] } }).join("\n")).toMatch(/executable must not be empty/);
  expect(cfg({ x: {} }).join("\n")).toMatch(/needs a "preset" or a "command"/);
  expect(cfg({ x: { command: ["sh", "-c", "{{prompt}}"] } }).join("\n")).toMatch(/must not be an argument of a shell/);
});
