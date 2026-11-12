// apply-edits, oid-stamp and tweak: the three commands of the design pack. New code, not ported.
// Exit codes: 0 done, 2 the edit cannot be made deterministically (the caller falls back to an
// agent), 1 a usage or I/O error. Every result is one JSON object on stdout.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { findDynamicOids } from './dynamic.js';
import { getOidFromJsxElement } from './helpers.js';
import { addOidsToAst } from './ids.js';
import { getAstFromContent, getContentFromAst, removeIdsFromAst } from './parse.js';
import { traverse } from './packages.js';
import { transformAst } from './transform.js';

export class Fallback extends Error {
  constructor(code, message, oid) {
    super(message);
    this.code = code;
    this.oid = oid;
  }
}

function oidsIn(ast) {
  const s = new Set();
  traverse(ast, { JSXOpeningElement(p) { const o = getOidFromJsxElement(p.node); if (o) s.add(o); } });
  return s;
}

// applyEdits returns {original, generated} for source with requests applied. A request whose oid
// is absent or sits in a dynamic node throws Fallback before anything is changed.
export function applyEdits(original, requests, { stripIds = false } = {}) {
  let ast;
  try {
    ast = getAstFromContent(original);
  } catch (e) {
    throw new Fallback('parse', e.message);
  }
  const present = oidsIn(ast);
  const dynamic = findDynamicOids(ast);
  const byOid = new Map();
  for (const r of requests) {
    if (!present.has(r.oid)) throw new Fallback('missing-oid', `no element with oid ${r.oid}`, r.oid);
    if (dynamic.has(r.oid)) throw new Fallback('dynamic', `oid ${r.oid} is in a ${dynamic.get(r.oid)} node`, r.oid);
    byOid.set(r.oid, r);
  }
  try {
    transformAst(ast, byOid);
  } catch (e) {
    throw new Fallback('unsupported', e.message);
  }
  if (stripIds) removeIdsFromAst(ast);
  return { original, generated: getContentFromAst(ast, original) };
}

const JSX_FILE = /\.(jsx|tsx)$/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (JSX_FILE.test(name)) yield p;
  }
}

// stampDir stamps every JSX and TSX file under dir so each element has one oid, unique across
// the tree. It rewrites only files that changed and returns their paths.
export function stampDir(dir) {
  const files = [...walk(dir)].sort();
  const parsed = files.map((f) => ({ f, src: readFileSync(f, 'utf8') }));
  const taken = new Set();
  const changed = [];
  for (const p of parsed) {
    const ast = getAstFromContent(p.src);
    const { modified } = addOidsToAst(ast, taken);
    for (const o of oidsIn(ast)) taken.add(o);
    if (modified) {
      writeFileSync(p.f, getContentFromAst(ast, p.src));
      changed.push(p.f);
    }
  }
  return changed;
}

// requestsFor turns delta changes for one file into CodeDiffRequests, or throws Fallback.
export function requestsFor(changes) {
  const out = [];
  for (const c of changes) {
    const base = { oid: c.oid, branchId: '', attributes: {}, textContent: null, overrideClasses: null, structureChanges: [] };
    switch (c.kind) {
      case 'style':
        out.push({ ...base, attributes: { className: c.className }, overrideClasses: !!c.override });
        break;
      case 'text':
        out.push({ ...base, textContent: c.text });
        break;
      case 'remove':
        out.push({ ...base, structureChanges: [{ type: 'remove', oid: c.oid, codeBlock: null }] });
        break;
      case 'move':
        out.push({ ...base, oid: c.parent, structureChanges: [{ type: 'move', oid: c.oid, location: { type: 'index', index: c.index, originalIndex: c.originalIndex ?? 0, targetDomId: '', targetOid: c.parent } }] });
        break;
      default:
        throw new Fallback('unsupported-kind', `change kind ${c.kind} needs an agent`, c.oid);
    }
  }
  return out;
}

// tweak applies a design delta {changes: [{file, oid, kind, ...}]} to files under dir. All files
// are computed first and written only if every change applies.
export function tweak(dir, delta, opts) {
  const byFile = new Map();
  for (const c of delta.changes || []) {
    // A delta file is data from a design tool: it must name a file inside dir.
    const rel = typeof c.file === 'string' ? relative(dir, join(dir, c.file)) : '..';
    if (!c.file || isAbsolute(c.file) || rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Fallback('bad-path', `change file ${JSON.stringify(c.file)} is not inside the tree`, c.oid);
    }
  }
  for (const c of delta.changes || []) byFile.set(c.file, [...(byFile.get(c.file) || []), c]);
  if (byFile.size === 0) throw new Fallback('empty', 'the delta has no changes');
  const results = [];
  for (const [file, changes] of byFile) {
    const original = readFileSync(join(dir, file), 'utf8');
    results.push({ file, ...applyEdits(original, requestsFor(changes), opts) });
  }
  for (const r of results) writeFileSync(join(dir, r.file), r.generated);
  return { applied: results.map((r) => r.file) };
}

export function main(argv, readStdin = () => readFileSync(0, 'utf8')) {
  const [cmd, ...rest] = argv;
  const flags = rest.filter((a) => a.startsWith('--'));
  const args = rest.filter((a) => !a.startsWith('--'));
  const opts = { stripIds: flags.includes('--strip-ids') };
  try {
    if (cmd === 'apply-edits') {
      const { file, requests } = JSON.parse(readStdin());
      const r = applyEdits(readFileSync(file, 'utf8'), requests, opts);
      return { code: 0, out: { ...r, path: file } };
    }
    if (cmd === 'oid-stamp' && args.length === 1) return { code: 0, out: { stamped: stampDir(args[0]) } };
    if (cmd === 'tweak' && args.length === 2) return { code: 0, out: tweak(args[0], JSON.parse(readFileSync(args[1], 'utf8')), opts) };
  } catch (e) {
    if (e instanceof Fallback) return { code: 2, out: { error: e.code, oid: e.oid, message: e.message } };
    return { code: 1, out: { error: 'failed', message: e.message } };
  }
  return { code: 1, out: { error: 'usage', message: 'apply-edits | oid-stamp <dir> | tweak <dir> <delta.json> [--strip-ids]' } };
}
