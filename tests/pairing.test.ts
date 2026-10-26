// Pairing a phone by QR: the link holds a one-time token and the factory's public key, the phone
// claims it once with its own key, and every paired device is listed and can be revoked at once.
import { describe, expect, test } from "bun:test";
import { newDeviceKey } from "../dashboard/public/lib/e2e.js";
import { claimPairing } from "../dashboard/public/lib/remote.js";
import { cookieOf, makePlane, owner, pairPhone } from "./remote-plane";

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

  test("a device past the list cap is still found and revocable", async () => {
    const p = makePlane();
    p.member("approver", "ana");
    const phone = await pairPhone(p, "ana", (await newDeviceKey()).publicKey);
    // Newer rows push Ana's phone past the 200 the device list shows.
    const add = p.store.database.query("INSERT INTO plane_devices VALUES (?, 'ana', 'old', 'k', ?, ?, '2999-01-01')");
    for (let i = 0; i < 201; i++)
      add.run(`filler-${i}`, `h${i}`, `2999-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`);
    expect(p.remote.devices.list().some((d) => d.id === phone.device)).toBe(false);
    expect(p.remote.devices.get(phone.device)?.login).toBe("ana");
    expect((await p.call("POST", "/api/devices/revoke", owner, { id: phone.device })).status).toBe(200);
    expect((await p.call("GET", "/api/me", phone.cookie)).status).toBe(401);
  });

  test("the claim needs confirmation and uses the plane key", async () => {
    const p = makePlane();
    p.member("approver", "ana");
    const bob = p.member("approver", "bob");
    const { link } = (await (await p.call("POST", "/api/pair", owner, { login: "ana" })).json()) as { link: string };
    const token = /#pair=([\w-]+)\./.exec(link)![1]!;
    const forged = { hash: `#pair=${token}.${"A".repeat(87)}`, pathname: "/" };
    const asked: string[] = [];
    const saved: { sender: string }[] = [];
    const io = (cookie: string, yes: boolean) => ({
      post: (path: string, body: unknown) => p.call("POST", path, cookie, body),
      me: async () => {
        const res = await p.call("GET", "/api/me", cookie);
        return res.ok ? ((await res.json()) as { login: string }).login : null;
      },
      confirm: async (login: string) => (asked.push(login), yes),
      save: async (record: { sender: string }) => void saved.push(record),
      forget: () => {},
    });

    // A browser signed in as Bob is never switched to Ana, by the page or by the plane.
    expect(await claimPairing(forged, io(bob, true))).toBe(false);
    expect(
      (await p.call("POST", "/api/pair/claim", bob, { token, publicKey: (await newDeviceKey()).publicKey })).status,
    ).toBe(409);
    // Saying no claims nothing, so the code still works.
    expect(await claimPairing(forged, io("", false))).toBe(false);
    expect(asked).toEqual(["ana"]);
    expect(saved).toEqual([]);
    expect(await claimPairing(forged, io("", true))).toBe(true);
    // The pinned sender is the key the plane publishes, not the forged one in the link.
    expect(saved.map((r) => r.sender)).toEqual([(await p.remote.e2eKey()).publicKey]);
  });
});
