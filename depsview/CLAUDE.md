# Project Overview
Show dependencies and transitive dependencies in a project. It prints a list of all dependencies. It uses
https://pypi.org/ for package metadata and https://pypistats.org/ for download statistics and github if you use the github link feature. No other resources are used.

# Documentation
- **README must stay current:** After every implementation update the README to reflect any new flags, behaviour, file formats, or limitations introduced by the change.

# Coding Rules & Behavior
- **Plan first, always:** Before implementing any feature or change, present a concise plan — what will be created or modified and why — and wait for confirmation before writing any code.
- **Mandatory Documentation:** You MUST add a detailed docstring/comment to *every single function* you create. Explain its purpose, arguments, and return values.
- **Explain Your Work:** Before executing code changes, briefly explain the logic of the functions you are about to create in the chat.
- **No Silent Updates:** Do not make sweeping changes to files without telling me what you are modifying first.
- **No dependencies added** Do not add any dependencies for this project. This is a plain javascript project

# Coding Style
- **No mutating input parameters:** Functions must not mutate objects or arrays passed in as arguments (e.g. no accumulator/out parameters). Always return new values instead.
- **Prefer async/await over Promise chains:** Use `async`/`await` syntax instead of `.then()`/`.catch()` for all asynchronous code. Reserve `.catch()` only when attaching a handler to a Promise you are not awaiting inline.

# Agents
Two project agents live in `.claude/agents/`. **Always run them sequentially — never in parallel:**

1. **`test-writer`** — invoke first. When a new source file is created or new exported functions are added without test coverage. Pass the source file path. It reads the file, matches existing test style, writes the test file, and runs `npm test`. Wait for it to complete and confirm all tests pass before continuing.
2. **`security-reviewer`** — invoke second, only after `test-writer` has completed successfully. Pass the changed file paths or let it diff against HEAD. It checks the project-specific attack surfaces (XSS via registry data, URL injection, prototype pollution, path traversal, ReDoS) and produces a structured PASS/FAIL report.

# Testing
- **Every new function must be tested:** Use the `test-writer` agent for new source files. It is responsible for writing tests and verifying they pass.

# Security
- **Security review after every implementation:** Use the `security-reviewer` agent after writing new code. Fix any findings before the task is considered done and document the fix briefly in the chat.

# Definition of Done
A task is only complete when ALL of the following have been done **in this exact order**:
1. `test-writer` agent invoked for any new or changed source files — wait for completion, all tests must pass
2. `security-reviewer` agent invoked — wait for completion, fix any findings before closing
3. README updated to reflect the change