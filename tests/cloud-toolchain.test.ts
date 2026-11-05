// The cloud brief names the target repo's own commands, and a launch is refused without a gate or seed branch (#624).
import { expect, test } from "bun:test";
import { launchRefusal, NO_GATE_REASON, toolchainLines, toolchainOf } from "../src/cloud/toolchain";

const repo = (files: Record<string, string>) => toolchainOf((p) => files[p]);

test("a bun repo with a Makefile: frozen install, make check, make check-mutations", () => {
  expect(repo({ "bun.lock": "", Makefile: "check:\n\tx\ncheck-mutations:\n\ty\n" })).toEqual({
    install: "bun install --frozen-lockfile",
    gate: "make check",
    mutation: "make check-mutations",
  });
});

test("an npm repo: npm ci and its package.json scripts", () => {
  const t = repo({ "package-lock.json": "{}", "package.json": '{"scripts":{"test":"jest","mutants":"stryker"}}' });
  expect(t).toEqual({ install: "npm ci", gate: "npm run test", mutation: "npm run mutants" });
});

test("a cargo repo: locked fetch and test", () => {
  expect(repo({ "Cargo.lock": "" })).toEqual({
    install: "cargo fetch --locked",
    gate: "cargo test --locked",
    mutation: undefined,
  });
});

test("the repo's own gate config wins over its Makefile", () => {
  expect(repo({ ".agents/repo.json": '{"gate":"just ci"}', Makefile: "check:\n" }).gate).toBe("just ci");
});

test("a repo with no gate is refused with the reason, and the brief lines name only what exists", () => {
  expect(launchRefusal({ toolchain: repo({ "README.md": "x" }) })).toBe(NO_GATE_REASON);
  expect(toolchainLines({ gate: "make check" })).toEqual(["Run `make check` before finishing; it is the repo's gate."]);
});

test("a seed branch must be on the remote", () => {
  const toolchain = { gate: "make check" };
  expect(launchRefusal({ toolchain, seed: { branch: "factory/7", onRemote: false } })).toContain("factory/7");
  expect(launchRefusal({ toolchain, seed: { branch: "factory/7", onRemote: true } }) ?? "may start").toBe("may start");
  expect(launchRefusal({ toolchain }) ?? "may start").toBe("may start");
});
