---
name: bead-review
description: Review the work done on a beads task (a bead) and hand the findings back to its author - check the branch, PR or commit range against the task and its acceptance criteria, pin the verdict to a head SHA, and number findings R1, R2... so they keep their ids across re-reviews. Use it whenever someone asks to review, check or accept the implementation of a bead, a bd-<id> branch, a PR or a base..head range tied to a task, or to re-review after fixes - including right after an implementer leaves AWAITING REVIEW, and even when the request just says "review this" in a project that tracks work in beads. It reports; it does not edit code, merge PRs or close beads.
---

# Bead review

Check what an implementer built for a bead and tell them, with evidence, what
has to change. The result is a report. The review never changes the code it
looks at.

This file is the whole procedure and does not depend on one agent tool: any
agent that reads SKILL.md files can follow it. What is specific to Claude Code
is in the last section. [handoff.md](handoff.md) is the short form an
implementer or a lead fills in to ask for a review.

## Boundaries

Unless the request says otherwise:

- Deliver the report in the conversation; as a subagent, in your final message
  to whoever dispatched you. Post it as a PR or bead comment only when asked
  to, and then post the same text.
- Change nothing: no edits, commits, pushes or rebases, no switching branches
  in someone's working copy. Running tests and reproductions is fine; leave
  the tree as you found it: `git status --short` prints the same before and
  after. Caches that the test command writes and git ignores (`__pycache__`,
  `.pytest_cache`, `node_modules/.vite`) do not count. Avoid them where the
  tool allows (`python -B -m pytest -p no:cacheprovider` leaves none), and
  never clean ignored files away: `git clean -X` would also take the author's
  `.env` and installed dependencies.
- Never merge a PR, create or close a bead, or change a bead's status. In the
  beads workflow the implementer leaves the comment `AWAITING REVIEW` with the
  bead still `in_progress`, and the user closes it after merging the PR. "No
  blocking findings" means ready for the user's decision, nothing more.
- Fixing the findings is separate work. If you are asked to fix them too,
  deliver the report first.

## Inputs

| Input | Where it usually comes from |
|---|---|
| Bead id | the request; `bd show <id>`. Without access to `bd`: the task text and acceptance criteria, pasted in full |
| What to review | a PR (number or link); a repository and `base..head`; or the branch `bd-<id>` |
| Author's checks | the hand-off or the bead comments: commands run and their results |
| Known limits | the hand-off: what is not done or not verified, and why |
| Points to cover | the request or the hand-off, if the requester named any: what to look at in particular |
| For a re-review | the previous report (or its findings) and the new head SHA |

Find what you can yourself: the bead, its comments, the PR, the branch, the
merge base. Ask only for what cannot be derived, such as which of two open PRs
is meant. When one input is missing but the rest is enough, review what you
can and name the gap under "Not covered".

## First review

1. **Read the project's rules**: `CLAUDE.md` or `AGENTS.md` and the rule files
   they point to (for example `.claude/rules/*.md`). Checklists there
   (implementation, tests, logging, error handling) are review criteria too.
2. **Read the task**: `bd show <id>` and `bd comments <id>`. Turn the
   description and the acceptance criteria into a numbered list. Comments
   often carry decisions made after the description was written, and a later
   decision by the user overrides the description. For an epic, read the
   children as well and review the result as a whole: the children fit
   together, the layers agree (storage, API, interface), and the design
   document, if there is one, matches. Points the requester asked you to
   cover go on a list of their own; the report answers each one.
