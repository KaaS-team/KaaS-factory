// Ported from onlook-dev/onlook@423e2e9 packages/parser/test/ids.test.ts and parse.test.ts
// Changed: node:test instead of bun:test; the branch-aware cases are dropped with the branch map
// and replaced by the cross-file oid cases.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addOidsToAst } from '../src/ids.js';
import { getAstFromContent, getContentFromAst } from '../src/parse.js';

const here = new URL('.', import.meta.url).pathname;
const sanitize = (s) => s.replace(/data-oid="[^"]*"/g, 'data-oid="REPLACED_OIDS"');

function cases(dir) {
  const root = join(here, 'data', dir);
  return readdirSync(root).map((name) => {
    const files = readdirSync(join(root, name));
    const read = (p) => readFileSync(join(root, name, files.find((f) => f.startsWith(p))), 'utf8');
    return { name, input: read('input.'), expected: read('expected.') };
  });
}

for (const c of cases('ids')) {
  test(`ids: ${c.name}`, () => {
    const { ast } = addOidsToAst(getAstFromContent(c.input));
    assert.equal(sanitize(getContentFromAst(ast, c.input)), sanitize(c.expected));
  });
}

for (const c of cases('parse')) {
  test(`parse: ${c.name}`, () => {
    assert.equal(getContentFromAst(getAstFromContent(c.input), c.input), c.expected);
  });
}

const oids = (s) => [...s.matchAll(/data-oid="([^"]*)"/g)].map((m) => m[1]);

test('ids: a duplicate inside one file keeps the first and replaces the second', () => {
  const src = '<div><b data-oid="dup">a</b><i data-oid="dup">b</i><p>c</p></div>';
  const { ast, modified } = addOidsToAst(getAstFromContent(src));
  const ids = oids(getContentFromAst(ast, src));
  assert.ok(modified);
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4);
  assert.equal(ids.filter((i) => i === 'dup').length, 1);
});

test('ids: an oid used by another file is replaced', () => {
  const src = '<div data-oid="taken">x</div>';
  const { ast, modified } = addOidsToAst(getAstFromContent(src), new Set(['taken']));
  assert.ok(modified);
  assert.ok(!oids(getContentFromAst(ast, src)).includes('taken'));
});

test('ids: a valid unique oid is left alone', () => {
  const src = '<div data-oid="mine">x</div>';
  const { modified } = addOidsToAst(getAstFromContent(src), new Set(['other']));
  assert.equal(modified, false);
});

test('ids: several oid attributes on one element collapse to one', () => {
  const src = '<div data-oid="a" data-oid="b">x</div>';
  const { ast } = addOidsToAst(getAstFromContent(src));
  assert.equal(oids(getContentFromAst(ast, src)).length, 1);
});
