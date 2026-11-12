// Ported from onlook-dev/onlook@423e2e9 packages/parser/src/code-edit/insert.ts
// Changed: plain JS; assertNever replaced by a throw.
import { DATA_OID, addKeyToElement, addParamToElement, jsxFilter } from './helpers.js';
import { t } from './packages.js';
import { getAstFromCodeblock } from './parse.js';

const SELF_CLOSING = ['img', 'input', 'br', 'hr', 'meta', 'link'];

export function insertElementToNode(path, element) {
  const el = createInsertedElement(element);
  switch (element.location.type) {
    case 'append':
      path.node.children.push(el);
      break;
    case 'prepend':
      path.node.children.unshift(el);
      break;
    case 'index':
      insertAtIndex(path, el, element.location.index);
      break;
    default:
      throw new Error(`insert: unknown location ${element.location.type}`);
  }
  path.stop();
}

export function createInsertedElement(child) {
  let el;
  if (child.codeBlock) {
    el = getAstFromCodeblock(child.codeBlock, true) || createJSXElement(child);
    addParamToElement(el, DATA_OID, child.oid);
  } else el = createJSXElement(child);
  if (child.pasteParams) addParamToElement(el, DATA_OID, child.pasteParams.oid);
  addKeyToElement(el);
  return el;
}

function createJSXElement(child) {
  const attributes = Object.entries(child.attributes || {}).map(([k, v]) =>
    t.jsxAttribute(
      t.jsxIdentifier(k),
      typeof v === 'string' ? t.stringLiteral(v) : t.jsxExpressionContainer(t.stringLiteral(JSON.stringify(v))),
    ),
  );
  const selfClosing = SELF_CLOSING.includes(child.tagName.toLowerCase());
  const open = t.jsxOpeningElement(t.jsxIdentifier(child.tagName), attributes, selfClosing);
  const close = selfClosing ? null : t.jsxClosingElement(t.jsxIdentifier(child.tagName));
  const kids = [];
  if (child.textContent) kids.push(t.jsxText(child.textContent));
  kids.push(...(child.children || []).map(createJSXElement));
  return t.jsxElement(open, close, kids, selfClosing);
}

export function insertAtIndex(path, newElement, index) {
  const children = path.node.children;
  if (index === -1) throw new Error('insert: invalid index -1');
  const jsx = children.filter(jsxFilter);
  const target = jsx[Math.min(index, jsx.length)];
  if (!target) children.push(newElement);
  else children.splice(children.indexOf(target), 0, newElement);
}
