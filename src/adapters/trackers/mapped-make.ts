// Builds the generic tracker from its config block: reads the mapping from the repo checkout and picks
// the transport it names.

import type { TrackerConfig } from "../../config";
import { MappedTracker, McpTransport, type CallTransport } from "./mapped";
import { readMapping } from "./mapping";

export function makeMappedTracker(
  config: Extract<TrackerConfig, { kind: "mapped" }>,
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): MappedTracker {
  const mapping = readMapping(dir, config.mapping);
  const transport: CallTransport = new McpTransport(dir, mapping.server!, env, mapping.env);
  return new MappedTracker(mapping, transport, config.project ?? "");
}
