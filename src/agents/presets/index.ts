// Each agent preset lives in contrib/agents and registers itself when its module loads. This file
// loads them all and exports the live table; core reads agents from here by name.
import type { AgentPreset } from "../types";
import { agents } from "../../plugins/registry";
import "../../../contrib/agents/claude";
import "../../../contrib/agents/codex";
import "../../../contrib/agents/gemini";
import "../../../contrib/agents/opencode";
import "../../../contrib/agents/cursor";
import "../../../contrib/agents/pi";
import "../../../contrib/agents/mastracode";
import "../../../contrib/agents/acp";

export const PRESETS: Record<string, AgentPreset> = agents.table;
