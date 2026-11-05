// A team's egress policy: the hosts a run may call and the secrets it may hold. It narrows a
// runtime spec before the spec becomes a port, so a build can reach nothing the team did not list.
import type { DockerSpec } from "../adapters/docker/execution";
import type { MicrosandboxSpec } from "../adapters/microsandbox/execution";
import type { WrapSpec } from "../adapters/wrap/execution";
import type { RuntimeSpec } from "../runtimes";
import { looksLikeCredential } from "../sandbox-env";
import type { PolicySpec } from "./schema";

export interface EgressPolicy {
  readonly hosts: readonly string[];
  readonly secrets: readonly string[];
}

// No egress block in the policy means no restriction; a block with empty lists means nothing allowed.
export function egressPolicyOf(policy: PolicySpec | undefined): EgressPolicy | undefined {
  const e = policy?.egress;
  return e ? { hosts: e.hosts ?? [], secrets: e.secrets ?? [] } : undefined;
}

// Credential-shaped names the policy does not list are dropped; every other variable passes.
export function scrubEnv(
  env: Readonly<Record<string, string | undefined>>,
  keep: readonly string[],
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => keep.includes(name) || !looksLikeCredential(name)));
}

const hostsOf = (allow: readonly string[] | undefined, p: EgressPolicy): string[] =>
  (allow ?? []).filter((h) => p.hosts.includes(h));

function secretsOf(entries: readonly string[] | undefined, p: EgressPolicy, allow: readonly string[]): string[] {
  return (entries ?? []).flatMap((entry) => {
    const [env = "", hosts = ""] = entry.split("@");
    const kept = hosts.split(",").filter((h) => allow.includes(h));
    return p.secrets.includes(env) && kept.length ? [`${env}@${kept.join(",")}`] : [];
  });
}

export function restrictSpec(spec: RuntimeSpec, policy: EgressPolicy | undefined): RuntimeSpec {
  if (!policy) return spec;
  if (spec.kind === "docker" || spec.kind === "wrap" || spec.kind === "microsandbox") {
    const allow = hostsOf(spec.allow, policy);
    if (spec.kind === "microsandbox") {
      const ms: MicrosandboxSpec = { ...spec, allow, secrets: secretsOf(spec.secrets, policy, allow) };
      return ms;
    }
    // An absent allow meant an unrestricted network; under a policy it means no host at all.
    if (spec.kind === "wrap") return { ...spec, allow, keepSecrets: policy.secrets } satisfies WrapSpec;
    return { ...spec, allow } satisfies DockerSpec;
  }
  return spec;
}
