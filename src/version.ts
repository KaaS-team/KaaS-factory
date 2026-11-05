import pkg from "../package.json" with { type: "json" };

import { versionLine } from "./brand";

export const RUNNER_VERSION: string = pkg.version;

// What `--version` prints.
export const VERSION_TEXT: string = versionLine(RUNNER_VERSION);
