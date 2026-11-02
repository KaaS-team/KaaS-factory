import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { copySources, touchesImage } from "../scripts/docker-inputs";

const ROOT = join(import.meta.dir, "..");
const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
const sources = copySources(dockerfile);

test("docs and tests-only changes do not touch the image", () => {
  expect(touchesImage(["docs/agents.md", "tests/x.test.ts"], sources)).toBe(false);
});

test("lockfile and docker paths touch the image", () => {
  expect(touchesImage(["bun.lock"], sources)).toBe(true);
  expect(touchesImage(["Dockerfile"], sources)).toBe(true);
});

test("src and copied tree roots touch the image", () => {
  expect(touchesImage(["src/x.ts"], sources)).toBe(true);
  expect(touchesImage(["relay/x"], sources)).toBe(true);
});

test("copySources lists Dockerfile and dockerignore with COPY paths", () => {
  expect(sources.includes("Dockerfile")).toBe(true);
  expect(sources.includes(".dockerignore")).toBe(true);
  expect(sources.includes("src")).toBe(true);
});
