// Ported from onlook-dev/onlook@423e2e9 packages/parser/src/helpers.ts and
// packages/parser/src/code-edit/helpers.ts
// Changed: plain JS, constants inlined, nanoid replaced by node:crypto, JSX attribute helpers merged.
import { randomInt } from 'node:crypto';
import { t } from './packages.js';

export const DATA_OID = 'data-oid';
export const MOVE_KEY_PREFIX = 'olk-';
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789-._:';

export function randomId(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += ID_CHARS[randomInt(ID_CHARS.length)];
  return s;
}

export function isReactFragment(openingElement) {
  const name = openingElement.name;
  if (t.isJSXIdentifier(name)) return name.name === 'Fragment';
  if (t.isJSXMemberExpression(name)) {
    return (
      t.isJSXIdentifier(name.object) &&
      name.object.name === 'React' &&
      t.isJSXIdentifier(name.property) &&
      name.property.name === 'Fragment'
    );
  }
  return false;
}

export function getOidFromJsxElement(element) {
  const attribute = element.attributes.find(
    (attr) => t.isJSXAttribute(attr) && attr.name.name === DATA_OID,
  );
  if (!attribute?.value || !t.isStringLiteral(attribute.value)) return null;
  return attribute.value.value;
}

export function addParamToElement(element, key, value, replace = false) {
  if (!t.isJSXElement(element)) return;
  const attr = t.jsxAttribute(t.jsxIdentifier(key), t.stringLiteral(value));
  const i = element.openingElement.attributes.findIndex(
    (a) => t.isJSXAttribute(a) && a.name.name === key,
  );
  if (i !== -1 && !replace) return;
  if (i !== -1) element.openingElement.attributes.splice(i, 1, attr);
  else element.openingElement.attributes.push(attr);
}

export function addKeyToElement(element, replace = false) {
  addParamToElement(element, 'key', MOVE_KEY_PREFIX + randomId(4), replace);
}

export const jsxFilter = (child) => t.isJSXElement(child) || t.isJSXFragment(child);
