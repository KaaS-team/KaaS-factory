// Ported from onlook-dev/onlook@423e2e9 packages/parser/src/code-edit/style.ts
// Changed: plain JS; customTwMerge replaced by tailwind-merge's twMerge (no background dedupe).
import { twMerge } from 'tailwind-merge';
import { t } from './packages.js';

const findAttr = (el, key) =>
  el.attributes.find((a) => t.isJSXAttribute(a) && a.name.name === key);

export function addClassToNode(node, className) {
  const open = node.openingElement;
  const attr = findAttr(open, 'className');
  if (!attr) {
    open.attributes.push(t.jsxAttribute(t.jsxIdentifier('className'), t.stringLiteral(className)));
  } else if (t.isStringLiteral(attr.value)) {
    attr.value.value = twMerge(attr.value.value, className);
  } else if (t.isJSXExpressionContainer(attr.value) && t.isCallExpression(attr.value.expression)) {
    attr.value.expression.arguments.push(t.stringLiteral(className));
  }
}

export function replaceNodeClasses(node, className) {
  const open = node.openingElement;
  const attr = findAttr(open, 'className');
  if (attr) attr.value = t.stringLiteral(className);
  else open.attributes.push(t.jsxAttribute(t.jsxIdentifier('className'), t.stringLiteral(className)));
}

function propValue(value) {
  if (typeof value === 'boolean') return t.jsxExpressionContainer(t.booleanLiteral(value));
  if (typeof value === 'string') return t.stringLiteral(value);
  return t.jsxExpressionContainer(t.identifier(String(value)));
}

export function updateNodeProp(node, key, value) {
  if (value === undefined || value === null) return;
  const open = node.openingElement;
  const existing = findAttr(open, key);
  if (existing) existing.value = propValue(value);
  else open.attributes.push(t.jsxAttribute(t.jsxIdentifier(key), propValue(value)));
}
