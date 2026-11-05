// What the factory signs its outputs with: a PR body footer, a commit trailer and the --version line.
// Customers read all three, so none carries a model name, a token count or a dollar figure (#210).

export const BRAND_URL = "https://kaas.team";
export const DEFAULT_FOOTER = `Shipped with [KaaS Factory](${BRAND_URL})`;
export const SHIPPED_WITH = `Shipped-with: KaaS Factory (${BRAND_URL})`;

const MODEL_NAME = /\b(claude|anthropic|opus|sonnet|haiku|fable|gpt|openai|gemini|codex|o[134]-|llama|mistral)\b/i;
const MONEY = /[$€£]\s?\d|\b\d[\d,.]*\s?(usd|dollars?|tokens?)\b/i;

// Why a branded line is not fit for a customer, or none.
export function brandLineProblems(line: string, what: string): string[] {
  const out: string[] = [];
  if (MODEL_NAME.test(line)) out.push(`${what}: names a model or provider`);
  if (MONEY.test(line)) out.push(`${what}: carries a dollar figure or token count`);
  return out;
}

// The PR body footer: the configured text, else the default. Throws when the config would leak.
export function brandFooter(configured?: string): string {
  const footer = configured ?? DEFAULT_FOOTER;
  const found = [...brandLineProblems(footer, "footer"), ...footerLinkProblems(footer)];
  if (found.length) throw new Error(`brand footer is not allowed:\n- ${found.join("\n- ")}`);
  return footer;
}

const footerLinkProblems = (footer: string): string[] =>
  /https?:\/\/(www\.)?kaas\.team(?![\w.-])/.test(footer) ? [] : [`footer: must link to ${BRAND_URL}`];

export function brandProblems(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["brand: expected an object"];
  const out: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("_")) continue;
    if (key !== "footer") out.push(`brand.${key}: unknown key (allowed: footer)`);
    else if (typeof value !== "string" || !value.trim()) out.push("brand.footer: expected a non-empty string");
    else out.push(...brandLineProblems(value, "brand.footer"), ...footerLinkProblems(value).map((p) => `brand.${p}`));
  }
  return out;
}

export const versionLine = (version: string): string => `${version} (${BRAND_URL})`;
