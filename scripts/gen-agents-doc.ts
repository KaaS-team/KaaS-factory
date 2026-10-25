// Rewrites the generated table in docs/agents.md from PRESETS.
import { readFileSync, writeFileSync } from "node:fs";
import { renderAgentsDoc } from "../src/agents/docs";

const path = new URL("../docs/agents.md", import.meta.url);
writeFileSync(path, renderAgentsDoc(readFileSync(path, "utf8")));
