// An installation token is minted for one repo: the request body names it, each repo caches its own,
// the owner-wide listing token carries no repository list, and concurrent callers share one mint.

import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GitHubApp } from "../src/github-app";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function setup() {
  const posts: { path: string; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (path.endsWith("/installation")) return reply({ id: 7 });
    if (path === "/app/installations") return reply([{ id: 7, account: { login: "o" } }]);
    if (path === "/installation/repositories") return reply({ repositories: [] });
    if (path === "/app/installations/7/access_tokens") {
      const raw = init?.body;
      posts.push({ path, body: typeof raw === "string" ? JSON.parse(raw) : "no body" });
      return reply({ token: `tok-${posts.length}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    return reply({}, 404);
  }) as typeof globalThis.fetch;
  return { posts, app: new GitHubApp({ appId: "1", privateKey: PEM, owners: ["o"], fetch }) };
}

test("a repo token is minted with its one repository named", async () => {
  const { app, posts } = setup();
  await app.tokenFor("o/r");
  expect(posts.map((p) => p.body)).toEqual([{ repositories: ["r"] }]);
});

test("two repos under one owner mint two tokens, the same repo twice mints once", async () => {
  const { app, posts } = setup();
  const a = await app.tokenFor("o/r");
  const b = await app.tokenFor("o/s");
  const again = await app.tokenFor("o/r");
  expect(a).not.toBe(b);
  expect(again).toBe(a);
  expect(posts.map((p) => p.body)).toEqual([{ repositories: ["r"] }, { repositories: ["s"] }]);
});

test("listing installed repos posts no repositories field", async () => {
  const { app, posts } = setup();
  await app.installedRepos();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toBe("no body");
});

test("concurrent callers for one repo share one mint", async () => {
  const { app, posts } = setup();
  const [a, b] = await Promise.all([app.tokenFor("o/r"), app.tokenFor("o/r")]);
  expect(a).toBe(b);
  expect(posts).toHaveLength(1);
});
