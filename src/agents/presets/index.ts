import type { AgentPreset } from "../types";
import { claudePreset } from "./claude";
import { codexPreset } from "./codex";
import { cursorPreset } from "./cursor";
import { geminiPreset } from "./gemini";
import { mastracodePreset } from "./mastracode";
import { opencodePreset } from "./opencode";
import { piPreset } from "./pi";

export const PRESETS: Record<string, AgentPreset> = {
  claude: claudePreset,
  codex: codexPreset,
  gemini: geminiPreset,
  opencode: opencodePreset,
  cursor: cursorPreset,
  pi: piPreset,
  mastracode: mastracodePreset,
};
