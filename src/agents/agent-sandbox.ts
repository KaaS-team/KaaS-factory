// Where an agent stage runs when machine.json names an `agentRuntime`: a microVM or a docker
// container, each with the worktree and scratch dir mounted at their own paths. A docker agent's
// keys go by name (`-e KEY`), so docker reads them from its own env and no value is on a command line.

import { type DockerSpec, dockerAgentArgs } from "../adapters/docker/execution";
import { type AgentInVm, agentArgs, type MicrosandboxSpec, removeVm, SECRET } from "../adapters/microsandbox/execution";
import { isProviderCredential } from "./env";

export type AgentSandbox = MicrosandboxSpec | DockerSpec;

// Through a gateway the VM injects no provider key of its own; a container has none to drop.
export function forGateway(vm: AgentSandbox): AgentSandbox {
  if (vm.kind !== "microsandbox") return vm;
  return { ...vm, secrets: vm.secrets?.filter((s) => !isProviderCredential(SECRET.exec(s)?.[1] ?? "")) };
}

export function sandboxArgv(vm: AgentSandbox, run: AgentInVm): string[] {
  if (vm.kind === "microsandbox") return agentArgs(vm, run);
  const perRun = (run.secrets ?? []).map((s) => SECRET.exec(s)?.[1]).filter((k): k is string => !!k);
  return dockerAgentArgs(vm, run, [...(run.forward ?? []), ...perRun]);
}

export function removeSandbox(vm: AgentSandbox, name: string): void {
  if (vm.kind === "microsandbox") removeVm(name);
  else Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
}
