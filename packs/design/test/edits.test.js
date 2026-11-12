// Tests for the apply-edits, oid-stamp and tweak commands. Each edit kind has a row; the
// fallback rows cover every Fallback code.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Fallback, applyEdits, main, stampDir, tweak } from '../src/cli.js';

const SRC = `export function App({ items, on }) {
  return (
    <div data-oid="root" className="p-2 flex">
      <h1 data-oid="h">Hello</h1>
      <p data-oid="p">One</p>
      <em data-oid="e">Two</em>
      {on && <span data-oid="cond">x</span>}
      {items.map((i) => <li key={i} data-oid="item">{i}</li>)}
    </div>
  );
}
`;
const req = (o) => ({ branchId: '', attributes: {}, textContent: null, overrideClasses: null, structureChanges: [], ...o });
const gen = (r, opts) => applyEdits(SRC, [req(r)], opts).generated;

test('style: a class is merged, conflicting utilities are replaced', () => {
  const g = gen({ oid: 'root', attributes: { className: 'p-4' } });
  assert.match(g, /className="flex p-4"/);
});

test('style: overrideClasses replaces the whole list', () => {
  assert.match(gen({ oid: 'root', attributes: { className: 'grid' }, overrideClasses: true }), /className="grid"/);
});

test('style: an element without className gets one', () => {
  assert.match(gen({ oid: 'h', attributes: { className: 'text-xl' } }), /<h1 data-oid="h" className="text-xl">/);
});

test('text: the text child is replaced', () => {
  assert.match(gen({ oid: 'h', textContent: 'Bye' }), /<h1 data-oid="h">Bye<\/h1>/);
});

test('remove: the element is gone and siblings stay', () => {
  const g = gen({ oid: 'p', structureChanges: [{ type: 'remove', oid: 'p', codeBlock: null }] });
  assert.ok(!g.includes('One'));
  assert.ok(g.includes('Hello') && g.includes('Two'));
});

test('move: the child lands before the target index', () => {
  const g = gen({ oid: 'root', structureChanges: [{ type: 'move', oid: 'e', location: { type: 'index', index: 0, originalIndex: 2 } }] });
  assert.ok(g.indexOf('Two') < g.indexOf('Hello'));
});

test('insert: an element is appended', () => {
  const g = gen({ oid: 'root', structureChanges: [{ type: 'insert', tagName: 'hr', attributes: {}, textContent: null, pasteParams: null, codeBlock: null, children: [], oid: 'new', location: { type: 'append' } }] });
  assert.match(g, /<hr/);
});

test('only the edited line differs, plus the upstream closing-paren reflow', () => {
  const a = SRC.split('\n');
  const b = gen({ oid: 'h', textContent: 'Bye' }).split('\n');
  const changed = a.filter((l) => !b.includes(l));
  assert.deepEqual(changed, ['      <h1 data-oid="h">Hello</h1>', '    </div>', '  );']);
});

test('strip-ids: no data-oid and no olk- key is left', () => {
  const g = gen({ oid: 'p', structureChanges: [{ type: 'remove', oid: 'p', codeBlock: null }] }, { stripIds: true });
  assert.ok(!g.includes('data-oid'));
  assert.ok(!g.includes('olk-'));
});

test('without strip-ids the oids stay', () => {
  assert.ok(gen({ oid: 'h', textContent: 'Bye' }).includes('data-oid="root"'));
});

const fallbacks = [
  ['missing oid', req({ oid: 'nope', textContent: 'x' }), 'missing-oid'],
  ['conditional node', req({ oid: 'cond', textContent: 'x' }), 'dynamic'],
  ['array node', req({ oid: 'item', attributes: { className: 'a' } }), 'dynamic'],
  ['group action', req({ oid: 'root', structureChanges: [{ type: 'group' }] }), 'unsupported'],
  ['move of a non-child', req({ oid: 'root', structureChanges: [{ type: 'move', oid: 'zzz', location: { type: 'index', index: 0 } }] }), 'unsupported'],
];
for (const [name, r, code] of fallbacks) {
  test(`fallback: ${name}`, () => {
    assert.throws(() => applyEdits(SRC, [r]), (e) => e instanceof Fallback && e.code === code);
  });
}

test('fallback: source that does not parse', () => {
  assert.throws(() => applyEdits('<div', []), (e) => e.code === 'parse');
});

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'design-'));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
  return dir;
}

