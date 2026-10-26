// Pairing a phone by QR: the link holds a one-time token and the factory's public key, the phone
// claims it once with its own key, and every paired device is listed and can be revoked at once.
import { describe, expect, test } from "bun:test";
import { newDeviceKey } from "../dashboard/public/lib/e2e.js";
import { cookieOf, makePlane, owner } from "./remote-plane";

const tokenOf = (link: string) => /#pair=([\w-]+)\./.exec(link)![1]!;

describe("phone pairing", () => {
  test("a QR pairs a phone once, the device is listed, and revoking it ends its session", async () => {
    const p = makePlane();
    p.member("approver", "ana");
    const offer = await p.call("POST", "/api/pair", owner, { login: "ana" });
    const { link, svg } = (await offer.json()) as { link: string; svg: string };
    expect(link).toMatch(/^https:\/\/plane\.example\/#pair=[\w-]+\.[\w-]{87}$/);
    expect(svg).toStartWith("<svg");

    const key = await newDeviceKey();
    const claim = { token: tokenOf(link), name: "Ana's phone", publicKey: key.publicKey };
    const res = await p.call("POST", "/api/pair/claim", "", claim);
    expect(res.status).toBe(200);
    const phone = cookieOf(res);
    expect((await p.call("POST", "/api/pair/claim", "", claim)).status).toBe(401);

    expect((await p.call("GET", "/api/me", phone)).status).toBe(200);
    const { devices } = (await (await p.call("GET", "/api/devices", phone)).json()) as {
      devices: { id: string; login: string }[];
    };
    expect(devices.map((d) => d.login)).toEqual(["ana"]);

    expect((await p.call("POST", "/api/devices/revoke", owner, { id: devices[0]!.id })).status).toBe(200);
    expect((await p.call("GET", "/api/me", phone)).status).toBe(401);
    expect(p.remote.devices.recipients()).toEqual([]);
  });

  test("a phone is paired only for a member, never for the break-glass token itself", async () => {
    const p = makePlane();
    expect((await p.call("POST", "/api/pair", owner)).status).toBe(403);
    expect((await p.call("POST", "/api/pair", owner, { login: "stranger" })).status).toBe(403);
  });
});
