// The relay forwards only ciphertext: the plane seals each inbox line for the paired phones, and
// only a paired phone, holding the factory key it pinned from the QR, can open it.
import { describe, expect, test } from "bun:test";
import { relayPublisher } from "../dashboard/relay";
import { newDeviceKey, openBox } from "../dashboard/public/lib/e2e.js";
import { LABEL } from "../src/labels";
import { makePlane, owner, TrackerGitHub } from "./remote-plane";

class OneWaiting extends TrackerGitHub {
  override async listOpenIssues() {
    this.labels[5] = LABEL.awaitingApproval;
    const issue = await this.getIssue("acme/widgets", 5);
    return [{ ...issue, title: "Rotate the payroll keys" }];
  }
}

async function pairPhone(p: ReturnType<typeof makePlane>) {
  p.member("viewer", "ana");
  const { link } = (await (await p.call("POST", "/api/pair", owner, { login: "ana" })).json()) as { link: string };
  const [, token, sender] = /#pair=([\w-]+)\.([\w-]+)$/.exec(link)!;
  const key = await newDeviceKey();
  const res = await p.call("POST", "/api/pair/claim", "", { token, publicKey: key.publicKey });
  const { device } = (await res.json()) as { device: string };
  return { key, device, sender: sender! };
}

describe("end-to-end encryption", () => {
  test("the relay receives a sealed box with no plaintext, and only the paired phone opens it", async () => {
    const p = makePlane(new OneWaiting());
    const target = { url: "https://relay.example", token: "relay-token", channel: "inbox" };
    const sent: string[] = [];
    const send = (async (_u: unknown, init?: RequestInit) => {
      sent.push(String(init?.body));
      return new Response("{}");
    }) as typeof fetch;
    const publish = relayPublisher(p.dashboard.readInProcess, target, send, p.remote.sealer);

    // Nobody is paired yet, so there is nobody to seal for and nothing goes out.
    expect(await publish()).toBe(false);
    const phone = await pairPhone(p);
    expect(await publish()).toBe(true);
    const wire = sent[0]!;
    expect(wire).not.toContain("payroll");
    expect(wire).not.toContain("items");

    const { sealed } = JSON.parse(wire);
    const opened = JSON.parse(await openBox(sealed, phone.device, phone.key.privateKey, phone.sender));
    expect(opened.items[0].title).toBe("Rotate the payroll keys");

    const stranger = await newDeviceKey();
    await expect(openBox(sealed, phone.device, stranger.privateKey, phone.sender)).rejects.toThrow();
  });
});
