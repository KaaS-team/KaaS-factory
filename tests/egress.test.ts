// The egress proxy: deny by default, and a key the guest never holds reaches only its own hosts.
import { describe, expect, test } from "bun:test";
import { startEgressProxy } from "../src/egress";
import { CAPABILITIES } from "../src/sandbox";
import { containerArgs } from "../src/adapters/docker/execution";
import { sandboxArgs } from "../src/adapters/microsandbox/execution";

describe("egress proxy", () => {
  test("denies every host off the list, and swaps a key in only toward that key's hosts", async () => {
    const seen: { host: string; auth: string | null; path: string }[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        seen.push({ host: url.pathname.split("/")[1]!, auth: req.headers.get("authorization"), path: url.pathname });
        return new Response("upstream-ok");
      },
    });
    const proxy = startEgressProxy({
      allow: ["registry.npmjs.org"],
      secrets: ["MODEL_KEY@api.model.test"],
      env: { MODEL_KEY: "sk-real-value" },
      upstream: (host) => `http://127.0.0.1:${upstream.port}/${host}`,
    });
    try {
      const placeholder = proxy.guestEnv.MODEL_KEY!;
      expect(placeholder).not.toContain("sk-real-value");
      expect(JSON.stringify(proxy.guestEnv)).not.toContain("sk-real-value");

      const ok = await fetch(`${proxy.url}/api.model.test/v1/messages?x=1`, {
        headers: { authorization: `Bearer ${placeholder}` },
      });
      expect(await ok.text()).toBe("upstream-ok");
      expect(seen.at(-1)).toEqual({
        host: "api.model.test",
        auth: "Bearer sk-real-value",
        path: "/api.model.test/v1/messages",
      });

      const npm = await fetch(`${proxy.url}/registry.npmjs.org/left-pad`);
      expect(npm.status).toBe(200);
      const exfil = await fetch(`${proxy.url}/registry.npmjs.org/x`, { headers: { authorization: placeholder } });
      expect(exfil.status).toBe(403);
      const body = await fetch(`${proxy.url}/api.model.test/v1`, { method: "POST", body: `leak ${placeholder}` });
      expect(body.status).toBe(403);
      const other = await fetch(`${proxy.url}/evil.test/collect`);
      expect(other.status).toBe(403);
      expect(seen.map((s) => s.host)).toEqual(["api.model.test", "registry.npmjs.org"]);
      expect(seen.every((s) => s.auth !== "sk-real-value" || s.host === "api.model.test")).toBe(true);
      expect(proxy.refused).toEqual([
        "MODEL_KEY may not go to registry.npmjs.org",
        "a request body to api.model.test carries a secret placeholder",
        "evil.test is not on the allow-list",
      ]);
      expect(proxy.refused.join(" ")).not.toContain("sk-real-value");
    } finally {
      proxy.stop();
      upstream.stop(true);
    }
    expect(() => startEgressProxy({ allow: [], secrets: ["UNSET_KEY@h.test"], env: {} })).toThrow("is not set");
  });

  test("the sandboxing runtimes start with no network", () => {
    expect(containerArgs({ kind: "docker", image: "i" }, "true", "/w").join(" ")).toContain("--network none");
    expect(sandboxArgs({ kind: "microsandbox", image: "i" }, "true", "/w", "n")).toContain("--no-net");
    expect(CAPABILITIES.docker.egress).toBe("deny");
    expect(CAPABILITIES.microsandbox.egress).toBe("deny");
  });
});
