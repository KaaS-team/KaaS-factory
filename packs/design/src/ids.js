// Ported from onlook-dev/onlook@423e2e9 packages/parser/src/ids.ts
// Changed: plain JS; branch map dropped (we stamp one working tree, so a repeat inside the
// stamped set is the only conflict); getExistingOid kept for the dynamic guard.
import { DATA_OID, isReactFragment, randomId } from './helpers.js';
import { t, traverse } from './packages.js';

function uniqueOid(globalOids, localOids) {
  let oid;
  do oid = randomId(7);
  while (globalOids.has(oid) || localOids.has(oid));
  return oid;
}

const oidAttr = (v) => t.jSXAttribute(t.jSXIdentifier(DATA_OID), t.stringLiteral(v));

export function getAllExistingOids(attributes) {
  const indices = [];
  const values = [];
  let hasInvalid = false;
  attributes.forEach((attr, i) => {
    if (t.isJSXAttribute(attr) && attr.name.name === DATA_OID) {
      indices.push(i);
      const v = attr.value;
      if (!v || !t.isStringLiteral(v) || !v.value || v.value.trim() === '') {
        hasInvalid = true;
        values.push('');
      } else values.push(v.value);
    }
  });
  return { indices, values, hasMultiple: indices.length > 1, hasInvalid };
}

export function getExistingOid(attributes) {
  const i = attributes.findIndex((a) => t.isJSXAttribute(a) && a.name.name === DATA_OID);
  if (i === -1) return null;
  const v = attributes[i].value;
  if (!v || !t.isStringLiteral(v) || !v.value || v.value.trim() === '') {
    return { index: i, value: '', shouldRemove: true };
  }
  return { index: i, value: v.value, shouldRemove: false };
}

// addOidsToAst gives every JSX element one unique data-oid. globalOids are ids already used in
// other files; an id repeated inside this file or in globalOids is replaced.
export function addOidsToAst(ast, globalOids = new Set()) {
  let modified = false;
  const local = new Set();
  traverse(ast, {
    JSXOpeningElement(path) {
      if (isReactFragment(path.node)) return;
      const attrs = path.node.attributes;
      const all = getAllExistingOids(attrs);
      if (all.indices.length === 0) {
        const oid = uniqueOid(globalOids, local);
        attrs.push(oidAttr(oid));
        local.add(oid);
        modified = true;
      } else if (all.hasMultiple || all.hasInvalid) {
        [...all.indices].sort((a, b) => b - a).forEach((i) => attrs.splice(i, 1));
        const oid = uniqueOid(globalOids, local);
        attrs.push(oidAttr(oid));
        local.add(oid);
        modified = true;
      } else {
        const v = all.values[0];
        if (globalOids.has(v) || local.has(v)) {
          const oid = uniqueOid(globalOids, local);
          attrs[all.indices[0]].value = t.stringLiteral(oid);
          local.add(oid);
          modified = true;
        } else local.add(v);
      }
    },
  });
  return { ast, modified };
}
