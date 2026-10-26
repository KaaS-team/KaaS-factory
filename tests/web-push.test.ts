// Web Push: only "needs you" and "done" reach the phone, encrypted so the push service cannot read
// them, nobody is pushed while they have the cockpit open, and a subscription belongs to one person.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { PRESENCE_MS, pushTicker } from "../dashboard/plane/push";
import { SqliteStore } from "../src/adapters/sqlite/store";
import { WebPushNotifier } from "../src/adapters/webpush/notifier";
import { newDeviceKey } from "../dashboard/public/lib/e2e.js";
import { makePlane, pairPhone, recordPushes } from "./remote-plane";

const subtle = crypto.subtle;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const utf8 = (s: string) => new TextEncoder().encode(s);
const join = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await subtle.importKey("raw", ikm as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveBits"]);
  const params = {
    name: "HKDF",
    hash: "SHA-256",
    salt: salt as Uint8Array<ArrayBuffer>,
    info: info as Uint8Array<ArrayBuffer>,
  };
  return new Uint8Array(await subtle.deriveBits(params, key, bytes * 8));
}

// What the browser does with a push body (RFC 8291), so the test reads it the way a phone would.
async function browser(endpoint = "https://fcm.googleapis.com/fcm/send/phone-1") {
  const pair = (await subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = {
    endpoint,
    keys: { p256dh: b64u(pub), auth: b64u(auth) },
  };
  async function read(body: Uint8Array) {
    const salt = body.slice(0, 16);
    const asPublic = body.slice(21, 21 + body[20]!);
    const peer = await subtle.importKey("raw", asPublic, ECDH, false, []);
    const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: peer }, pair.privateKey, 256));
    const ikm = await hkdf(auth, shared, join(utf8("WebPush: info\0"), pub, asPublic), 32);
    const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
    const key = await subtle.importKey("raw", cek as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(
      await subtle.decrypt({ name: "AES-GCM", iv: nonce as Uint8Array<ArrayBuffer> }, key, body.slice(21 + body[20]!)),
    );
    return JSON.parse(new TextDecoder().decode(plain.slice(0, plain.lastIndexOf(2))));
  }
  return { sub, read };
}

