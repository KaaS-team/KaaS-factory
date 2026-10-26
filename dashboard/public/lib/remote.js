// The phone side of remote control: claim a pairing link, keep the device key, open sealed relay
// lines, turn on push and tell the plane someone is looking (so it does not push at the same time).
// The device key is a non-extractable CryptoKey kept in IndexedDB; it never leaves this browser.
import { newDeviceKey, openBox } from "./e2e.js";
import { followRelay as followPlain } from "./relay-follow.js";

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

const browserIo = {
  post: postJson,
  me: async () => {
    const res = await fetch("/api/me");
    return res.ok ? (await res.json()).login : null;
  },
  confirm: async (login) =>
    window.confirm(`Pair this browser as ${login}? It will see and act on the factory as them.`),
  save: (record) => idb("readwrite", (s) => s.put(record, "self")),
  forget: (loc) => history.replaceState(null, "", loc.pathname),
};

// `#pair=<token>.<key>` from the QR. A link can be sent by anyone, so the phone first asks who it
// would pair as, refuses to switch a signed-in browser to someone else, and waits for a yes. The
// sender key is the one the plane publishes, never the one in the link.
export async function claimPairing(loc = location, io = browserIo) {
  const m = /^#pair=([\w-]+)\.([\w-]+)$/.exec(loc.hash);
  if (!m) return false;
  io.forget(loc);
  const peek = await io.post("/api/pair/peek", { token: m[1] });
  if (!peek.ok) return false;
  const { login, sender } = await peek.json();
  const current = await io.me();
  if (current && !current.startsWith("~") && current !== login) return false;
  if (!(await io.confirm(login))) return false;
  const key = await newDeviceKey();
  const res = await io.post("/api/pair/claim", {
    token: m[1],
    name: globalThis.navigator?.platform || "phone",
    publicKey: key.publicKey,
  });
  if (!res.ok) return false;
  const { device } = await res.json();
  await io.save({ id: device, privateKey: key.privateKey, sender });
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
