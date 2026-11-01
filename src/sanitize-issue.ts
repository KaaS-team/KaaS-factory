// Issue text is untrusted input to the agent. The snapshot it reads has hidden markup and invisible
// control characters removed, and comments from authors below write access dropped.

import { isTrusted } from "./chatops";
import type { GhIssue } from "./ports/scm";

// Zero-width (200B-200D, 2060, FEFF, 180E), bidi marks and overrides (200E-200F, 202A-202E, 2066-2069).
const INVISIBLE = /[᠎​-‏‪-‮⁠⁦-⁩﻿]/g;
// An unterminated comment hides the rest of the text, so it is cut to the end.
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

export function cleanText(text: string): string {
  let out = text;
  // Removing a comment can join two halves of a new one, so repeat until stable.
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(INVISIBLE, "").replace(HTML_COMMENT, "");
  }
  return out;
}

export function sanitizeIssue(issue: GhIssue): GhIssue {
  return {
    ...issue,
    title: cleanText(issue.title),
    body: cleanText(issue.body),
    comments: issue.comments.filter(isTrusted).map((c) => ({ ...c, body: cleanText(c.body) })),
  };
}
