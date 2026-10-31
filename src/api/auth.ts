// The token gate: FACTORY_API_TOKEN in the environment, `Authorization: Bearer <token>` on the request.

import { timingSafeEqual } from "node:crypto";

export type ApiAuth = (req: Request) => boolean;

export function tokenAuth(env: Record<string, string | undefined>): ApiAuth {
  const token = env.FACTORY_API_TOKEN;
  // An unset or empty token refuses every token route instead of letting any caller in.
  if (!token) return () => false;
  const expected = Buffer.from(token);
  return (req) => {
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return false;
    const given = Buffer.from(match[1]!);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
}
