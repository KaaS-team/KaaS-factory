// Optional sink for retro lessons: when a brain MCP server is configured, each lesson that `factory
// learn` batches is also posted as one page, under a tenant named for the repo owner, so a lesson
// learned in one repo can reach another. With no URL and tool set, nothing is built and nothing runs.

import { bearer, McpClient } from "./integrations/mcp-client";
import type { RetroRow } from "./state";

export const SINK_ENV = {
  url: "FACTORY_BRAIN_URL",
  tool: "FACTORY_BRAIN_TOOL",
  token: "FACTORY_BRAIN_TOKEN",
} as const;

export interface BrainCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean }>;
}

export interface LessonSink {
  // How many lessons became a page. A failed post is skipped, never thrown: the lesson is already
  // in the repo's own memory, so the sink must not undo or block that.
  push(repo: string, rows: readonly RetroRow[]): Promise<number>;
}

export const tenantOf = (repo: string): string => repo.split("/")[0] ?? repo;

export function makeLessonSink(client: BrainCaller, tool: string): LessonSink {
  return {
    async push(repo, rows) {
      let posted = 0;
      for (const r of rows) {
        if (!r.lesson) continue;
        try {
          const res = await client.callTool(tool, {
            tenant: tenantOf(repo),
            title: `${repo} #${r.issue} (${r.outcome})`,
            content: r.lesson,
          });
          if (!res.isError) posted++;
        } catch {
          // Unreachable brain: leave the lesson to the repo-local file.
        }
      }
      return posted;
    },
  };
}

export function lessonSinkFromEnv(env: Readonly<Record<string, string | undefined>>): LessonSink | undefined {
  const url = env[SINK_ENV.url];
  const tool = env[SINK_ENV.tool];
  if (!url || !tool) return undefined;
  return makeLessonSink(new McpClient(url, bearer(env[SINK_ENV.token])), tool);
}
