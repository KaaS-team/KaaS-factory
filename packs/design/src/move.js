// Ported from onlook-dev/onlook@423e2e9 packages/parser/src/code-edit/move.ts
// Changed: plain JS; a missing element or target throws instead of logging, so the caller can fall back.
import { addKeyToElement, getOidFromJsxElement, jsxFilter } from './helpers.js';

export function moveElementInNode(path, element) {
  const children = path.node.children;
  const jsx = children.filter(jsxFilter);
  const moving = jsx.find(
    (c) => c.type === 'JSXElement' && getOidFromJsxElement(c.openingElement) === element.oid,
  );
  if (!moving) throw new Error(`move: element ${element.oid} is not a child of the target`);
  addKeyToElement(moving);
  const target = jsx[Math.min(element.location.index, jsx.length)];
  if (!target) throw new Error('move: target child not found');
  const targetIndex = children.indexOf(target);
  children.splice(children.indexOf(moving), 1);
  children.splice(targetIndex, 0, moving);
}
