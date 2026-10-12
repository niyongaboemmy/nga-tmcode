# @nga/runtimes

The **Runtime Catalog** shared by the NGA Code Runner (tm-judge), Task Mentor and TMCode (CODE_RUNNER_PLAN §11–§14). It is data plus a little pure code, with no React and no DOM:

| Part | Where | What |
|---|---|---|
| Schemas | `src/schema.ts` | zod schemas and types: `RuntimeDef`, `Language`, `KindDef`, `Step`/tokens, `Limits`, `StarterManifest`, `.nga/tests.json` (`IoTests`) |
| Catalog | `src/catalog/` | runtimes (pinned toolchains), languages, and project kinds, one file per family under `kinds/` |
| Detection | `src/detect.ts` | `detect(paths, read)` ranks the kinds a project matches; `entryFor(kind, paths, read)` finds the program file; `javaMainClass()` |
| Test reports | `src/testing/` | framework detection, report parsers (JUnit, Jest, go test -json, cargo, TRX…) and `parseRun()` |
| Validation | `src/validate.ts` | cross-checks the schemas can't express (tools exist in the runtime, starters' files exist, detection agrees) |
| Starters | `starters/<language>/<id>/` | real project folders plus `starter.json` |
| Build output | `dist/` (not committed) | `catalog.json`, `starters.json`, `index.js`, `index.d.ts` |

Wave A (enabled now): C, C++, Java, Python, JavaScript, TypeScript, Go, Rust, SQL (SQLite), plus the browser kinds TMCode already has (static websites, React pages bundled in the browser, logic truth tables). Waves B–C are in the catalog as data with `enabled: false`.

> Licence: `UNLICENSED` for now. Whether this package becomes MIT or stays internal is an open decision (plan §22).

## Commands

```sh
npm run build -w @nga/runtimes            # validate everything, write dist/
npx vitest run packages/runtimes           # unit tests (from the repo root)
node packages/runtimes/scripts/verify-starters.mjs              # run hello + io tests with local toolchains
node packages/runtimes/scripts/verify-starters.mjs --projects   # … and the new starters' unit tests
node packages/runtimes/scripts/migrate-templates.mjs            # one-off: TMCode templates → starters/*/tmcode-*
```

`verify-starters` skips languages whose toolchain isn't installed; set `PYTHON=/path/to/venv/bin/python3` for a Python with pytest, pandas, Flask and FastAPI.

## Kinds in one paragraph

A kind (`c/single`, `java/maven`, `python/data`…) says how to recognise a project (`detect`), which file is the program (`entry`), and how to restore, build, run and test it (`steps`). Steps name a **logical tool** that resolves through the runtime's `tools` map plus **typed tokens** (`{entry}`, `{out: "main"}`, `{sources: "c"}`, `{main_class}`, `{test_filter}`, `{report_path}`), never a shell string. Steps that execute the project's own build logic (make, mvn, gradle, npm scripts, cargo build scripts) carry `runsProjectScripts: true`, so exam policy can forbid them. `tier` says where it runs: `browser`, `isolate` (single files), `isolate-build` (project builds and unit tests) or `container` (servers; wave C).

Detection rules: every `files` marker must exist at the project root, at least one `anyOf` glob must match a file anywhere, every `contains` regex must match (needs a reader), and no `none` marker may exist at the root; the highest `priority` wins (single files ≈ 10, build tools ≈ 50, frameworks ≈ 70), ties go to the kind with more matching sources.

## Adding a language, kind or starter

**A language**
1. Add it to `src/catalog/languages.ts` (key, label, family, wave, extensions, Monaco id). Only wave A is `enabled`.
2. Add its runtime to `src/catalog/runtimes.ts`: install recipe, version argv, and **absolute** paths for every tool its steps use.
3. Add at least one kind (below) and the three basic starters (hello, io-exercise, project).

**A kind**
1. Add it with `kind({...})` in the right `src/catalog/kinds/<family>.ts` file. Give it a priority that beats the kinds it refines.
2. Use only tools the runtime lists; flag project-script steps with `runsProjectScripts: true` and use tier `isolate-build` for them.
3. Add a case to `src/detect.test.ts` for what tells it apart.
4. `npm run build -w @nga/runtimes` must print no problems.

**A starter**
1. Create `starters/<language>/<id>/` with the real files, a one- or two-line `README.md` (how to run and test) and a `.gitignore`.
2. Write `starter.json`: `id` (unique, equal to the folder name), `language`, `kind`, `title`, `description`, `level`, `purpose` (`hello` | `io-exercise` | `project` | `api` | `data` | `algorithms` | `web`), `entry`, `open`, `tests`, optional `readonly`, `tags`, `since`.
3. I/O tests go in `.nga/tests.json`: `{entry, tests: [{id, name, input, expected_output, points}]}` (2–4 visible cases; hidden ones live in Task Mentor). Unit tests: `tests.unit = {framework, command: "test"}` and one passing test.
4. Run the tests and `verify-starters` (`--only <id>`): `detect()` must rank the declared kind first, and the I/O cases must pass.
5. Teacher solutions and notes never go here; they stay in Task Mentor.

## Using the build output

- **`dist/catalog.json`**: `{version, languages[], runtimes[], kinds[]}`, each kind with the `starters` that use it. Validate it with `CatalogSchema` if you import the TS API.
- **`dist/starters.json`**: `{version, starters: [manifest + files: [{path, content}]]}`. Text files only (binary files are skipped by the build). Migrated TMCode templates have ids `tmcode-<template id>` and keep the template id in `aliases`.
- **Task Mentor** vendors these two files with a sync script (copy `dist/catalog.json` and `dist/starters.json` from a tagged build into its server), then seeds `code_languages`, `code_kinds` and `code_starters` from them (§14.4).
- **tm-judge and TMCode** import the TypeScript API (`@nga/runtimes`, or the bundled `@nga/runtimes/dist`).

## Known duplication

`src/testing/{frameworks,parsers,report}.ts` and their fixtures are **copies** of `packages/workbench/src/testing/*` (the only change: `FolderSnapshot` comes from `src/testing/folder.ts`). The workbench still uses its own copy; switching it to import `@nga/runtimes` is a follow-up. Until then, change both.
