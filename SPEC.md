<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E0 Install
Milestone: Phase 5 distribution
Runner: operator

## Risk: medium

## Why
A person should install the factory by downloading one file, with no Bun and no clone of this repo. `bun build --compile` already makes a working `factory` binary, but every command that reads the template fails in it, because the template is read from disk next to `src/`. E0 T2 embeds `template/` and `template-ci/` in the binary, builds it for darwin and linux on x64 and arm64, adds `factory --version`, and proves the host binary runs `--version` and `init` in `make check`.

## Today
- `bun build --compile --target=bun-darwin-arm64 src/cli.ts --outfile <dir>/factory` bundles 222 modules into a 64 MB binary; `--help` works. `factory init --repo-dir <tmp>` then fails with `factory: no template/ next to the runner (/$bunfs/template)`. With `bin/factory` as the entry it bundles 1 module and the binary prints nothing, so the entry is `src/cli.ts`.
- There is no `install.sh` any more; `factory install` (`src/install-template.ts`) replaced it. `factory init` (`src/init-cli.ts:58`) calls the same installer when `.factory/gates.sh` is missing.
- Template readers that resolve from the source tree: `src/install-template.ts:58` (`root`, used by `bundledFiles` at `:68` for `template/` and `template-ci/factory.yml.example`), `src/init-cli.ts:70` and `:79` (`config.example.json`, `charter.md`), `src/harness-defaults.ts:18` (`DEFAULTS_DIR`), `src/engine/workflows.ts:19` (`BUNDLED_DIR`), `src/cli.ts:413` (`templateSkills`).
- `src/cli-runtime.ts:99` reads `../package.json` from disk for the version. `src/cli.ts` has no `--version`; `factory --version` prints help and exits 1.
- `quality-baseline.json` freezes `src/cli.ts` at 985 lines and `tests/quality.test.ts` fails when it grows or when the baseline is above the file's size.
- `Bun.build({ compile: { target, outfile }, define })` built all four targets in a prototype: Mach-O arm64 and x86_64, ELF aarch64 and x86-64, 64 to 95 MB each. A cross target downloads its Bun runtime once; the host target needs no download.
- In a prototype, `Bun.build` called inside `bun test` passed once and then failed with `Could not resolve: "./adapters/http-tracker"`; the same build run as a subprocess passed every time. The test builds through a subprocess.

## Change
### T1: one template root, and a version
Files: `src/template-root.ts`, `src/version.ts`, `src/install-template.ts`, `src/init-cli.ts`, `src/harness-defaults.ts`, `src/engine/workflows.ts`, `src/cli.ts`, `src/cli-runtime.ts`, `src/help.ts`, `quality-baseline.json`
Model: sonnet
1. `src/template-root.ts` declares `declare const FACTORY_EMBEDDED_TEMPLATE: Record<string, string> | undefined;` and exports `embeddedTemplate()`, returning `typeof FACTORY_EMBEDDED_TEMPLATE === "undefined" ? undefined : FACTORY_EMBEDDED_TEMPLATE`. Keys are paths like `template/.factory/gates.sh` and `template-ci/factory.yml.example`; values are base64.
2. It exports `runnerRoot(files = embeddedTemplate(), env = process.env): string`. With no embedded files it returns `resolve(import.meta.dir, "..")`, so running from source is unchanged. With files it writes them once to `<factoryHome(env)>/runner/<first 12 hex of sha256 of JSON.stringify(files)>/`, into a `.tmp-<pid>` sibling first, writes a `.complete` marker last, then renames; when the rename fails and the target has `.complete`, it removes its temp dir and goes on. The result is cached for the process. `factoryHome` comes from `src/paths.ts`.
3. It exports `templateDir()` (`join(runnerRoot(), "template")`) and moves `templateSkills()` from `src/cli.ts:411-424` into this file unchanged except that its root is `templateDir()`.
4. `src/install-template.ts`: drop the module-level `root` (`:58`) and start `bundledFiles` with `const root = runnerRoot();`. `src/init-cli.ts`: both reads become `join(templateDir(), ".factory", ...)`. `src/harness-defaults.ts`: `DEFAULTS_DIR = templateDir()`. `src/engine/workflows.ts`: `BUNDLED_DIR = join(templateDir(), ".factory", "workflows")`.
5. `src/version.ts` exports `RUNNER_VERSION` from `import pkg from "../package.json" with { type: "json" };` (tsc accepts it with the current tsconfig; the bundler inlines it). `src/cli-runtime.ts` uses it in place of the disk read at `:99`.
6. `src/cli.ts`: import `templateSkills` and `RUNNER_VERSION`; drop `readdirSync` and `relative` from its imports; `main` switches on `command === "--version" ? "version" : command` and gains `case "version": return void console.log(RUNNER_VERSION);`. `src/help.ts` gains `{ name: "version", usage: "version (or --version)", does: "print the runner version" }` so `tests/help.test.ts` still matches the dispatcher.
7. `src/cli.ts` ends at 974 lines; set its line baseline in `quality-baseline.json` to that exact size.

