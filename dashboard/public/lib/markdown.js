// GitHub comments as a node tree, drawn through the cockpit's h(). Nothing here
// builds markup from a string, so a comment can never inject an element; a link
// keeps only an http(s) target.

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)<>]+)/g;

const node = (t, a, ...c) => ({ t, a: a || {}, c });
const safeHref = (href) => (/^https?:\/\//i.test(href) ? href : null);

export function inline(text) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const [whole, code, strong, strong2, em, label, href, bare] = m;
    if (code != null) out.push(node("code", null, code));
    else if (strong != null || strong2 != null) out.push(node("strong", null, ...inline(strong ?? strong2)));
    else if (em != null) out.push(node("em", null, ...inline(em)));
    else if (label != null) out.push(safeHref(href) ? node("a", { href, target: "_blank", rel: "noreferrer" }, ...inline(label)) : whole);
    else out.push(node("a", { href: bare, target: "_blank", rel: "noreferrer" }, bare));
    at = m.index + whole.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

// GitHub keeps a single newline inside a comment paragraph as a line break.
function paragraph(lines) {
  return node("p", null, ...lines.flatMap((l, i) => (i ? [node("br"), ...inline(l.trim())] : inline(l.trim()))));
}

function cells(row) {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function listItem(text) {
  const task = /^\[( |x|X)\]\s+(.*)$/.exec(text);
  if (!task) return inline(text);
  return [node("input", { type: "checkbox", disabled: true, checked: task[1] !== " " }), " ", ...inline(task[2])];
}

// Items deeper than the list's own indent belong to the item above them.
function list(rows) {
  const base = rows[0].indent;
  const ordered = /\d/.test(rows[0].marker);
  const items = [];
  for (let i = 0; i < rows.length; i++) {
    const kids = [];
    let j = i + 1;
    while (j < rows.length && rows[j].indent > base) kids.push(rows[j++]);
    items.push(node("li", null, ...listItem(rows[i].text), ...(kids.length ? [list(kids)] : [])));
    i = j - 1;
  }
  return node(ordered ? "ol" : "ul", null, ...items);
}

export function parseMarkdown(source) {
  const lines = String(source ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/\r/g, "").split("\n");
  const blocks = [];
  let i = 0;
  const startsBlock = (l, next) => FENCE.test(l) || HEADING.test(l) || ITEM.test(l) || RULE.test(l) || QUOTE.test(l) || (l.includes("|") && next != null && TABLE_SEP.test(next));
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (FENCE.test(l)) {
      const fence = FENCE.exec(l)[1];
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence); i++) body.push(lines[i]);
      i++;
      blocks.push(node("pre", null, node("code", null, body.join("\n"))));
      continue;
    }
    const head = HEADING.exec(l);
    if (head) {
      blocks.push(node(`h${Math.min(6, head[1].length + 1)}`, null, ...inline(head[2])));
      i++;
      continue;
    }
    if (RULE.test(l)) { blocks.push(node("hr")); i++; continue; }
    if (QUOTE.test(l)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])[1]);
      blocks.push(node("blockquote", null, ...parseMarkdown(body.join("\n"))));
      continue;
    }
    if (ITEM.test(l)) {
      const rows = [];
      while (i < lines.length && lines[i].trim()) {
        const m = ITEM.exec(lines[i]);
        if (m) rows.push({ indent: m[1].length, marker: m[2], text: m[3] });
        else if (rows.length && /^\s/.test(lines[i])) rows[rows.length - 1].text += ` ${lines[i].trim()}`;
        else break;
        i++;
      }
      blocks.push(list(rows));
      continue;
    }
    if (l.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "")) {
      const header = cells(l);
      const body = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) body.push(cells(lines[i]));
      blocks.push(node("div", { class: "table-wrap" }, node("table", null,
        node("thead", null, node("tr", null, ...header.map((c) => node("th", null, ...inline(c))))),
        node("tbody", null, ...body.map((r) => node("tr", null, ...header.map((_, k) => node("td", null, ...inline(r[k] ?? "")))))))));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && (!para.length || !startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++]);
    blocks.push(paragraph(para));
  }
  return blocks;
}

// The inbox list shows a comment's first words; they read as prose, not as syntax.
export function markdownText(source) {
  const text = (n) => (typeof n === "string" ? n : n.t === "br" ? " " : n.c.map(text).join(""));
  return parseMarkdown(source).map(text).join(" ").replace(/\s+/g, " ").trim();
}

export function toDom(n, h) {
  return typeof n === "string" ? n : h(n.t, n.a, ...n.c.map((k) => toDom(k, h)));
}

export function renderMarkdown(source, h) {
  return h("div", { class: "md" }, ...parseMarkdown(source).map((n) => toDom(n, h)));
}
