# Repository layout

This is the **yoda/** monorepo — a small collection of zero-dependency JavaScript tools that share UI styling and a Cloudflare Worker proxy.

```
yoda/
  depsview/    Dependency analyser for npm, Python, Go projects (CLI + web)
  brewview/    Homebrew formula browser (web)
  worker/      Cloudflare Worker CORS proxy used by both apps
  shared/      Shared CSS theme (style.css)
  landing/     Landing page that links the apps
  scripts/     Repo-wide dev utilities (e.g. sync-seo.js — sitemap lastmod + JSON-LD CSP hash sync)
  .githooks/   Repo-tracked git hooks (enable per clone with `git config core.hooksPath .githooks`)
```

Each subproject is self-contained: its source, tests, README, and any subproject-specific rules live inside its own directory. **When you work on files under `depsview/`, also read `depsview/CLAUDE.md`** — it carries the depsview-specific architecture, parser contract, and lock-file conventions that don't apply elsewhere. The same pattern applies to any other subproject CLAUDE.md that appears in the future.

# Cross-cutting rules

These apply across every subproject. Subproject CLAUDE.md files may layer additional rules on top but must not contradict these.

## Coding rules

- **Plan first, always.** Before implementing any feature or change, present a concise plan — what will be created or modified and why — and wait for confirmation before writing code.
- **No third-party dependencies.** Every subproject is vanilla JavaScript with no runtime dependencies. Do not add packages. Use Node.js / browser built-ins.
- **Mandatory docstrings.** Every new function gets a JSDoc-style comment explaining its purpose, arguments, and return value. Pre-existing functions you modify keep their existing docstring style.
- **Explain before editing.** Briefly state in chat what you are about to change and why, before making the change.
- **No silent rewrites.** Do not refactor or rename across files without saying so first.

## Coding style

- **No mutating input parameters.** Functions must not mutate objects or arrays passed in as arguments. Always return new values instead.
- **Prefer async/await over Promise chains.** Use `async`/`await` for all asynchronous code. Reserve `.catch()` only for handlers attached to a Promise you are not awaiting inline.
- **Browser-safe modules must not import `node:*`.** Files loaded directly by browser entry points (typically via a `web/src → ../src` symlink in each subproject) cannot use `fs`, `path`, or any other Node built-in. Subproject CLAUDE.md files list exactly which files this applies to.

# Agents

Three project agents live in `yoda/.claude/agents/` and apply to every subproject. **Always run them sequentially — never in parallel:**

1. **`test-writer`** — invoke first when a new source file is created or new exported functions are added without test coverage. Pass the source file path. The agent reads the file, matches the local test style, writes the test file, and runs the project's `npm test`. Wait for confirmation that all tests pass before continuing.
2. **`security-reviewer`** — invoke second, only after `test-writer` completes successfully. Pass the changed file paths or let it diff against `HEAD`. It checks project-specific attack surfaces (XSS via registry data, URL injection, prototype pollution, path traversal, ReDoS) and produces a structured PASS/FAIL report.
3. **`architecture-reviewer`** — invoke third, only after `security-reviewer` completes. Audits whether the `# Architecture` section of the relevant subproject `CLAUDE.md` still matches the code on disk (module map, parser contract, browser-compat list, "how to add" steps, test layout). Edits that CLAUDE.md in place when drift is detected. Skip this agent for pure bug fixes that touch only function bodies.

Each agent infers the target subproject from the file paths passed in. When invoking, include the subproject directory in the prompt (e.g. `depsview/src/npm/foo.js`) so the agent knows which CLAUDE.md to consult.

# Documentation

- **README per subproject must stay current.** After every implementation, update that subproject's `README.md` to reflect new flags, behaviour, file formats, or limitations introduced by the change.
- **Subproject architecture lives in `<subproject>/CLAUDE.md`.** The root CLAUDE.md (this file) only describes layout and cross-cutting rules.

# Definition of Done

A task is only complete when ALL of the following have been done **in this exact order**:

1. `test-writer` invoked for any new or changed source files — wait for completion, all tests must pass.
2. `security-reviewer` invoked — wait for completion, fix any findings before closing.
3. `architecture-reviewer` invoked when the change adds/renames/removes a source file, alters a parser contract, introduces a new lock-file format or ecosystem, or changes the test layout — skip for pure bug fixes.
4. The relevant subproject's `README.md` updated to reflect the change.
