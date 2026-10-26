// Boxes for paired phones on WebCrypto alone: one content key seals the payload, wrapped per device
// under ECDH(P-256) + HKDF, so the relay forwards bytes it cannot read. The phone opens them with
// dashboard/public/lib/e2e.js, which shares these constants.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const E2E_INFO = "kaas-factory e2e v1";
const subtle = crypto.subtle;
const CURVE = { name: "ECDH", namedCurve: "P-256" } as const;
type Jwk = Parameters<typeof subtle.importKey>[1] & { kty?: string };
type Usage = "encrypt" | "decrypt";

export const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
export const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

export interface Recipient {
  readonly id: string;
  // The device's raw P-256 public key, base64url.
  readonly publicKey: string;
}

export interface SealedBox {
  readonly v: 1;
  readonly from: string;
  readonly iv: string;
  readonly ct: string;
  readonly keys: Readonly<Record<string, { iv: string; k: string }>>;
}

export interface E2EKey {
  readonly publicKey: string;
  readonly privateJwk: Jwk;
}

export async function newE2EKey(): Promise<E2EKey> {
  const pair = (await subtle.generateKey(CURVE, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { publicKey: b64u(raw), privateJwk: (await subtle.exportKey("jwk", pair.privateKey)) as Jwk };
}

// The factory's own key, kept 0600 beside its state; the phone pins its public half from the QR.
export async function loadE2EKey(path: string): Promise<E2EKey> {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as E2EKey;
  const key = await newE2EKey();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(key), { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

export async function wrappingKey(privateJwk: Jwk, peerPublic: string, usage: Usage): Promise<CryptoKey> {
  const priv = await subtle.importKey("jwk", privateJwk, CURVE, false, ["deriveBits"]);
  const pub = await subtle.importKey("raw", unb64u(peerPublic), CURVE, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const info = new TextEncoder().encode(E2E_INFO);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

export async function seal(plaintext: string, sender: E2EKey, recipients: readonly Recipient[]): Promise<SealedBox> {
  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cek = await subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, cek, new TextEncoder().encode(plaintext)));
  const keys: Record<string, { iv: string; k: string }> = {};
  for (const r of recipients) {
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    const wk = await wrappingKey(sender.privateJwk, r.publicKey, "encrypt");
    const k = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: wrapIv }, wk, contentKey));
    keys[r.id] = { iv: b64u(wrapIv), k: b64u(k) };
  }
  return { v: 1, from: sender.publicKey, iv: b64u(iv), ct: b64u(ct), keys };
}

// The Bun side of opening, for runners and tests; the phone uses lib/e2e.js.
export async function open(box: SealedBox, deviceId: string, devicePrivateJwk: Jwk, pinnedSender: string) {
  const wrapped = box.keys[deviceId];
  if (!wrapped) throw new Error("this box was not sealed for this device");
  const wk = await wrappingKey(devicePrivateJwk, pinnedSender, "decrypt");
  const contentKey = await subtle.decrypt({ name: "AES-GCM", iv: unb64u(wrapped.iv) }, wk, unb64u(wrapped.k));
  const cek = await subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64u(box.iv) }, cek, unb64u(box.ct));
  return new TextDecoder().decode(pt);
}
