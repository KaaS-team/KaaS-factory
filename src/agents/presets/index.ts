import type { AgentPreset } from "../types";
import { acpPreset } from "./acp";
import { claudePreset } from "./claude";
import { codexPreset } from "../../../contrib/agents/codex";
import { cursorPreset } from "../../../contrib/agents/cursor";
import { geminiPreset } from "../../../contrib/agents/gemini";
import { mastracodePreset } from "../../../contrib/agents/mastracode";
import { opencodePreset } from "../../../contrib/agents/opencode";
import { piPreset } from "../../../contrib/agents/pi";

export const PRESETS: Record<string, AgentPreset> = {
  claude: claudePreset,
  codex: codexPreset,
  gemini: geminiPreset,
  opencode: opencodePreset,
  cursor: cursorPreset,
  pi: piPreset,
  mastracode: mastracodePreset,
  acp: acpPreset,
};
