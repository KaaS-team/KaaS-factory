<!-- factory:planned v1 -->
Blocked by: #258
Milestone: M2

## Why
The event ingress accepts a fixed list of event types from fixed KaaS apps. Another team's tools need to post their own types without a core change.

## Today
- `src/core/event.ts:48` `isExternalEventType` accepts only `EXTERNAL_EVENTS`.
- `src/core/event.ts:109-115` the signature header is `x-factory-signature` with `x-kaas-signature` as a fallback, in two separate constants.
- `src/config.ts` has no events section.

## Change
### T1: One list of signature headers
Files: `src/core/event.ts`, `tests/events.test.ts`
Model: haiku
1. Add `SIGNATURE_HEADERS = [EVENT_SIGNATURE_HEADER, LEGACY_EVENT_SIGNATURE_HEADER] as const` and make `eventSignature` return the first present header from it.
2. Add `acceptsEvent(type, accept)`: with `accept` undefined it is `isExternalEventType(type)`; with a list, true when a glob in it matches (`*` matches any run of characters).

### T2: Add an events.accept config key
Files: `src/config.ts`, `tests/config.test.ts`
Model: sonnet
Deps: T1
1. Add optional `events.accept: string[]` to `FactoryConfig`, validated as strings, unset by default so today's behaviour holds.

### T3: Use it at the ingress
Files: `src/watch.ts`, `tests/events.test.ts`
Model: sonnet
Deps: T2
1. Replace the `isExternalEventType` check at the POST /events handler with `acceptsEvent(type, config.events?.accept)`.

## Tests
- `tests/events.test.ts`: both headers are read in order; unset accept keeps the fixed list; `acme.*` accepts `acme.job.done` and refuses `other.job.done`.
- `tests/config.test.ts`: `events.accept` rejects a non-array.

## Mutation
```json
{"name":"legacy header no longer read","file":"src/core/event.ts","find":"return headers.get(EVENT_SIGNATURE_HEADER) ?? headers.get(LEGACY_EVENT_SIGNATURE_HEADER);","replace":"return headers.get(EVENT_SIGNATURE_HEADER);","test":"tests/events.test.ts"}
```

Save it as its own file `tests/mutations/legacy-header-no-longer-read.json` (a single JSON object); never edit tests/mutations.json. T1 rewrites `eventSignature`, so adjust `find` and `replace` to the text your change leaves, which must occur exactly once in the file, and make sure `tests/events.test.ts` goes red under it.

## Acceptance
- AC-1: both signature headers are read, new first: checked by `tests/events.test.ts` (T1)
- AC-2: `events.accept` globs filter types and unset keeps the fixed list: checked by `tests/events.test.ts` (T3)
- AC-3: `events.accept` is validated: checked by `tests/config.test.ts` (T2)

## Non-goals
- NG-1: the default stays the fixed list, not an empty one, so existing senders keep working.
- NG-2: no change to how events are signed on the way out.

## Files
- `src/core/event.ts`
- `src/config.ts`
- `src/watch.ts`
- `tests/events.test.ts`
- `tests/config.test.ts`
- `tests/mutations/legacy-header-no-longer-read.json` (new)

## Risk: low
## Model: sonnet

