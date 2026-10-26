// Web Push: only "needs you" and "done" reach the phone, encrypted so the push service cannot read
// them, and nothing is pushed while someone has the cockpit open.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { PRESENCE_MS, pushTicker } from "../dashboard/plane/push";
import { SqliteStore } from "../src/adapters/sqlite/store";
import { WebPushNotifier } from "../src/adapters/webpush/notifier";

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
async function browser() {
  const pair = (await subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = {
    endpoint: "https://fcm.googleapis.com/fcm/send/phone-1",
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
  test("needs-you and done reach the phone encrypted, and nothing is pushed while someone is present", async () => {
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
    );
    const phone = await browser();
    expect(await notifier.subscribe(phone.sub)).toBe(true);

    let inbox: object[] = [];
    let runs: object[] = [{ id: 1, issue: 3, title: "Add search", status: "running" }];
    const handle = async (req: Request) =>
      Response.json(new URL(req.url).pathname === "/api/inbox" ? { items: inbox } : { runs });
    const plane = {
      notifier,
      publicKey: () => notifier.publicKey(),
      subscribe: notifier.subscribe.bind(notifier),
      unsubscribe: notifier.unsubscribe.bind(notifier),
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
    expect(await push.tick()).toEqual([]);

    now += PRESENCE_MS + 1;
    runs = [{ id: 1, issue: 3, title: "Add search", status: "shipped" }];
    expect((await push.tick()).map((n) => n.kind)).toEqual(["done"]);
    expect(await phone.read(bodies[1]!)).toMatchObject({ kind: "done", title: "#3 is done" });
    expect(bodies).toHaveLength(2);
  });
});
