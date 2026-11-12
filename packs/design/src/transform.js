// Ported from onlook-dev/onlook@423e2e9 packages/parser/src/code-edit/transform.ts
// Changed: plain JS; group, ungroup and image actions are not ported and throw; a request whose
// oid matches no element throws (upstream silently did nothing).
import { getOidFromJsxElement } from './helpers.js';
import { insertElementToNode } from './insert.js';
import { moveElementInNode } from './move.js';
import { traverse } from './packages.js';
import { removeElementFromNode } from './remove.js';
import { addClassToNode, replaceNodeClasses, updateNodeProp } from './style.js';
import { updateNodeTextContent } from './text.js';

function applyStructureChanges(path, actions) {
  for (const action of actions || []) {
    switch (action.type) {
      case 'move':
        moveElementInNode(path, action);
        break;
      case 'insert':
        insertElementToNode(path, action);
        break;
      case 'remove':
        removeElementFromNode(path, action);
        break;
      default:
        throw new Error(`unsupported action ${action.type}`);
    }
  }
}

// transformAst applies each request (a Map of oid to request) to the element carrying that oid.
export function transformAst(ast, oidToRequest) {
  const seen = new Set();
  traverse(ast, {
    JSXElement(path) {
      const oid = getOidFromJsxElement(path.node.openingElement);
      const req = oid && oidToRequest.get(oid);
      if (!req) return;
      seen.add(oid);
      for (const [key, value] of Object.entries(req.attributes || {})) {
        if (key === 'className') {
          if (req.overrideClasses) replaceNodeClasses(path.node, value);
          else addClassToNode(path.node, value);
        } else updateNodeProp(path.node, key, value);
      }
      if (req.textContent !== undefined && req.textContent !== null) {
        updateNodeTextContent(path.node, req.textContent);
      }
      applyStructureChanges(path, req.structureChanges);
    },
  });
  for (const oid of oidToRequest.keys()) {
    if (!seen.has(oid)) throw new Error(`no element with oid ${oid}`);
  }
}
