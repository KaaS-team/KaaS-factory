// Ported from owainlewis/assembler@7cac671 src/display.ts:5 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: none; the log-update progress renderer in the same file is not ported.

import { stripVTControlCharacters } from "node:util";

// Anything shown in a terminal or the dashboard that came from an agent or an
// issue thread is stripped of escape sequences and control characters first.
export const plain = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