test('tweak: a style, a text and a remove change land in the files', () => {
  const dir = tree({ 'App.tsx': SRC });
  const r = tweak(dir, { changes: [
    { file: 'App.tsx', oid: 'root', kind: 'style', className: 'p-4' },
    { file: 'App.tsx', oid: 'h', kind: 'text', text: 'Bye' },
    { file: 'App.tsx', oid: 'p', kind: 'remove' },
  ] });
  assert.deepEqual(r.applied, ['App.tsx']);
  const out = readFileSync(join(dir, 'App.tsx'), 'utf8');
  assert.ok(out.includes('Bye') && !out.includes('One') && out.includes('p-4'));
});

test('tweak: a move change lands', () => {
  const dir = tree({ 'App.tsx': SRC });
  tweak(dir, { changes: [{ file: 'App.tsx', kind: 'move', oid: 'e', parent: 'root', index: 0 }] });
  const out = readFileSync(join(dir, 'App.tsx'), 'utf8');
  assert.ok(out.indexOf('Two') < out.indexOf('Hello'));
});

test('tweak: one dynamic change leaves every file untouched', () => {
  const dir = tree({ 'App.tsx': SRC, 'B.tsx': SRC });
  assert.throws(() => tweak(dir, { changes: [
    { file: 'B.tsx', oid: 'h', kind: 'text', text: 'Bye' },
    { file: 'App.tsx', oid: 'cond', kind: 'text', text: 'y' },
  ] }), (e) => e.code === 'dynamic');
  assert.equal(readFileSync(join(dir, 'B.tsx'), 'utf8'), SRC);
});

test('tweak: a layout change needs an agent', () => {
  const dir = tree({ 'App.tsx': SRC });
  assert.throws(() => tweak(dir, { changes: [{ file: 'App.tsx', oid: 'h', kind: 'group' }] }), (e) => e.code === 'unsupported-kind');
});

test('tweak: an empty delta falls back', () => {
  assert.throws(() => tweak(tree({}), { changes: [] }), (e) => e.code === 'empty');
});

test('oid-stamp: oids are unique across files and a second run changes nothing', () => {
  const dir = tree({ 'A.tsx': '<div><b/></div>', 'B.tsx': '<div data-oid="x"/>', 'C.tsx': '<div data-oid="x"/>', 'n.txt': 'ignore' });
  assert.equal(stampDir(dir).length, 2);
  const all = ['A.tsx', 'B.tsx', 'C.tsx'].flatMap((f) => [...readFileSync(join(dir, f), 'utf8').matchAll(/data-oid="([^"]*)"/g)].map((m) => m[1]));
  assert.equal(all.length, 4);
  assert.equal(new Set(all).size, 4);
  assert.equal(stampDir(dir).length, 0);
});

test('cli: apply-edits reads {file, requests} and returns {original, generated}', () => {
  const dir = tree({ 'App.tsx': SRC });
  const file = join(dir, 'App.tsx');
  const r = main(['apply-edits', '--strip-ids'], () => JSON.stringify({ file, requests: [req({ oid: 'h', textContent: 'Bye' })] }));
  assert.equal(r.code, 0);
  assert.equal(r.out.original, SRC);
  assert.ok(r.out.generated.includes('Bye') && !r.out.generated.includes('data-oid'));
});

test('cli: a dynamic request exits 2 with the oid; bad usage exits 1', () => {
  const dir = tree({ 'App.tsx': SRC });
  const r = main(['apply-edits'], () => JSON.stringify({ file: join(dir, 'App.tsx'), requests: [req({ oid: 'cond', textContent: 'y' })] }));
  assert.deepEqual([r.code, r.out.error, r.out.oid], [2, 'dynamic', 'cond']);
  assert.equal(main(['nope']).code, 1);
});

test('tweak: a file outside the tree is refused and nothing is written', () => {
  const dir = tree({ 'App.tsx': SRC });
  const outside = join(dir, '..', 'design-outside.tsx');
  writeFileSync(outside, SRC);
  for (const file of ['../design-outside.tsx', outside, '']) {
    assert.throws(() => tweak(dir, { changes: [{ file, oid: 'e', kind: 'remove' }] }), (e) => e.code === 'bad-path');
  }
  assert.equal(readFileSync(outside, 'utf8'), SRC);
});
