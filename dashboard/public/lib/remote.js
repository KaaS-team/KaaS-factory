// The phone side of remote control: claim a pairing link, keep the device key, open sealed relay
// lines, turn on push and tell the plane someone is looking (so it does not push at the same time).
// The device key is a non-extractable CryptoKey kept in IndexedDB; it never leaves this browser.
import { newDeviceKey, openBox } from "/lib/e2e.js";
import { followRelay as followPlain } from "/lib/relay-follow.js";

const DB = "factory-remote";
const PRESENCE_MS = 20_000;

const postJson = (path, body) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("device");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("device", mode);
      const r = fn(tx.objectStore("device"));
      tx.oncomplete = () => resolve(r?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const loadDevice = () => idb("readonly", (s) => s.get("self")).catch(() => undefined);

// `#pair=<token>.<factory public key>` from the QR: claim once, then drop it from the address bar.
export async function claimPairing(loc = location) {
  const m = /^#pair=([\w-]+)\.([\w-]+)$/.exec(loc.hash);
  if (!m) return false;
  history.replaceState(null, "", loc.pathname);
  const key = await newDeviceKey();
  const res = await postJson("/api/pair/claim", {
    token: m[1],
    name: navigator.platform || "phone",
    publicKey: key.publicKey,
  });
  if (!res.ok) return false;
  const { device, sender } = await res.json();
  // The sender key is pinned from the QR, not from the plane's answer, so a swapped plane cannot read along.
  await idb("readwrite", (s) => s.put({ id: device, privateKey: key.privateKey, sender: m[2] || sender }, "self"));
  return true;
}

export async function openSealed(box) {
  const me = await loadDevice();
  if (!me) throw new Error("this browser is not paired");
  return openBox(box, me.id, me.privateKey, me.sender);
}

// The relay only ever carries sealed lines, so the cockpit follows it through this phone's key.
export const followRelay = (cfg, onPayload) => followPlain(cfg, onPayload, undefined, openSealed);

export async function enablePush() {
  const reg = await navigator.serviceWorker?.ready;
  if (!reg?.pushManager || (await Notification.requestPermission()) !== "granted") return false;
  const { key } = await (await fetch("/api/push/key")).json();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return (await postJson("/api/push/subscribe", sub.toJSON())).ok;
}

export function startPresence() {
  const ping = () => document.visibilityState === "visible" && postJson("/api/presence").catch(() => {});
  ping();
  document.addEventListener("visibilitychange", ping);
  return setInterval(ping, PRESENCE_MS);
}

// A fresh pairing signs this browser in, so `onPaired` reloads what the page shows.
export function startRemote(onPaired) {
  claimPairing()
    .then((paired) => paired && onPaired())
    .catch(() => {});
  return startPresence();
}

export function remotePanel() {
  const box = document.createElement("section");
  const title = document.createElement("h3");
  title.textContent = "This phone";
  const note = document.createElement("p");
  note.textContent = "Get a notification when the factory needs you or finishes a task.";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Turn on notifications";
  button.addEventListener("click", async () => {
    button.disabled = true;
    const ok = await enablePush().catch(() => false);
    button.textContent = ok ? "Notifications are on" : "This browser cannot take notifications";
  });
  box.append(title, note, button);
  return box;
}
