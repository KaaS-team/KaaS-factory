// `uses: mcp`: a deterministic tool call, no agent and no tokens. `run: <server>/<tool>` names an
// HTTP server in the base branch's .factory/mcp.json; the tool gets the issue's number and title.
// A tool error parks the issue as failed, the same way a red `check` step does.

import { mcpServersFor } from "../mcp";
import { LABEL } from "../labels";
import { McpClient, type ToolResult } from "../integrations/mcp-client";
import { finish, moveLabel, postComment } from "./common";
import type { StepResult, StepType } from "./steps";

interface HttpServer {
  type?: string;
  url?: string;
  headers?: Record<string, string>;
}

// ${VAR} in a header keeps a token in the env. Only FACTORY_MCP_* names expand: a workflow names the
// URL, so any other name (GH_TOKEN, the agent's key) would let it send a runner secret anywhere.
export const MCP_VAR = /^FACTORY_MCP_\w+$/;
const expand = (v: string, env: NodeJS.ProcessEnv) =>
  v.replace(/\$\{(\w+)\}/g, (_, k: string) => {
    if (!MCP_VAR.test(k)) throw new Error(`mcp header names \${${k}}; only FACTORY_MCP_* variables expand`);
    return env[k] ?? "";
  });

export function mcpTarget(run: string, cloneDir: string, env: NodeJS.ProcessEnv = process.env) {
  const [server = "", tool = ""] = run.trim().split("/");
  const spec = mcpServersFor(cloneDir, [server])[server] as HttpServer;
  if (!spec.url) throw new Error(`mcp server "${server}" has no url; a uses: mcp step calls HTTP servers only`);
  const headers = Object.fromEntries(Object.entries(spec.headers ?? {}).map(([k, v]) => [k, expand(v, env)]));
  return { client: new McpClient(spec.url, headers), tool };
}

export const mcpStep: StepType = {
  command: true,
  async run({ deps, config, issue, step }): Promise<StepResult> {
    const failed = (e: Error): ToolResult => ({ isError: true, content: [{ type: "text", text: e.message }] });
    const r: ToolResult = await Promise.resolve()
      .then(() => mcpTarget(step.run!, deps.cloneDir))
      .then(({ client, tool }) => client.callTool(tool, { issue: issue.number, title: issue.title }))
      .catch(failed);
    const text = r.content?.find((c) => c.type === "text")?.text ?? "";
    if (!r.isError) return { kind: "next", facts: r.structuredContent ?? { ok: true, text } };
    await postComment(
      deps,
      config,
      issue.number,
      `Step \`${step.id}\` failed: the MCP tool \`${step.run}\` returned an error.`,
      {
        stage: step.id,
        json: { ok: false },
      },
    );
    await moveLabel(deps, config, issue.number, step.label, LABEL.failed);
    finish(deps, config, issue.number, "failed", `${step.id}: mcp ${step.run} failed`);
    return { kind: "stop", outcome: "failed" };
  },
};
