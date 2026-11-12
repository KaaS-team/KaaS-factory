// Ported from onlook-dev/onlook@423e2e9 packages/parser/src/template-node/map.ts (getDynamicTypeInfo)
// Changed: plain JS; returns only an oid to dynamic type map, and also counts any element nested
// inside a conditional or a .map callback, which upstream tracked with a stack.
import { isReactFragment } from './helpers.js';
import { getExistingOid } from './ids.js';
import { t, traverse } from './packages.js';

function rootType(path) {
  const parent = path.parent;
  const grand = path.parentPath?.parent;
  if ((t.isConditionalExpression(parent) || t.isLogicalExpression(parent)) && t.isJSXExpressionContainer(grand)) {
    return 'conditional';
  }
  if (
    t.isArrowFunctionExpression(parent) ||
    (t.isJSXFragment(parent) && path.parentPath?.parentPath?.isArrowFunctionExpression())
  ) {
    return 'array';
  }
  return null;
}

const isMapCallback = (p) => p.parent?.type === 'CallExpression' && p.parent.callee?.property?.name === 'map';
const isLogic = (p) => p.node.operator === '&&' || p.node.operator === '||';

// findDynamicOids maps each stamped oid to 'array' or 'conditional' when its element is the root
// of, or sits inside, a map callback or a conditional.
export function findDynamicOids(ast) {
  const out = new Map();
  let conditional = 0;
  let array = 0;
  traverse(ast, {
    ConditionalExpression: { enter() { conditional++; }, exit() { conditional--; } },
    LogicalExpression: {
      enter(p) { if (isLogic(p)) conditional++; },
      exit(p) { if (isLogic(p)) conditional--; },
    },
    ArrowFunctionExpression: {
      enter(p) { if (isMapCallback(p)) array++; },
      exit(p) { if (isMapCallback(p)) array--; },
    },
    JSXElement(path) {
      if (isReactFragment(path.node.openingElement)) return;
      const oid = getExistingOid(path.node.openingElement.attributes);
      if (!oid || oid.shouldRemove) return;
      const type = rootType(path) || (array > 0 ? 'array' : conditional > 0 ? 'conditional' : null);
      if (type) out.set(oid.value, type);
    },
  });
  return out;
}
