// Where a model host runs. A pure check: it reads the region label out of the host name and says
// whether that region fits the policy. Nothing calls it yet.

export type Residency = "any" | "eu" | "us";

function isDigits(s: string): boolean {
  return s.length > 0 && [...s].every((c) => c >= "0" && c <= "9");
}

function isLetters(s: string): boolean {
  return s.length > 0 && [...s].every((c) => c >= "a" && c <= "z");
}

// A region label looks like `xx-name-N`, as one dot-separated label of the host.
export function regionOf(host: string): string | undefined {
  for (const label of host.toLowerCase().replace(/\.$/, "").split(".")) {
    const parts = label.split("-");
    if (parts.length < 3) continue;
    const first = parts[0] ?? "";
    const last = parts[parts.length - 1] ?? "";
    if (first.length === 2 && isLetters(first) && isDigits(last)) return label;
  }
  return undefined;
}

export function checkResidency(
  policy: Residency,
  host: string,
): { ok: true; region: string } | { ok: false; reason: string } {
  const region = regionOf(host);
  if (policy === "any") return { ok: true, region: region ?? "" };
  const want = policy === "eu" ? "eu-" : "us-";
  if (region === undefined) return { ok: false, reason: `${host} names no region, so ${policy} cannot be shown` };
  if (!region.startsWith(want)) return { ok: false, reason: `${host} runs in ${region}, not in the ${policy} region` };
  return { ok: true, region };
}

// The shape a receipt step can copy. It holds no model name.
export function residencyRecord(
  host: string,
  policy: Residency,
): { policy: Residency; host: string; region: string | undefined } {
  return { policy, host, region: regionOf(host) };
}