describe("web push", () => {
  test("needs-you and done reach the phone encrypted, and nothing is pushed while its person is present", async () => {
    let now = 1_000_000;
    const bodies: Uint8Array[] = [];
    const auths: string[] = [];
    const notifier = new WebPushNotifier(
      new SqliteStore(new Database(":memory:")),
      "mailto:ops@example.com",
      (async (_u: unknown, init?: RequestInit) => {
        bodies.push(init!.body as Uint8Array);
        auths.push(new Headers(init!.headers).get("authorization")!);
        return new Response(null, { status: 201 });
      }) as typeof fetch,
      () => now,
      (o) => !push.present(o.login),
    );
    const phone = await browser();
    const ana = { login: "ana", device: null };
    expect(await notifier.subscribe(phone.sub, ana)).toBe(true);

    let inbox: object[] = [];
    let runs: object[] = [{ id: 1, issue: 3, title: "Add search", status: "running" }];
    const handle = async (req: Request) =>
      Response.json(new URL(req.url).pathname === "/api/inbox" ? { items: inbox } : { runs });
    const plane = {
      notifier,
      publicKey: () => notifier.publicKey(),
      subscribe: notifier.subscribe.bind(notifier),
      unsubscribe: notifier.unsubscribe.bind(notifier),
      ownerOf: () => ana,
    };
    const push = pushTicker(handle, plane, () => now);
    const presence = push.routes.find((r) => r.label === "POST /api/presence")!;

    // The first look only learns what is already there.
    inbox = [{ repo: "acme/widgets", issue: 4, kind: "plan", title: "Fix login" }];
    expect(await push.tick()).toEqual([]);

    inbox = [...inbox, { repo: "acme/widgets", issue: 5, kind: "plan", title: "Ship invoices" }];
    expect((await push.tick()).map((n) => n.kind)).toEqual(["needs-you"]);
    expect(await phone.read(bodies[0]!)).toMatchObject({
      kind: "needs-you",
      title: "#5 needs you",
      body: "Ship invoices",
    });
    expect(auths[0]).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);

    // Someone has the cockpit open: the change is seen, and not pushed.
    await presence.handler(new Request("http://x/api/presence", { method: "POST" }), new URL("http://x"), [] as never);
    inbox = [...inbox, { repo: "acme/widgets", issue: 6, kind: "plan", title: "Quiet one" }];
    expect((await push.tick()).map((n) => n.title)).toEqual(["#6 needs you"]);
    expect(bodies).toHaveLength(1);

    now += PRESENCE_MS + 1;
    runs = [{ id: 1, issue: 3, title: "Add search", status: "shipped" }];
    expect((await push.tick()).map((n) => n.kind)).toEqual(["done"]);
    expect(await phone.read(bodies[1]!)).toMatchObject({ kind: "done", title: "#3 is done" });
    expect(bodies).toHaveLength(2);
  });

  test("a removed member's device gets no sealed output and no push", async () => {
    const p = makePlane();
    const sent = recordPushes(p);
    p.member("approver", "ana");
    const { cookie, device } = await pairPhone(p, "ana", (await newDeviceKey()).publicKey);
    expect((await p.call("POST", "/api/push/subscribe", cookie, (await browser()).sub)).status).toBe(200);
    const notice = { kind: "done", title: "#3 is done", body: "", url: "/#issue=3" } as const;
    expect(await p.remote.sealer("line")).toBeDefined();
    expect(await p.remote.notifier.notify(notice)).toBe(1);

    // However the role went, a phone without one is never sealed for nor pushed to.
    p.store.database.query("DELETE FROM plane_memberships WHERE login = 'ana'").run();
    expect(await p.remote.sealer("line")).toBeUndefined();
    expect(await p.remote.notifier.notify(notice)).toBe(0);

    // Removing the member revokes the phone and drops its subscription for good.
    p.member("approver", "ana");
    p.store.setMember("ana", null, "test");
    await Bun.sleep(0);
    expect(p.remote.devices.get(device)?.revoked_at).not.toBeNull();
    expect(await p.remote.notifier.subscriptions()).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  test("unsubscribe by a non-owner is refused", async () => {
    const p = makePlane();
    const ana = p.member("approver", "ana");
    const bob = p.member("approver", "bob");
    const { sub } = await browser();
    expect((await p.call("POST", "/api/push/subscribe", ana, sub)).status).toBe(200);
    expect((await p.call("POST", "/api/push/subscribe", bob, sub)).status).toBe(400);
    expect((await p.call("POST", "/api/push/unsubscribe", bob, { endpoint: sub.endpoint })).status).toBe(404);
    expect((await p.remote.notifier.subscriptions()).map((s) => s.owner.login)).toEqual(["ana"]);
    expect((await p.call("POST", "/api/push/unsubscribe", ana, { endpoint: sub.endpoint })).status).toBe(200);
    expect(await p.remote.notifier.subscriptions()).toEqual([]);
  });

  test("one member's presence does not suppress another member's push", async () => {
    const p = makePlane();
    const sent = recordPushes(p);
    const ana = p.member("approver", "ana");
    const bob = p.member("approver", "bob");
    const anaPhone = await browser("https://fcm.googleapis.com/fcm/send/ana");
    const bobPhone = await browser("https://fcm.googleapis.com/fcm/send/bob");
    await p.call("POST", "/api/push/subscribe", ana, anaPhone.sub);
    await p.call("POST", "/api/push/subscribe", bob, bobPhone.sub);
    expect((await p.call("POST", "/api/presence", ana)).status).toBe(200);
    await p.remote.notifier.notify({ kind: "needs-you", title: "#5 needs you", body: "", url: "/#issue=5" });
    expect(sent).toEqual([bobPhone.sub.endpoint]);
  });
});