### T2: build script and host smoke test
Files: `scripts/build-binary.ts`, `tests/binary.test.ts`, `tests/mutations.json`, `.gitignore`
Model: sonnet
Deps: T1
1. `scripts/build-binary.ts` exports `TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-arm64", "bun-linux-x64"] as const`, `hostTarget()` (`bun-${process.platform}-${process.arch}`), `embeddedFiles()` (every file under `template/` and `template-ci/`, sorted, as `<top>/<rel>` to base64) and `buildBinary(target, outfile)`, which calls `Bun.build({ entrypoints: [src/cli.ts], compile: { target, outfile }, define: { FACTORY_EMBEDDED_TEMPLATE: JSON.stringify(embeddedFiles()) } })` and throws with the build logs when `success` is false.
2. Its main takes `--target <t>`, `--host` or neither (all of `TARGETS`), and `--out <dir>` (default `dist/`), writes `factory-<os>-<arch>` per target and prints one `build-binary: <path>` line each. `.gitignore` gains `dist/`.
3. `tests/binary.test.ts` runs `bun scripts/build-binary.ts --host --out <tmp>` as a subprocess, then runs the binary with `cwd` set to the temp dir and `FACTORY_HOME` set to a dir inside it. It asserts: `--version` exits 0 and prints the `package.json` version; `init --repo-dir <tmp>/repo` exits 0 with empty stderr, every `template/` key of `embeddedFiles()` exists in the repo, `.factory/gates.sh` is executable and `.factory/config.json` exists; `install <tmp>/ci-repo --ci` exits 0 and writes `.github/workflows/factory.yml.example`. Timeout 120 s.
4. Add the three entries under Mutation to `tests/mutations.json`.

### T3: staged release workflow
Files: `ci/release-binaries.yml`, `tests/binary.test.ts`
Model: sonnet
Deps: T2
1. `ci/release-binaries.yml` is a workflow staged outside `.github/workflows`, for an operator to move there: on a `v*` tag push and `workflow_dispatch`, `permissions: contents: read`, one `ubuntu-latest` job with a `matrix.target` list of exactly the four targets, each running `make install`, `bun scripts/build-binary.ts --target ${{ matrix.target }} --out dist` and `actions/upload-artifact@v4` named `factory-${{ matrix.target }}`. No release, no secret, no publish step.
2. `tests/binary.test.ts` gains a test that every entry of `TARGETS` appears as `- <target>` in the file, that the file lists no other `- bun-` entry, and that `hostTarget()` is one of `TARGETS`.

