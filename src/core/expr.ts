// The `if:` language of a workflow edge: dotted paths into the step context,
// string/number/boolean/null literals, == and !=, !, && and ||, parentheses.
// Nothing else, so an edge condition can never call code. Parsed when the
// workflow loads, so a typo fails at boot, not halfway through an issue.

export type Expr =
  | { readonly op: "lit"; readonly value: string | number | boolean | null }
  | { readonly op: "path"; readonly path: readonly string[] }
  | { readonly op: "not"; readonly arg: Expr }
  | { readonly op: "==" | "!=" | "&&" | "||"; readonly left: Expr; readonly right: Expr };

export class ExprError extends Error {}

const TOKEN =
  /\s*(?:(\d+(?:\.\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)|(==|!=|&&|\|\||!|\(|\)))/y;

function tokenize(src: string): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(TOKEN.lastIndex))) break;
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(src);
    if (!m) throw new ExprError(`unexpected "${src.slice(at).trim().slice(0, 12)}" at ${at}`);
    out.push(m[0].trim());
  }
  return out;
}

export function parseExpr(src: string): Expr {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const take = (t?: string) => {
    const got = tokens[i];
    if (t !== undefined && got !== t)
      throw new ExprError(`expected "${t}", got ${got === undefined ? "the end" : `"${got}"`}`);
    i += 1;
    return got;
  };
  const primary = (): Expr => {
    const t = take();
    if (t === undefined) throw new ExprError("unexpected end of expression");
    if (t === "(") {
      const inner = or();
      take(")");
      return inner;
    }
    if (/^\d/.test(t)) return { op: "lit", value: Number(t) };
    if (t.startsWith("'") || t.startsWith('"')) return { op: "lit", value: t.slice(1, -1).replace(/\\(.)/g, "$1") };
    if (t === "true" || t === "false") return { op: "lit", value: t === "true" };
    if (t === "null") return { op: "lit", value: null };
    if (/^[A-Za-z_]/.test(t)) return { op: "path", path: t.split(".") };
    throw new ExprError(`unexpected "${t}"`);
  };
  const cmp = (): Expr => {
    const left = primary();
    const t = peek();
    if (t === "==" || t === "!=") {
      take();
      return { op: t, left, right: primary() };
    }
    return left;
  };
  const not = (): Expr => {
    if (peek() === "!") {
      take();
      return { op: "not", arg: not() };
    }
    return cmp();
  };
  const and = (): Expr => {
    let left = not();
    while (peek() === "&&") {
      take();
      left = { op: "&&", left, right: not() };
    }
    return left;
  };
  const or = (): Expr => {
    let left = and();
    while (peek() === "||") {
      take();
      left = { op: "||", left, right: and() };
    }
    return left;
  };
  if (tokens.length === 0) throw new ExprError("empty expression");
  const expr = or();
  if (i < tokens.length) throw new ExprError(`unexpected "${tokens[i]}" after a complete expression`);
  return expr;
}

// A path that does not resolve is undefined, which is falsy and equals only itself.
export function evalExpr(expr: Expr, ctx: Readonly<Record<string, unknown>>): unknown {
  switch (expr.op) {
    case "lit":
      return expr.value;
    case "path": {
      let v: unknown = ctx;
      for (const k of expr.path)
        v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
      return v;
    }
    case "not":
      return !evalExpr(expr.arg, ctx);
    case "==":
      return evalExpr(expr.left, ctx) === evalExpr(expr.right, ctx);
    case "!=":
      return evalExpr(expr.left, ctx) !== evalExpr(expr.right, ctx);
    case "&&":
      return Boolean(evalExpr(expr.left, ctx)) && Boolean(evalExpr(expr.right, ctx));
    case "||":
      return Boolean(evalExpr(expr.left, ctx)) || Boolean(evalExpr(expr.right, ctx));
  }
}

// The first path segment of every path an expression reads, for checking them against known names.
export function rootsOf(expr: Expr): string[] {
  switch (expr.op) {
    case "lit":
      return [];
    case "path":
      return [expr.path[0]!];
    case "not":
      return rootsOf(expr.arg);
    default:
      return [...rootsOf(expr.left), ...rootsOf(expr.right)];
  }
}
