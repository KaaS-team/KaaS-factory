// Phones paired by QR. `factory pair` (or Settings) asks for a one-time token; the phone scans it,
// makes its own key pair and claims the token once, which opens a long session for the person who
// paired it. Each device is listed and revocable, and revoking ends its session at once.
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { Recipient } from "../../src/e2e";
import { qrToSvg, encodeQr } from "../../src/qr";
import type { Actor, Route } from "./access";
import { digest, type Role } from "./store";

export const PAIR_TTL_MS = 10 * 60 * 1000;
export const DEVICE_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DEVICES = 20;
// A raw uncompressed P-256 point is 65 bytes, 87 characters of base64url.
const PUBLIC_KEY = /^[A-Za-z0-9_-]{87}$/;

export interface Device {
  id: string;
  login: string;
  name: string;
  public_key: string;
  created_at: string;
  revoked_at: string | null;
}

export class DeviceStore {
  constructor(
    private readonly db: Database,
    private readonly now = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plane_pairings (
        token_hash TEXT PRIMARY KEY,
        login TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plane_devices (
        id TEXT PRIMARY KEY,
        login TEXT NOT NULL,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        session_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
    `);
  }

  // Only the digest is kept, so a leaked database cannot pair a phone.
  offer(login: string): { token: string; expiresAt: number } {
    const token = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + PAIR_TTL_MS;
    this.db.query("DELETE FROM plane_pairings WHERE expires_at <= ?").run(this.now());
    this.db.query("INSERT INTO plane_pairings VALUES (?, ?, ?)").run(digest(token), login, expiresAt);
    return { token, expiresAt };
  }

  // Spends the token: a second claim with it, or a late one, gets null.
  claim(token: string, name: string, publicKey: string, sessionId: string): Device | null {
    const row = this.db
      .query("DELETE FROM plane_pairings WHERE token_hash = ? AND expires_at > ? RETURNING login")
      .get(digest(token), this.now()) as { login: string } | null;
    if (!row) return null;
    const live = this.db.query("SELECT count(*) AS n FROM plane_devices WHERE revoked_at IS NULL").get() as {
      n: number;
    };
    if (live.n >= MAX_DEVICES) return null;
    const device: Device = {
      id: randomBytes(9).toString("base64url"),
      login: row.login,
      name,
      public_key: publicKey,
      created_at: new Date(this.now()).toISOString(),
      revoked_at: null,
    };
    this.db
      .query("INSERT INTO plane_devices VALUES (?, ?, ?, ?, ?, ?, NULL)")
      .run(device.id, device.login, name, publicKey, digest(sessionId), device.created_at);
    return device;
  }

  list(login?: string): Device[] {
    const cols = "id, login, name, public_key, created_at, revoked_at";
    return (
      login === undefined
        ? this.db.query(`SELECT ${cols} FROM plane_devices ORDER BY created_at DESC LIMIT 200`).all()
        : this.db
            .query(`SELECT ${cols} FROM plane_devices WHERE login = ? ORDER BY created_at DESC LIMIT 200`)
            .all(login)
    ) as Device[];
  }

  get(id: string): Device | null {
    return this.list().find((d) => d.id === id) ?? null;
  }

  revoke(id: string): boolean {
    const row = this.db
      .query("UPDATE plane_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING session_hash")
      .get(new Date(this.now()).toISOString(), id) as { session_hash: string } | null;
    if (!row) return false;
    this.db.query("DELETE FROM plane_sessions WHERE id_hash = ?").run(row.session_hash);
    return true;
  }

  // Who a sealed box is for: every device not revoked.
  recipients(): Recipient[] {
    return this.list()
      .filter((d) => d.revoked_at === null)
      .map((d) => ({ id: d.id, publicKey: d.public_key }));
  }
}

export interface DeviceDeps {
  devices: DeviceStore;
  actorOf: (req: Request) => Actor | undefined;
  senderKey: () => Promise<string>;
  roleOf: (login: string) => Role | null;
  startSession: (
    req: Request,
    login: string,
    extra: Record<string, string>,
    status: number,
    id: string,
    ttlMs: number,
  ) => Response;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// The link carries the token and the factory's public key in the fragment, which no server logs.
export const pairLink = (origin: string, token: string, sender: string) => `${origin}/#pair=${token}.${sender}`;

export function deviceRoutes(deps: DeviceDeps): Route[] {
  // An owner sees and revokes every device; anyone else only their own.
  const scope = (req: Request) => {
    const who = deps.actorOf(req);
    return who?.role === "owner" ? undefined : (who?.login ?? "");
  };
  return [
    {
      method: "POST",
      pattern: /^\/api\/pair$/,
      label: "POST /api/pair",
      role: "viewer",
      // An owner (the CLI's break-glass token included) may pair a phone for a named member.
      handler: async (req) => {
        const who = deps.actorOf(req);
        const body = (await req.json().catch(() => ({}))) as { login?: unknown };
        const login = who?.role === "owner" && typeof body.login === "string" ? body.login : (who?.login ?? "");
        if (login.startsWith("~") || !deps.roleOf(login))
          return json({ error: "a phone is paired for a member: pass their GitHub login" }, 403);
        const { token, expiresAt } = deps.devices.offer(login);
        const link = pairLink(new URL(req.url).origin, token, await deps.senderKey());
        return json({ link, expiresAt, svg: qrToSvg(encodeQr(link)) });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/pair\/claim$/,
      label: "POST /api/pair/claim",
      handler: async (req) => {
        const body = (await req.json().catch(() => ({}))) as { token?: unknown; name?: unknown; publicKey?: unknown };
        if (typeof body.token !== "string" || typeof body.publicKey !== "string" || !PUBLIC_KEY.test(body.publicKey))
          return json({ error: "a pairing needs its token and the device's public key" }, 400);
        const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : "phone";
        const sessionId = randomBytes(32).toString("hex");
        const device = deps.devices.claim(body.token, name, body.publicKey, sessionId);
        if (!device) return json({ error: "this pairing code was used or has expired; make a new one" }, 401);
        const res = deps.startSession(req, device.login, {}, 200, sessionId, DEVICE_SESSION_MS);
        const out = new Headers(res.headers);
        return new Response(JSON.stringify({ ok: true, device: device.id, sender: await deps.senderKey() }), {
          status: 200,
          headers: out,
        });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/devices$/,
      label: "GET /api/devices",
      role: "viewer",
      handler: (req) => json({ devices: deps.devices.list(scope(req)) }),
    },
    {
      method: "POST",
      pattern: /^\/api\/devices\/revoke$/,
      label: "POST /api/devices/revoke",
      role: "viewer",
      handler: async (req) => {
        const { id } = (await req.json().catch(() => ({}))) as { id?: unknown };
        const device = typeof id === "string" ? deps.devices.get(id) : null;
        const mine = scope(req);
        if (!device || (mine !== undefined && device.login !== mine)) return json({ error: "no such device" }, 404);
        if (!deps.devices.revoke(device.id)) return json({ error: "already revoked" }, 409);
        return json({ ok: true });
      },
    },
  ];
}
