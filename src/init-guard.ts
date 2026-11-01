// `factory init` lets build and verify run `make *`, and a stage that can edit a Makefile can run
// anything through it. So the init config also protects the files make reads. Pure: no file access.

export const BUILD_SCRIPT_GLOBS = [
  "Makefile",
  "makefile",
  "GNUmakefile",
  "**/Makefile",
  "**/makefile",
  "**/GNUmakefile",
  "*.mk",
  "**/*.mk",
] as const;

export function withBuildScriptsProtected<T extends Record<string, unknown>>(
  config: T,
): T & { protectedPaths: string[] } {
  const have = Array.isArray(config.protectedPaths)
    ? config.protectedPaths.filter((g): g is string => typeof g === "string")
    : [];
  return { ...config, protectedPaths: [...new Set([...have, ...BUILD_SCRIPT_GLOBS])] };
}
