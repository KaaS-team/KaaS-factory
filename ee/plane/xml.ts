// SPDX-License-Identifier: LicenseRef-KaaS-EE
// Just enough XML for a SAML response: a strict parser (no DTD, so no entity tricks) and
// Exclusive XML Canonicalization 1.0 without comments, which the signature is computed over.

export interface XmlElement {
  readonly kind: "element";
  readonly name: string;
  readonly attrs: [string, string][];
  readonly children: XmlNode[];
  parent: XmlElement | null;
}
export type XmlNode = XmlElement | { readonly kind: "text"; readonly text: string };

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (all, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    if (ENTITIES[e] === undefined) throw new Error(`unknown entity ${all}`);
    return ENTITIES[e]!;
  });
}

const NAME = /^[A-Za-z_][\w.:-]*/;

export function parseXml(input: string): XmlElement {
  const src = input.replace(/\r\n?/g, "\n");
  if (/<!DOCTYPE|<!ENTITY/i.test(src)) throw new Error("a DTD is not allowed");
  let i = 0;
  let root: XmlElement | null = null;
  let open: XmlElement | null = null;
  const fail = (why: string): never => {
    throw new Error(`XML: ${why} at ${i}`);
  };
  const past = (token: string) => {
    const at = src.indexOf(token, i);
    return at < 0 ? fail(`no closing ${token}`) : at + token.length;
  };
  while (i < src.length) {
    if (src.startsWith("<?", i)) i = past("?>");
    else if (src.startsWith("<!--", i)) i = past("-->");
    else if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i);
      if (end < 0 || !open) fail("bad CDATA");
      open!.children.push({ kind: "text", text: src.slice(i + 9, end) });
      i = end + 3;
    } else if (src.startsWith("</", i)) {
      const end = src.indexOf(">", i);
      const name = src.slice(i + 2, end).trim();
      if (!open || open.name !== name) fail(`unexpected </${name}>`);
      open = open!.parent;
      i = end + 1;
    } else if (src[i] === "<") {
      i++;
      const name = NAME.exec(src.slice(i))?.[0] ?? fail("bad element name");
      i += name.length;
      const el: XmlElement = { kind: "element", name, attrs: [], children: [], parent: open };
      for (;;) {
        while (/\s/.test(src[i] ?? "")) i++;
        if (src.startsWith("/>", i) || src[i] === ">") break;
        const attr = NAME.exec(src.slice(i))?.[0] ?? fail("bad attribute");
        i += attr.length;
        const m = /^\s*=\s*(["'])/.exec(src.slice(i)) ?? fail("attribute without a value");
        i += m[0].length;
        const end = src.indexOf(m[1]!, i);
        if (end < 0) fail("unclosed attribute");
        if (el.attrs.some(([n]) => n === attr)) fail(`duplicate attribute ${attr}`);
        el.attrs.push([attr, decode(src.slice(i, end).replace(/[\t\n]/g, " "))]);
        i = end + 1;
      }
      if (open) open.children.push(el);
      else if (root) fail("two root elements");
      else root = el;
      if (src.startsWith("/>", i)) i += 2;
      else {
        i++;
        open = el;
      }
    } else {
      const end = src.indexOf("<", i) < 0 ? src.length : src.indexOf("<", i);
      const text = src.slice(i, end);
      if (open) open.children.push({ kind: "text", text: decode(text) });
      else if (text.trim()) fail("text outside the root");
      i = end;
    }
  }
  if (!root || open) fail("unclosed element");
  return root!;
}

export const localName = (n: string) => n.slice(n.indexOf(":") + 1);
const prefixOf = (n: string) => (n.includes(":") ? n.slice(0, n.indexOf(":")) : "");
export const attr = (el: XmlElement, name: string) => el.attrs.find(([n]) => n === name)?.[1];

// The namespace a prefix means at this element: the nearest declaration up the tree.
export function nsOf(el: XmlElement, prefix: string): string {
  for (let e: XmlElement | null = el; e; e = e.parent) {
    const v = attr(e, prefix ? `xmlns:${prefix}` : "xmlns");
    if (v !== undefined) return v;
  }
  return prefix === "xml" ? "http://www.w3.org/XML/1998/namespace" : "";
}

export const elements = (el: XmlElement) => el.children.filter((c): c is XmlElement => c.kind === "element");

export function* descendants(el: XmlElement): Generator<XmlElement> {
  yield el;
  for (const c of elements(el)) yield* descendants(c);
}

export const isNs = (el: XmlElement, ns: string, local: string) =>
  localName(el.name) === local && nsOf(el, prefixOf(el.name)) === ns;

export const textOf = (el: XmlElement): string =>
  el.children.map((c) => (c.kind === "text" ? c.text : textOf(c))).join("");

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#xD;");
const escAttr = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xA;")
    .replace(/\r/g, "&#xD;");

// Exclusive c14n: a namespace is written where it is first visibly used, attributes sort by
// (namespace, local name), and empty elements are written open and closed. `skip` is the
// enveloped signature, left out of the digest; `inclusive` is the InclusiveNamespaces list.
export function canonicalize(el: XmlElement, skip?: XmlElement, inclusive: string[] = []): string {
  const out: string[] = [];
  const walk = (e: XmlElement, rendered: Map<string, string>) => {
    if (e === skip) return;
    const plain = e.attrs.filter(([n]) => n !== "xmlns" && !n.startsWith("xmlns:"));
    const used = new Set([prefixOf(e.name), ...plain.map(([n]) => prefixOf(n)).filter((p) => p !== "")]);
    for (const p of inclusive) if (e.attrs.some(([n]) => n === (p === "#default" ? "xmlns" : `xmlns:${p}`))) used.add(p);
    const next = new Map(rendered);
    const decls: [string, string][] = [];
    for (const p of [...used].filter((x) => x !== "xml").sort()) {
      const uri = nsOf(e, p);
      if ((rendered.get(p) ?? "") === uri) continue;
      next.set(p, uri);
      decls.push([p ? `xmlns:${p}` : "xmlns", uri]);
    }
    const key = ([n]: [string, string]) => (prefixOf(n) ? `${nsOf(e, prefixOf(n))} ${localName(n)}` : ` ${n}`);
    const sorted = [...plain].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    out.push(`<${e.name}`, ...[...decls, ...sorted].map(([n, v]) => ` ${n}="${escAttr(v)}"`), ">");
    for (const c of e.children) c.kind === "text" ? out.push(escText(c.text)) : walk(c, next);
    out.push(`</${e.name}>`);
  };
  walk(el, new Map());
  return out.join("");
}
