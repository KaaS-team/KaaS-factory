Add rate limiting to the public API so one client cannot slow the others.

AC-1: a bucket allows N calls per window and then refuses
AC-2: a call with a token is keyed by the token, else by IP
AC-3: the middleware refuses over-limit calls with status 429
AC-4: every public route is behind the limit
AC-5: a 429 carries a Retry-After header and a short JSON error

--- ticket T1: Add a token bucket
<!-- factory:planned v1 -->
Deps: none
## Why
Nothing limits how often one client can call the API, so one noisy client can slow everyone.

## Acceptance
- AC-1: a bucket allows N calls per window and then refuses

## Files
- `src/ratelimit.ts`
- `tests/ratelimit.test.ts`
--- ticket T2: Key each call by client
<!-- factory:planned v1 -->
Deps: none
## Why
The limiter needs a stable key per caller. Today a call has no key.

## Acceptance
- AC-2: a call with a token is keyed by the token, else by IP

## Files
- `src/clientkey.ts`
- `tests/clientkey.test.ts`
--- ticket T3: Add the rate limit middleware
<!-- factory:planned v1 -->
Deps: T1, T2
## Why
The bucket and the key exist but no request passes through them.

## Acceptance
- AC-3: the middleware refuses over-limit calls with status 429

## Files
- `src/middleware/ratelimit.ts`
- `tests/middleware-ratelimit.test.ts`
--- ticket T4: Wire the middleware into the server
<!-- factory:planned v1 -->
Deps: T3
## Why
The server does not use the middleware, so the public routes stay open.

## Acceptance
- AC-4: every public route is behind the limit

## Files
- `src/server.ts`
- `tests/server.test.ts`
--- ticket T5: Return a clear 429 body
<!-- factory:planned v1 -->
Deps: T3
## Why
A refused client gets no hint about when to retry.

## Acceptance
- AC-5: a 429 carries a Retry-After header and a short JSON error

## Files
- `src/routes/errors.ts`
- `src/server.ts`
