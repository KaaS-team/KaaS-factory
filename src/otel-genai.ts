// OpenTelemetry GenAI semantic-convention span names. An agent span is `invoke_agent {agent name}` and a
// model call is `{operation} {model}`; the stage goes in the factory.stage attribute, not the name.

export const GENAI_OP = { agent: "invoke_agent", model: "chat" } as const;

export const agentSpanName = (agent: string) => `${GENAI_OP.agent} ${agent}`;
export const modelSpanName = (model: string) => `${GENAI_OP.model} ${model}`;