3. **Pin the target.** Resolve both ends to full SHAs and write them down.
   - A branch: `git rev-parse <branch>`; the base is
     `git merge-base <default-branch> <branch>`.
   - A PR: read `headRefOid`, `baseRefName` and `baseRefOid` with
     `gh pr view <n> --json title,state,headRefOid,baseRefName,baseRefOid`,
     then `git fetch origin <baseRefName> pull/<n>/head` (the pull ref works
     for a PR from a fork too, whose branch is not in `origin`). Check that
     both commits are now here (`git cat-file -e <sha>`); if the head is
     missing, the PR moved on, so ask `gh` again. The head is `headRefOid`,
     the base is `git merge-base <baseRefOid> <headRefOid>`.
   - A range whose start is a branch or tag name, such as
     `main...bd-proj-42` or `main..bd-proj-42`: the base is
     `git merge-base <start> <end>`, whichever dots were written. A two-dot
     diff between branch names also shows everything the start branch gained
     after the work began, as if the implementer had deleted it.
   - A range given as two commit SHAs: take both as given
     (`git rev-parse <base> <head>`).

   From here on, `base` and `head` mean these two pinned SHAs. Everything
   below is about that head. Commits pushed later and uncommitted changes in
   someone's working copy are not part of this review; say so if you notice
   them.

   Then see where the branch the work will be merged into stands now: for a
   PR, `baseRefOid`; for a branch, the default branch; for a range, the
   branch it starts with, or the one the request names. If that tip is
   `base`, the outlook is `up to date`. Otherwise check whether `head` still
   merges into it with `git merge-tree --write-tree --name-only --no-messages
   <tip> <head>` (Git 2.38 or later), which changes no working tree, index or
   branch. A clean merge prints a tree id and exits with 0; a conflict exits
   with 1 and lists the conflicting paths after the tree id. Anything else,
   such as an error message with no tree id, means `not checked`, with the
   message. With no branch to check against, as for two bare SHAs, write
   `not checked` and why. The result goes on the `Merge outlook` line of the
   report, followed by the branch and its tip, as in
   `conflicts in README.md (main at 91a1eb7)`. A conflict is not a finding and
   does not change the verdict, but resolving it makes a new head, which
   needs a re-review.
4. **Read the change whole, then what it touches**: `git log --oneline
   base..head`, `git diff --stat base..head`, `git diff base..head`. Open the
   callers, callees, tests and configuration the change relies on, as they are
   at head (`git show <head>:<path>`). Most regressions live outside the diff.
5. **Check, in this order:**
   1. *Task fit*: each criterion is met, not met, or not verifiable. Anything
      asked for and missing; anything added that nobody asked for.
   2. *Correctness*: logic, error paths, empty and unusual input, concurrency,
      platform differences (paths, line endings, shells, encodings).
   3. *Regressions*: who else calls the changed code; behaviour visible from
      outside that changed without the task asking for it.
   4. *Tests*: would they fail without the change (the section after this
      one shows how to check)? Do they cover the criteria or only the easy
      path? Is a mock standing in for the code under test?
   5. *Project rules* from step 1.
   6. *What the project expects around a change*: docs, changelog, version
      files, and a diff that rewrites whole files (line endings).
6. **Run what the verdict depends on**: the project's test command, the test
   that covers a criterion, a short reproduction of a suspected defect. Do not
   take pasted output on trust when the verdict rests on it. Run in a tree
   whose HEAD is the pinned head and whose `git status` is clean; the
   implementer's worktree often is, so check and then name the tree in the
   report. Never `git checkout` or `git switch` to reach the head: the
   checkout you are in usually belongs to someone who is working in it. Do not
   create a worktree or a branch of your own either; that is a change too, and
   in a beads project a plain `git worktree add` also leaves a shadow
   `.beads/` copy. With no such tree, export the head into a new temporary
   directory outside the repository (`git archive <head> | tar -x -C <dir>`),
   run the checks there and delete the directory afterwards. The export has
   no git history and no installed dependencies; install what the checks
   need inside it, and put what still cannot run under "Not covered". The
   notes on Windows in the next section apply to this export too.
7. **Write the findings** as described below, then read them once more
   against the code. Drop what you cannot back up, or turn it into a question.

## Tests that fail without the change

