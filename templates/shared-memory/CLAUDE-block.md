<!-- claude-protocol:shared-memory:begin · managed block · claude-protocol replaces everything
     between these two markers · keep your own notes outside them -->

## Memory: where to write

There are two memories:

- **project memory** (`.memory/` in the project) — only what matters for this project;
- **shared memory** (`{{SHARED_MEMORY}}`) — everything that will help in another
  project: the user's preferences and corrections, shared infrastructure, lessons
  about tools.

Before writing, ask: "will this help in another project?" Not sure — project memory.

One format for both: a file per fact, starting with a header block (frontmatter),
and one index line per file in `MEMORY.md`:
`- [Title](file.md) — when to open it`

Wrote to shared memory — commit and push it (when it is a git repository).

Never write passwords, tokens or keys to any memory. A rule about how to work is not
memory — propose a change to the rule instead.

When the user says to close the session, say what was written and where. If
this session put entries into project memory that will help in another project,
offer to move them to shared memory (only entries from this session). Sorting
the older memory is the memory-sort skill's job.

@{{SHARED_MEMORY}}/MEMORY.md

<!-- claude-protocol:shared-memory:end -->
