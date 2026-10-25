---
paths:
  - "**/*.{ts,tsx,js,jsx,mjs,cjs}"
  - "**/*.py"
  - "**/*.sh"
---

# Comments

- A comment says why, never what the next line does. No narration ("Step 1", "Now we", "This function").
- Two or three lines at most. Longer reasoning goes in `docs/decisions/`, and the comment links it.
- No commented-out code and no ownerless TODO.
- `scripts/lwp/check-quality.py` enforces the first two (and 400 lines per file) where the repo has a
  `quality-baseline.json`; the post-edit hook feeds its findings back on every edit.

Bad:

```ts
// Loop over the users and check each one is active
for (const user of users) if (user.active) send(user);
```

Good:

```ts
// Inactive users bounced 40% of sends in August; see docs/decisions/0007-skip-inactive.md
for (const user of users) if (user.active) send(user);
```
