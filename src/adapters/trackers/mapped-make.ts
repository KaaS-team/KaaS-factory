// Builds the generic tracker from its config block: reads the mapping from the repo checkout and picks
// the transport it names: an MCP server or a declared CLI tool.

import type { TrackerConfig } from "../../config";
import { CliTransport } from "./mapped-cli";
import { MappedTracker, McpTransport, type CallTransport } from "./mapped";
import { readMapping } from "./mapping";

export function makeMappedTracker(
  config: Extract<TrackerConfig, { kind: "mapped" }>,
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): MappedTracker {
  const mapping = readMapping(dir, config.mapping);
  const transport: CallTransport = mapping.cli
    ? new CliTransport(dir, mapping.cli, env)
    : new McpTransport(dir, mapping.server!, env, mapping.env);
  return new MappedTracker(mapping, transport, config.project ?? "");
}
