---
name: memory-sort
description: Sort a project's memory (.memory/) and move what belongs to every project into the shared memory - read the project's MEMORY.md and fact files, propose a "move to shared" list with a reason per item, list files holding secrets apart and never move them, move only what the user confirms, merge or skip facts the shared memory already has, then commit and push the shared memory. Use it when the user says "разбери память", "что перенести в общую память", "sort the memory", "triage project memory", asks which memories are general enough to share, or wants project memory cleaned up into shared memory.
---

# Memory sort

Project memory collects facts that would help in every project. This skill
finds them and, with the user's yes, moves them into the shared memory. It
proposes; the user decides. Nothing moves without a confirmation.

## 1. Find both memories

**Shared memory.** Read `claude-protocol.json` in the Claude Code config
folder (`$CLAUDE_CONFIG_DIR`, else `~/.claude`), key `shared_memory`. It is
set up when `choice` is `existing`, `new` or `local` and `path` names a folder
that exists. Otherwise stop and say so, with how to set it up - the same
answer the installer asks for, as a flag:

```
npx claude-protocol upgrade --shared-memory new | local | existing <url>
/claude-protocol:init --shared-memory new | local | existing <url>   (plugin)
```

**Project memory.** `.memory/` in the main checkout. Inside a worktree the
main checkout is the parent of `git rev-parse --path-format=absolute
--git-common-dir`; never sort a worktree's own copy. When
`.claude/settings.local.json` of the main checkout sets `autoMemoryDirectory`,
that folder wins. No `MEMORY.md` there, or an empty one - say there is nothing
to sort and stop.

Read both `MEMORY.md` indexes, then the project's fact files. Read the shared
fact files only when a project fact looks like one of them.

## 2. Sort

Apply the route test from the "Memory: where to write" block in
`~/.claude/CLAUDE.md` - the same test, not a new one:
**"will this help in another project?"** Shared memory is for the user's
preferences and corrections, shared infrastructure, lessons about tools. Not
sure - it stays in the project.

Each fact file lands in one of:

- **move** - passes the test. One line of reason: why another project needs it.
- **already shared** - the shared memory holds the same fact. Say which file;
  propose to merge what the project copy adds, or to drop the project copy.
- **secret** - holds a password, token, key, connection string with
  credentials, or a private key block. Listed apart, never moved, whatever
  the user answers. Suggest removing the secret from memory altogether.
- **stays** - everything else. Not listed one by one; give the count.

A file whose frontmatter has `metadata.source: bd` was imported from bd's
memory - mark it `(bd)` in the list: it was written for one project's
debugging and more often stays.

## 3. Ask

Show the proposal compactly, one line per file, numbered:

```
Move to shared (12):
 1. tool-git-crlf.md - Git on Windows rewrites line endings; any repo hits it
 2. user-prefers-ru.md (bd) - the user's language preference
Already in shared (2):
 3. gh-repo-flag.md = shared/gh-always-repo.md - project copy adds nothing, drop it
Secrets - not moved (1):
 - seq-api.md - holds an API key; remove it from memory?
Stays in the project: 40 files.
```

The user answers with numbers, "all", or edits. Move only what they confirm.

Hundreds of files: work in batches of about 30, by index order. Show one
batch, move what is confirmed, then the next. Say how many batches are left.

## 4. Move

For each confirmed file:

1. Copy it into the shared memory folder. A file of that name already there
   with other content - pick another name, never overwrite.
2. Add its index line to the shared `MEMORY.md`, in the same form:
   `- [Title](file.md) - when to open it`.
3. Delete the project file and its line in the project `MEMORY.md` (or in the
   overflow index such as `from-bd.md`, when that is where the line is).

For a merge: edit the shared file, then remove the project copy and its line.
For a drop: remove the project copy and its line only.

## 5. Finish

When the shared folder is a git repository (`git -C <path> rev-parse` works):
`git add -A`, commit with a message naming the project and how many facts
came in, and `git push` when it has an upstream. A failed push - say so and
leave the commit; do not retry in a loop. The project's `.memory/` is
committed only when the project already tracks it; ask before committing.

Report: moved N, merged N, dropped N, secrets left in place N, stays N.
