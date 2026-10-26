// Follows a kaas-relay channel, so the installed cockpit still shows the inbox when the dashboard
// is out of reach. Settings live in this browser only; storage that throws (a private window)
// means no relay, never a broken page.
const KEY = "factory.relay";

export function readRelay(storage) {
  try {
    const cfg = JSON.parse(storage.getItem(KEY) ?? "null");
    return cfg?.url && cfg?.token ? { url: cfg.url, token: cfg.token, channel: cfg.channel || "inbox" } : null;
  } catch {
    return null;
  }
}

export function saveRelay(storage, cfg) {
  try {
    if (cfg) storage.setItem(KEY, JSON.stringify(cfg));
    else storage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

export function relayStreamUrl(cfg) {
  return `${cfg.url.replace(/\/+$/, "")}/subscribe/${cfg.channel}?token=${encodeURIComponent(cfg.token)}`;
}

// Calls onPayload with each well-formed line; EventSource reconnects by itself after a drop.
// A sealed line is opened with `open` (lib/remote.js); one this phone cannot open is skipped.
export function followRelay(cfg, onPayload, Source = globalThis.EventSource, open) {
  if (!Source) return () => {};
  const es = new Source(relayStreamUrl(cfg));
  es.onmessage = async (e) => {
    try {
      let p = JSON.parse(e.data);
      if (p?.sealed && open) p = JSON.parse(await open(p.sealed));
      if (Array.isArray(p?.items)) onPayload(p);
    } catch {}
  };
  return () => es.close();
}
