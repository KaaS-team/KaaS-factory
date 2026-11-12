// Ported from onlook-dev/onlook@423e2e9 packages/parser/src/packages.ts
// Changed: plain JS, loaded through createRequire because @babel/standalone is a UMD bundle.
import { createRequire } from 'node:module';

const { packages } = createRequire(import.meta.url)('@babel/standalone');

export const { parse } = packages.parser;
export const { generate } = packages.generator;
export const traverse = packages.traverse.default;
export const t = packages.types;
