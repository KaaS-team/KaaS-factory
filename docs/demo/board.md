# Board replay

Play a recorded fleet. No real sessions, no network.

```
factory board --replay docs/demo/fleet.ndjson --speed 10
factory board --replay docs/demo/fleet.ndjson --speed 10 --operator
```

`fleet.ndjson` holds six slots, one stall and two merges. A line that is not an event is skipped and
counted in the footer. Tokens against budget show only with `--operator`.

Keys: `j`/`k` move, `g`/`G` top and bottom, `enter` timeline, `[` and `]` or `tab` change screen,
`esc` back, `?` more keys, `q` quit. `s`, `c` and `r` refuse in a replay.
