// Approving from the phone: the relay stays read-only, so a paired phone approves through the
// plane's own command route, which posts the signed command to the tracker before it answers.
import { describe, expect, test } from "bun:test";
import { newDeviceKey } from "../dashboard/public/lib/e2e.js";
import { parseChatOps } from "../src/chatops";
import { LABEL } from "../src/labels";
import { cookieOf, makePlane, owner } from "./remote-plane";

describe("phone approvals", () => {
  test("a paired phone approves a plan as its person, on the tracker, until it is revoked", async () => {
    const p = makePlane();
    p.member("approver", "ana");
    p.github.labels[9] = LABEL.awaitingApproval;
    const { link } = (await (await p.call("POST", "/api/pair", owner, { login: "ana" })).json()) as { link: string };
    const token = /#pair=([\w-]+)\./.exec(link)![1];
    const claimed = await p.call("POST", "/api/pair/claim", "", { token, publicKey: (await newDeviceKey()).publicKey });
    const phone = cookieOf(claimed);
    const { device } = (await claimed.json()) as { device: string };

    expect((await p.call("POST", "/api/issues/9/approve-plan", phone)).status).toBe(200);
    expect(p.github.posted).toHaveLength(1);
    expect(p.github.posted[0]!.body).toContain("@ana");
    expect(parseChatOps(p.github.posted[0]!.body).type).toBe("approve");
    expect(p.store.audit()[0]).toMatchObject({ actor: "ana", route: "POST /api/issues/:n/approve-plan", status: 200 });

    await p.call("POST", "/api/devices/revoke", owner, { id: device });
    expect((await p.call("POST", "/api/issues/9/approve-plan", phone)).status).toBe(401);
    expect(p.github.posted).toHaveLength(1);
  });
});
