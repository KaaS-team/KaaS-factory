// Imported by bin/factory before src/cli.ts, so enabled plugins are registered before any config or
// workflow is checked against the agent and step names.

import { loadMachineConfig } from "../machine";
import { startPlugins } from "./loader";

if (!["version", "--version", "--skill"].includes(process.argv[2] ?? "")) await startPlugins(loadMachineConfig());
