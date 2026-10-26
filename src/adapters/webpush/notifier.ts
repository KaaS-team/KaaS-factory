// Web Push on WebCrypto alone: the payload is encrypted for the browser (RFC 8291, aes128gcm) and
// the request is signed with the factory's VAPID key (RFC 8292), so the push service carries bytes
// it cannot read. Only the endpoints of the big push services are accepted, never a private host.
import type { Notice, NotifierPort } from "../../ports/notifier";
import type { StorePort } from "../../ports/store";

const subtle = crypto.subtle;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const PUSH_HOSTS = [
  /\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
];
const SUB_PREFIX = "push:sub:";
const VAPID_KEY = "push:vapid";
const RECORD_SIZE = 4096;

type Bytes = Uint8Array<ArrayBuffer>;
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string): Bytes => new Uint8Array(Buffer.from(s, "base64url"));
const utf8 = (s: string): Bytes => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]): Bytes => new Uint8Array(Buffer.concat(parts));

export interface PushSubscription {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

type Jwk = Parameters<typeof subtle.importKey>[1] & { kty?: string };
interface Vapid {
  publicKey: string;
  privateJwk: Jwk;
}

export function pushEndpointAllowed(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && PUSH_HOSTS.some((h) => h.test(url.hostname));
  } catch {
    return false;
  }
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

// RFC 8291 section 3: one record holding the whole message, with a fresh sender key and salt.
export async function encryptPush(plaintext: string, sub: PushSubscription): Promise<Uint8Array> {
  const uaPublic = unb64u(sub.keys.p256dh);
  const pair = (await subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const peer = await subtle.importKey("raw", uaPublic, ECDH, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: peer }, pair.privateKey, 256));
  const ikm = await hkdf(unb64u(sub.keys.auth), shared, concat(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const padded = concat(utf8(plaintext), new Uint8Array([2]));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, padded));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

export class WebPushNotifier implements NotifierPort {
  constructor(
    private readonly store: StorePort,
    private readonly subject: string,
    private readonly send: typeof fetch = fetch,
    private readonly now = Date.now,
  ) {}

  private async vapid(): Promise<Vapid> {
    const kept = await this.store.get(VAPID_KEY);
    if (kept) return JSON.parse(kept) as Vapid;
    const pair = (await subtle.generateKey(ECDSA, true, ["sign", "verify"])) as CryptoKeyPair;
    const v: Vapid = {
      publicKey: b64u(new Uint8Array(await subtle.exportKey("raw", pair.publicKey))),
      privateJwk: (await subtle.exportKey("jwk", pair.privateKey)) as Jwk,
    };
    await this.store.put(VAPID_KEY, JSON.stringify(v));
    return v;
  }

  // The browser passes this as applicationServerKey when it subscribes.
  async publicKey(): Promise<string> {
    return (await this.vapid()).publicKey;
  }

  async subscribe(sub: PushSubscription): Promise<boolean> {
    if (!pushEndpointAllowed(sub.endpoint) || unb64u(sub.keys?.p256dh ?? "").length !== 65) return false;
    if (unb64u(sub.keys.auth ?? "").length !== 16) return false;
    await this.store.put(SUB_PREFIX + sub.endpoint, JSON.stringify(sub));
    return true;
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await this.store.delete(SUB_PREFIX + endpoint);
  }

  async subscriptions(): Promise<PushSubscription[]> {
    const keys = await this.store.list(SUB_PREFIX);
    const rows = await Promise.all(keys.map((k) => this.store.get(k)));
    return rows.filter((r): r is string => !!r).map((r) => JSON.parse(r) as PushSubscription);
  }

  private async jwt(endpoint: string): Promise<string> {
    const v = await this.vapid();
    const key = await subtle.importKey("jwk", v.privateJwk, ECDSA, false, ["sign"]);
    const head = b64u(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const claims = { aud: new URL(endpoint).origin, exp: Math.floor(this.now() / 1000) + 12 * 3600, sub: this.subject };
    const unsigned = `${head}.${b64u(utf8(JSON.stringify(claims)))}`;
    const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(unsigned)));
    return `${unsigned}.${b64u(sig)}`;
  }

  // Resolves to how many browsers took it; a gone subscription (404 or 410) is dropped.
  async notify(notice: Notice): Promise<number> {
    const v = await this.vapid();
    let sent = 0;
    for (const sub of await this.subscriptions()) {
      if (!pushEndpointAllowed(sub.endpoint)) continue;
      try {
        const res = await this.send(sub.endpoint, {
          method: "POST",
          headers: {
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: "86400",
            urgency: notice.kind === "needs-you" ? "high" : "normal",
            authorization: `vapid t=${await this.jwt(sub.endpoint)}, k=${v.publicKey}`,
          },
          body: await encryptPush(JSON.stringify(notice), sub),
        });
        if (res.status === 404 || res.status === 410) await this.unsubscribe(sub.endpoint);
        else if (res.ok) sent++;
      } catch {
        // One unreachable push service never stops the rest.
      }
    }
    return sent;
  }
}
