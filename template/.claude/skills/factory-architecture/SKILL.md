---
name: factory-architecture
description: Finds the one module in a repo most worth deepening and writes it up as a refactor ticket. Use when an operator asks for an architecture review, or when the retro keeps flagging the same file as hard to change. Not a stage; it never edits code.
---

# Architecture review

Find where a change costs more than it should, then file one ticket. Never edit code here.

## Vocabulary

Use these words and no others for the design: module, interface, depth (behaviour behind a small interface), seam (where behaviour can change without editing in place), adapter, payoff (callers gained per line kept), locality (a change stays in one place).

## Steps

1. **Find the hot spots.** `git log --since=90.days --name-only --format=` counted per file. Heavily edited files rank first; a file nobody changes is not a candidate however ugly.
2. **Read the top five.** For each, note what a caller must know to use it, and what breaks when it changes.
3. **Apply the deletion test.** Imagine the module deleted. If its complexity vanishes, it was a pass-through; if it reappears in N callers, it was earning its keep. Only a module that fails the test is a candidate.
4. **Apply YAGNI.** Do not propose a seam with one adapter, or a layer nothing varies behind.
5. **Pick one candidate.** Write why it ranks first and what the next one is. Do not list ten.
6. **Check names.** If `GLOSSARY.md` or an ADR exists, use its terms. If the review forces a new term or a decision, say which file gets the line; do not edit it.

## Ticket

One issue, titled `Deepen <module> so <benefit>`. Body: today (file:line facts and the git-log count), the change in two or three steps, the test that proves it, what is left out. Label it `factory:ready` only if the operator asked for that.

## Standards

If the same judgement call shows up in three reviews, it belongs in `CODING_STANDARDS.md` (create it at the repo root; the reviewer reads it). If a tool could catch it, propose a check instead; a prose rule for something mechanical does not hold.
