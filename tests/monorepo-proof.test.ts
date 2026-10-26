// In a monorepo the proof runs the top-level test gate and the test gate of every package touched.
import { expect, test } from "bun:test";
import { proofCommand } from "../src/proof";

test("the proof in a monorepo runs the touched package's test gate, not only the top-level one", () => {
  const gates = [{ name: "test", cmd: "bun test", role: "test" as const, required: true }];
  const packages = [
    { path: "packages/api", gates: [{ name: "test", cmd: "go test ./...", role: "test" as const, required: true }] },
    { path: "packages/web", gates: [{ name: "test", cmd: "npm test", role: "test" as const, required: true }] },
    { path: "packages/docs", gates: [] },
  ];
  expect(proofCommand(gates, packages, ["packages/api/main.go"])).toBe(
    "bun test && (cd 'packages/api' && go test ./...)",
  );
  expect(proofCommand(gates, packages, ["README.md"])).toBe("bun test");
  expect(proofCommand([], packages, ["packages/web/a.ts", "packages/docs/x.md"])).toBe(
    "(cd 'packages/web' && npm test)",
  );
  expect(proofCommand([], [], ["a"])).toBeUndefined();
});
