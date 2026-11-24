# Debugging Standard

## Core rule

Don't fight an error by repeating the same action. If your fix didn't work — don't try the same thing again. Step back, new plan.

## Trigger: when this rule fires

**The same error returns after a deliberate attempt to fix it.** Not "it failed twice in a row" (that happens with flaky tests, network, race conditions), but "I applied a fix and the error is still there".

## What to do when the trigger fires

1. **Memory:** search project memory (`.memory/`) and shared memory for keywords from the error — maybe it was already solved, here or in another project
2. **Project:** read the source at the failure point; re-read the docs of the library/API in use
3. **Web (only if the above didn't help):** search the error wording + context (language, framework, version)
4. **3+ alternatives:** formulate at least three alternative fixes (see also Rule of 3 Alternatives in `implementation-standard.md`)
5. **Pick:** the simplest working option, not the first one that came to mind
6. **After the fix:** record the lesson — the specific root cause and fix, so it can be found next time — where the "Memory: where to write" block in `~/.claude/CLAUDE.md` says (project or shared memory); no shared memory set up — write it to project memory (`.memory/`)

## Banned

- Repeating the same action hoping for a different result
- Swallowing the error with `try/catch` without understanding the cause (see `logging-standard.md`)
- Going to the web before reading project code and memory
- Writing vague memory notes like "fixed the bug" — be specific