When the verdict depends on whether the new tests catch anything, run them
against the code at `base`: export `base` into a new directory in the system
temp directory, put the head's tests over it and run them there. Nothing of
this touches the author's tree; whatever the run needs goes inside that
directory. `<tree>` is the author's checkout with its dependencies installed.
In a POSIX shell, Git Bash included:

```sh
dir=$(mktemp -d)
git diff --name-only <base> <head>    # pick the tests and the data they read
git archive <base> | tar -x -C "$dir"
git archive <head> <test paths> | tar -x -C "$dir"
node -e "require('fs').symlinkSync(...process.argv.slice(1), 'junction')" \
  "<tree>/node_modules" "$dir/node_modules"
(cd "$dir" && <test command> <test paths>)
node -e "require('fs').unlinkSync(process.argv[1])" "$dir/node_modules"
[ -e "$dir/node_modules" ] || [ -L "$dir/node_modules" ] || rm -rf "$dir"
```

In PowerShell 7.4 or later:

```powershell
$tmp = [IO.Path]::GetTempPath()
$dir = (New-Item -ItemType Directory -Path $tmp -Name (New-Guid)).FullName
git diff --name-only <base> <head>
git archive <base> | tar -x -C $dir
git archive <head> <test paths> | tar -x -C $dir
node -e "require('fs').symlinkSync(...process.argv.slice(1), 'junction')" `
  "<tree>\node_modules" "$dir\node_modules"