## Tests
- `tests/binary.test.ts`: [permanent] the host binary prints the version, `init` installs every embedded template file with `gates.sh` executable and writes `config.json`, and `install --ci` writes the CI example; the staged workflow builds exactly `TARGETS`.
- `tests/help.test.ts`: [permanent] existing; still passes with the `version` entry.
- `tests/quality.test.ts`: [permanent] existing; `src/cli.ts` shrinks to its new baseline.
- `tests/install.test.ts`, `tests/harness-defaults.test.ts`: [permanent] existing; unchanged behaviour from source.

## Mutation
```json
{"name":"binary: init skips the template install","file":"src/init-cli.ts","find":"if (!existsSync(join(dir, \".factory\", \"gates.sh\")) && !dry) runInstall(dir, cli);","replace":"if (false) runInstall(dir, cli);","test":"tests/binary.test.ts"}
```
```json
{"name":"binary: hooks and gates lose the executable bit","file":"src/install-template.ts","find":"if (isExecutable(rel)) chmodSync(dest, 0o755);","replace":"","test":"tests/binary.test.ts"}
```
```json
{"name":"binary: CI example lands outside workflows","file":"src/install-template.ts","find":"const CI_DEST_REL = \".github/workflows/factory.yml.example\";","replace":"const CI_DEST_REL = \".github/factory.yml.example\";","test":"tests/binary.test.ts"}
```

## Acceptance
- AC-1: `factory --version` prints the runner version and help still lists exactly the dispatcher's commands: checked by `make test FILES=tests/help.test.ts` (T1)
- AC-2: `src/cli.ts` does not grow and its baseline is its size: checked by `make test FILES=tests/quality.test.ts` (T1)
- AC-3: running from source still installs the template from the repo: checked by `make test FILES=tests/install.test.ts` (T1)
- AC-4: running from source still reads default skills and agents from the repo: checked by `make test FILES=tests/harness-defaults.test.ts` (T1)
- AC-5: the host binary, built with the template embedded, runs `--version`, `init` and `install --ci` outside the repo: checked by `make test FILES=tests/binary.test.ts` (T2)
- AC-6: the staged release workflow builds darwin and linux on x64 and arm64, the same list the script exports: checked by `make test FILES=tests/binary.test.ts` (T3)

## Non-goals
- NG-1: no publishing: no GitHub release, no package registry, no signing, no checksums file, no secret.
- NG-2: the workflow stays in `ci/`; moving it into `.github/workflows` is an operator step.
- NG-3: other readers that resolve from the source tree (`src/deploy/stack.ts`, `src/deploy/gh-fields.ts`, `src/integrations/catalogue.ts`, `src/verify-agent.ts`, `src/remote-cli.ts`, `src/agents/presets/acp.ts`, `dashboard/`) stay as they are; `dashboard`, `mcp`, `runner` and `verify-agent` from the binary are later work.
- NG-4: no change to `scripts/check-mutations.ts`, `scripts/mutation-select.ts`, `src/config.ts`, `src/state.ts` or `src/engine/common.ts`.
- NG-5: no cross-target build in `make check`; only the host target, which needs no download.
- NG-6: no install script that downloads the binary; that is a later E0 task.

## Files
- `src/template-root.ts` (new)
- `src/version.ts` (new)
- `scripts/build-binary.ts` (new)
- `tests/binary.test.ts` (new)
- `ci/release-binaries.yml` (new)
- `src/install-template.ts` (edit: `bundledFiles` reads `runnerRoot()`)
- `src/init-cli.ts` (edit: reads through `templateDir()`)
- `src/harness-defaults.ts` (edit: `DEFAULTS_DIR = templateDir()`)
- `src/engine/workflows.ts` (edit: `BUNDLED_DIR` from `templateDir()`)
- `src/cli.ts` (edit: `version` command, `templateSkills` moved out)
- `src/cli-runtime.ts` (edit: `RUNNER_VERSION`)
- `src/help.ts` (edit: `version` entry)
- `quality-baseline.json` (edit: `src/cli.ts` to 974)
- `tests/mutations.json` (edit: add the three entries)
- `.gitignore` (edit: `dist/`)
