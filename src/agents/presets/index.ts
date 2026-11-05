import type { AgentPreset } from "../types";
import { agents } from "../../plugins/registry";
import { acpPreset } from "./acp";
import { claudePreset } from "./claude";
import { codexPreset } from "../../../contrib/agents/codex";
import { cursorPreset } from "../../../contrib/agents/cursor";
import { geminiPreset } from "../../../contrib/agents/gemini";
import { mastracodePreset } from "../../../contrib/agents/mastracode";
import { opencodePreset } from "../../../contrib/agents/opencode";
import { piPreset } from "../../../contrib/agents/pi";

const SHIPPED: Record<string, AgentPreset> = {
  claude: claudePreset,
  codex: codexPreset,
  gemini: geminiPreset,
  opencode: opencodePreset,
  cursor: cursorPreset,
  pi: piPreset,
  mastracode: mastracodePreset,
  acp: acpPreset,
};

for (const [name, preset] of Object.entries(SHIPPED)) agents.register(name, preset);

// The live agent table. Core reads agents from here by name; a plugin registered later shows up in it.
export const PRESETS: Record<string, AgentPreset> = agents.table;