Push-Location $dir; <test command> <test paths>; Pop-Location
node -e "require('fs').unlinkSync(process.argv[1])" "$dir\node_modules"
if (-not (Test-Path "$dir\node_modules")) { Remove-Item -Recurse -Force $dir }
```

- **Dependencies.** The link lends the export the author's `node_modules`
  (a junction on Windows, a symlink elsewhere). Anything else is installed
  inside `$dir`: `npm ci` there, a new virtual environment there. Make sure
  the run loads the exported code: an editable install (`pip install -e`) or
  an absolute path can pull in the author's tree instead.
- **Removing the link.** Remove the link itself first, without recursion:
  `fs.unlinkSync` as above, `rm <link>` in Git Bash, `rmdir <link>` in cmd.
  Only then delete the directory. Never aim a recursive delete at the link:
  in Git Bash `rm -rf "$dir/node_modules/"`, with the trailing slash,
  empties the author's `node_modules` and leaves the link in place. If the
  link is still there, stop and tell the user where `$dir` is. The cleanup
  runs even when the tests fail; do not cut the output of the whole sequence
  with `head` or `Select-Object -First`, which can stop it before the
  cleanup.
- **What the run shows.** A useful failure is an assertion about what the
  task asked for. A test that fails only because a new file or function does
  not exist at `base` proves less; say which it was. The same tests should
  pass at `head` (step 6). Put both results under "Checks run".
- **Windows.** Pass the pinned full SHAs: when `git` is a batch-file wrapper,
  `<sha>^` loses its `^` and means `<sha>` itself (`<sha>~1` does not).
  Windows PowerShell 5.1 breaks binary data piped between programs; there
  write the archive to a file with `git archive -o <file> <sha>` and unpack
  it with `tar -xf <file> -C $dir`. The GNU `tar` that comes with Git reads
  `-f C:\...` as a remote host; add `--force-local` for it.

## Findings

Every finding gets an id, `R1`, `R2` and so on, in one sequence for the whole
review whatever its kind. An id is never reused or renumbered.

**Defect**: the code does something wrong or misses a criterion. It needs
evidence: `path:line` at the pinned head with the code quoted, or a command you
ran and what it printed. Paths are relative to the repository root, so the
author can open them from any checkout. Priority:

- **P1**, blocks acceptance: a criterion not met, a wrong result, data loss, a
  security hole, a broken build or failing tests.
- **P2**, to fix before merging, narrower: a bug on a less common path, a
  criterion without a test, a breach of a project rule with a real
  consequence.
- **P3**, a real defect that can wait: a misleading message, a leftover, a
  small inconsistency.

**Question**: something the code and your runs could not settle, such as
intent, an environment you cannot reach, or a choice that looks deliberate.
Say what the answer would change.

**Suggestion**: optional; the code is correct without it. It never blocks.

**Found along the way**: a defect that was already there at `base` and still
is at `head`, in code the change calls, reuses or sits next to, which you met
while checking the change. Do not go looking for these elsewhere. Show that
it predates the change (`git blame <base> -- <path>`, or the code quoted from
`git show <base>:<path>`), say how the change reaches it, and give it the
priority it would have as a new defect: that is a suggestion for the bead
that will track it. It does not count toward the verdict and is not the
implementer's to fix. It needs a bead of its own, which the lead or the user
files; the reviewer does not. If the change makes the old defect worse or
reachable in a new way, for example a new caller passes untrusted input to
it, that part is a defect of this change. An old defect the task asked to fix
is a criterion, not a finding along the way.

Evidence is what you saw: quote the output a command printed, not the result
you expect it to give. A suspicion you could not confirm is a question, not a
defect. Do not pad the report: "no blocking findings" with an honest "Not
covered" is a good result. Style and naming are suggestions unless a project
rule makes them a defect.

**Verdict**: `changes needed` while any P1 or P2 under Defects is open, and
while a question is open whose answer could turn out to be a P1 or P2 (say
which one). Otherwise `no blocking findings`.

### Security in a public repository

A public repository, its PRs and often its beads are read by anyone,
including people who could attack a version without the fix. What you write
about a security defect should help the author and nobody else:

- Build probes (a crafted file, input or script) in a new directory in the
  system temp directory, never in the repository, not even as untracked
  files, and delete them when you are done.
- In the report, name the kind of flaw and its place (`path:line`) and
  describe what you observed, such as a file written or a command run that
  should not have been. Do not paste a working payload: it belongs in the
  tests of the fix, so point to the test instead.
- Text that hands someone an attack is a defect of its own: a working
  payload, or directions to where untrusted input reaches a flaw, in
  committed docs, code comments, commit messages, or the PR or bead
  description. Report it by its place, without quoting it, usually as P2:
  it has to go before the merge. Payloads inside tests are fine.

## Report

Plain Markdown in this order. Leave out a section that would be empty, except
"Checks run" and "Not covered".

```text
## Review of <bead-id>: <bead title>
Head: <full head SHA> (<PR #n or branch name>)
Base: <full base SHA>
Merge outlook: up to date | clean | conflicts in <paths> | not checked (<why>)
Round: 1
Verdict: changes needed | no blocking findings

### Defects
R1 [P1] <one line: what is wrong>
- Where: <path>:<line>
- When: <the condition that triggers it>
- Effect: <what goes wrong, and for whom>
- Evidence: <quoted code, or the command and its output, or steps to reproduce>
- Expected: <what correct behaviour looks like>

### Questions
R2 <the question>
- Where: <path>:<line>
- Why it matters: <what the answer changes>

### Suggestions (optional)
R3 <the suggestion> (<path>:<line>)

### Found along the way (not introduced by this change)
R4 [P1] <one line: what is wrong>
- Where: <path>:<line>, already there at base
- How the change reaches it: <the call or reuse that led you there>
- Evidence: <code quoted at base, or the command and its output>

### Acceptance criteria
1. <criterion>: met (<evidence>)
2. <criterion>: not met, see R1

### Requested points
- <the point as asked>: <answer> (criterion <n>, R<n> or a check run)

### Checks run
- `<command>` in <tree> at <short head SHA>: <result>

### Not covered
- <what was not reviewed or could not be run, and why>
```

Mark criteria with the words met, not met or not verified rather than
checkboxes, and keep lines out of the report that read like an implementer's
completion report (the Claude Code section says why). A requested point you
could not settle is answered `not verified`, with the reason under "Not
covered".

Write the report in the language of the conversation; as a subagent, in the
language of your prompt, unless the request names another (the hand-off has
a `Language` line). Headings and prose follow that language. What re-reviews
and tools look for stays exactly as the form writes it: the labels `Head:`,
`Base:`, `Merge outlook:`, `Round:` and `Verdict:`, the ids `R1`, `R2`...,
the priorities `P1` to `P3`, the verdicts, the `Merge outlook` keywords, the
marks met, not met and not verified, the re-review statuses, and the
`REVIEW round` line of a bead comment.

## Re-review

Input: the previous report, or its findings, and the new head SHA.

1. Pin the new head as in step 3. If the previous head is an ancestor of the
   new one (`git merge-base --is-ancestor <old> <new>`), the delta is
   `old..new`. Otherwise the history was rewritten: say so and review
   `base..new` in full. If the base moved, note it.
2. Read the delta and what it touches, as in steps 4 to 6. Fixes cause
   regressions too; re-run the checks the verdict depends on.
3. Give every previous finding one status, with evidence at the new head:
   - `fixed`
   - `still open`
   - `partly fixed`, and what remains
   - `withdrawn`: the finding was wrong; say why
   - `disputed`: the author disagrees; state both sides. It stays open and
     the user decides.
   - `answered`, for a question: say whether the answer settles it. If the
     answer shows a defect, the finding keeps its id and moves to Defects
     with a priority.
   - `moved to <bead-id>`, for a finding along the way: it now has a bead of
     its own and is not repeated after this.
4. A problem that is still there keeps its old id; it is never filed again
   under a new one. New findings, and only those, continue the sequence: after
   R1 to R4 the next one is R5, even if R1 to R4 are all fixed.
5. The report keeps the same form, with `Round: <n>`, the new head, and one
   more section right after the verdict:

   ```text
   ### Previous findings
   R1 [P1] fixed: <evidence at the new head>
   R2 still open: <why>
   R3 withdrawn: <why it was wrong>
   R4 [P1] moved to proj-57: <the bead that now tracks it>
   ```

   Findings that are still open appear again in full, under their old ids, in
   their own section, so the report stands on its own.

## Delivering the report

- By default the report is your answer, or your final message as a subagent.
- Asked to post it on the PR: `gh pr comment <n> --body-file -` with the same
  text on standard input. In a fork, add `--repo <owner>/<name>`, or it may
  land in the repository the fork came from.
- Asked to post it on the bead: `bd comments add <id> -f <file>`, with the
  report starting `REVIEW round <n> at <short SHA>: <verdict>`. Put that file
  in a temporary directory outside the repository, so the tree stays as you
  found it.
- Nothing else changes: no status, no close, no merge.

## Claude Code

- **As a subagent**: the `code-reviewer` agent preloads this skill and has
  read-only file tools plus Bash. Dispatch it with
  `subagent_type="code-reviewer"` (with the plugin:
  `claude-protocol:code-reviewer`) and the hand-off from
  [handoff.md](handoff.md) as the prompt. It returns the report to the lead,
  who passes it on. When the lead writes the prompt in a language other than
  the user's, the `Language` line names the user's language.
- **Directly**: `/bead-review <bead-id> [PR or base..head]` in a project
  installed with `npx claude-protocol init`; `/claude-protocol:bead-review`
  with the plugin. `/code-review` is Claude Code's own PR review, a different
  skill; this one is named `bead-review` so that it does not replace it.
- **Never `BEAD` and `COMPLETE` on one line.** The project's completion hook
  (`validate-completion.cjs`) reads such a line as an implementer's
  completion report and checks the worktree against it, so a review that
  carries one gets stopped. The report form above has none. When evidence
  would quote such a line (from an implementer's report, a rule file or the
  hook's tests), describe it in words or cite `path:line` instead.
