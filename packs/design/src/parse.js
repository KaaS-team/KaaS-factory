// Ported from onlook-dev/onlook@423e2e9 packages/parser/src/parse.ts
// Changed: plain JS, errors thrown to the caller instead of logged, retainLines kept so diffs stay small.
import { generate, parse, t, traverse } from './packages.js';
import { DATA_OID, MOVE_KEY_PREFIX, isReactFragment } from './helpers.js';

export function getAstFromContent(content) {
  return parse(content, {
    sourceType: 'module',
    plugins: [
      'typescript',
      'jsx',
      ['decorators', { decoratorsBeforeExport: true }],
      'classStaticBlock',
      'dynamicImport',
      'importMeta',
    ],
  });
}

export function getAstFromCodeblock(code, stripIds = false) {
  let ast;
  try {
    ast = getAstFromContent(code);
  } catch {
    return undefined;
  }
  if (stripIds) removeIdsFromAst(ast);
  const node = ast.program.body.find(
    (n) => t.isExpressionStatement(n) && t.isJSXElement(n.expression),
  );
  return node?.expression;
}

export function getContentFromAst(ast, originalContent) {
  return generate(
    ast,
    {
      retainLines: true,
      compact: false,
      comments: true,
      concise: false,
      minified: false,
      jsonCompatibleStrings: false,
      shouldPrintComment: () => true,
      retainFunctionParens: true,
    },
    originalContent,
  ).code;
}

export function removeIdsFromAst(ast) {
  traverse(ast, {
    JSXOpeningElement(path) {
      if (isReactFragment(path.node)) return;
      const attrs = path.node.attributes;
      const i = attrs.findIndex((a) => a.name?.name === DATA_OID);
      if (i !== -1) attrs.splice(i, 1);
    },
    JSXAttribute(path) {
      if (path.node.name.name !== 'key') return;
      const v = path.node.value;
      if (t.isStringLiteral(v) && v.value.startsWith(MOVE_KEY_PREFIX)) path.remove();
    },
  });
}
