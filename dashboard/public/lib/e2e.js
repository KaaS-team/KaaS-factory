// Opens a box the factory sealed for this phone (src/e2e.ts seals it). The device key is made
// here and its private half never leaves the browser: it is stored as a non-extractable CryptoKey.
const INFO = "kaas-factory e2e v1";
const CURVE = { name: "ECDH", namedCurve: "P-256" };

const b64u = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function newDeviceKey(subtle = crypto.subtle) {
  const pair = await subtle.generateKey(CURVE, false, ["deriveBits"]);
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: b64u(raw) };
}

async function unwrapKey(privateKey, senderPublic, subtle) {
  const pub = await subtle.importKey("raw", unb64u(senderPublic), CURVE, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: pub }, privateKey, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const info = new TextEncoder().encode(INFO);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

// The sender key is the one pinned from the QR, never the box's own `from`, so a forged box fails.
export async function openBox(box, deviceId, privateKey, pinnedSender, subtle = crypto.subtle) {
  const wrapped = box?.keys?.[deviceId];
  if (!wrapped) throw new Error("not sealed for this device");
  const wk = await unwrapKey(privateKey, pinnedSender, subtle);
  const contentKey = await subtle.decrypt({ name: "AES-GCM", iv: unb64u(wrapped.iv) }, wk, unb64u(wrapped.k));
  const cek = await subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64u(box.iv) }, cek, unb64u(box.ct));
  return new TextDecoder().decode(pt);
}
