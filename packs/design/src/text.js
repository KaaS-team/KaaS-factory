// Ported from onlook-dev/onlook@423e2e9 packages/parser/src/code-edit/text.ts
// Changed: plain JS.
import { t } from './packages.js';

export function updateNodeTextContent(node, textContent) {
  const parts = textContent.split('\n');
  if (parts.length === 1) {
    const textNode = node.children.find((c) => t.isJSXText(c));
    if (textNode) textNode.value = textContent;
    else node.children.unshift(t.jsxText(textContent));
    return;
  }
  node.children = [];
  parts.forEach((part, i) => {
    if (part) node.children.push(t.jsxText(part));
    if (i < parts.length - 1) {
      node.children.push(
        t.jsxElement(t.jsxOpeningElement(t.jsxIdentifier('br'), [], true), null, [], true),
      );
    }
  });
}
