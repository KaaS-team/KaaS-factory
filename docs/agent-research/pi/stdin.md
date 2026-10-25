# Pi 0.73.1: prompt delivery

Source: `@mariozechner/pi-coding-agent@0.73.1` tarball, `dist/main.js`, read 2026-09-24 (`npm pack`, nothing installed).

- `readPipedStdin()` (line 40) returns the piped stdin unless stdin is a TTY, and `resolveAppMode` (line 82) runs non-interactively when `--print` is set or stdin is not a TTY. Piped stdin is the initial message.
- Project skills dir is `.pi/skills/` (see skills.md:29); `~/.pi/agent/skills/` is the global one.
