// The four ports the remote plane stands on, each with its first adapter held to the port's promise.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EnvSecrets } from "../src/adapters/env/secrets";
import { SqliteStore } from "../src/adapters/sqlite/store";
import { SseEventSource } from "../src/adapters/sse/event-source";
import { WebPushNotifier } from "../src/adapters/webpush/notifier";
import { NOTICE_KINDS } from "../src/ports/notifier";

const ROOT = join(import.meta.dir, "..");

describe("ports landed", () => {
  test("StorePort, SecretsPort, NotifierPort and EventSourcePort each exist with an adapter", () => {
    const adapters = [...new Bun.Glob("src/adapters/**/*.ts").scanSync(ROOT)].map((f) =>
      readFileSync(join(ROOT, f), "utf8"),
    );
    for (const [file, port] of [
      ["store", "StorePort"],
      ["secrets", "SecretsPort"],
      ["notifier", "NotifierPort"],
      ["event-source", "EventSourcePort"],
    ]) {
      expect(existsSync(join(ROOT, "src/ports", `${file}.ts`)), port).toBe(true);
      expect(
        adapters.some((src) => new RegExp(`\\bimplements ${port}\\b`).test(src)),
        `${port} has an adapter`,
      ).toBe(true);
    }
    expect(NOTICE_KINDS).toEqual(["needs-you", "done"]);
  });

  test("StorePort on SQLite: put, get, delete, and a prefix list that treats % and _ literally", async () => {
    const store = new SqliteStore(new Database(":memory:"));
    await store.put("a%1", "x");
    await store.put("ab", "y");
    await store.put("a%2", "z");
    await store.put("a%1", "x2");
    expect(await store.get("a%1")).toBe("x2");
    expect(await store.list("a%")).toEqual(["a%1", "a%2"]);
    await store.delete("a%1");
    expect(await store.get("a%1")).toBeUndefined();
  });

  test("SecretsPort on the environment: an empty value is no secret, and only env-style names are read", () => {
    const secrets = new EnvSecrets({ FACTORY_TOKEN: "s3", EMPTY: "" });
    expect(secrets.get("FACTORY_TOKEN")).toBe("s3");
    expect(secrets.get("EMPTY")).toBeUndefined();
    expect(() => secrets.get("../etc/passwd")).toThrow();
  });

  test("EventSourcePort over SSE: sends the bearer and Last-Event-ID, skips seen ids, returns the last", async () => {
    let headers = new Headers();
    const body =
      'id: 3\nevent: lease\ndata: {"issue":7}\n\n: hb\n\nid: 2\ndata: {}\n\nid: 4\nevent: cancel\ndata: {"issue":7}\n\n';
    const source = new SseEventSource("https://plane/runner/stream", () => "sekret", (async (
      _u: unknown,
      init?: RequestInit,
    ) => {
      headers = new Headers(init?.headers);
      return new Response(body);
    }) as typeof fetch);
    const seen: string[] = [];
    expect(await source.follow(2, (e) => void seen.push(`${e.seq}:${e.type}`))).toBe(4);
    expect(seen).toEqual(["3:lease", "4:cancel"]);
    expect(headers.get("authorization")).toBe("Bearer sekret");
    expect(headers.get("last-event-id")).toBe("2");
  });

  test("NotifierPort over Web Push refuses a subscription to a host that is not a push service", async () => {
    const push = new WebPushNotifier(
      new SqliteStore(new Database(":memory:")),
      "mailto:x@example.com",
      (async () => new Response(null, { status: 201 })) as unknown as typeof fetch,
    );
    const keys = { p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") };
    expect(await push.subscribe({ endpoint: "https://10.0.0.1/push", keys })).toBe(false);
    expect(await push.subscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys })).toBe(true);
    expect((await push.subscriptions()).map((s) => s.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/abc"]);
  });
});
