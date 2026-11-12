// Ported from onlook-dev/onlook@423e2e9 packages/parser/src/code-edit/remove.ts
// Changed: plain JS; removeElementAtIndex dropped (unused by transform).
import { addKeyToElement, jsxFilter } from './helpers.js';

export function removeElementFromNode(path) {
  const parentPath = path.parentPath;
  if (!parentPath) throw new Error('remove: no parent path');
  const siblings = parentPath.node.children?.filter(jsxFilter) || [];
  path.remove();
  siblings.forEach((s) => addKeyToElement(s));
  path.stop();
}
