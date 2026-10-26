// Rewrites the generated table in docs/integrations.md from integrations/*/manifest.json.
import { readFileSync, writeFileSync } from "node:fs";
import { loadManifests, renderIntegrationsDoc } from "../src/integrations/catalogue";

const path = new URL("../docs/integrations.md", import.meta.url);
writeFileSync(path, renderIntegrationsDoc(readFileSync(path, "utf8"), loadManifests()));
