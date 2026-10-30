import pkg from "../package.json" with { type: "json" };

export const RUNNER_VERSION: string = pkg.version;
