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
  the tree as you found it.
- Never merge a PR, close a bead or change its status. In the beads workflow
  the implementer leaves the comment `AWAITING REVIEW` with the bead still
  `in_progress`, and the user closes it after merging the PR. "No blocking
  findings" means ready for the user's decision, nothing more.
- Fixing the findings is separate work. If you are asked to fix them too,
  deliver the report first.

## Inputs

| Input | Where it usually comes from |
|---|---|
| Bead id | the request; `bd show <id>`. Without access to `bd`: the task text and acceptance criteria, pasted in full |
| What to review | a PR (number or link); a repository and `base..head`; or the branch `bd-<id>` |
| Author's checks | the hand-off or the bead comments: commands run and their results |
| Known limits | the hand-off: what is not done or not verified, and why |
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
   document, if there is one, matches.
3. **Pin the target.** Resolve both ends to full SHAs and write them down.
   - A branch: `git rev-parse <branch>`; the base is
     `git merge-base <default-branch> <branch>`.
   - A PR: `gh pr view <n> --json number,title,headRefName,headRefOid,baseRefName,state`,
     then `git fetch origin pull/<n>/head` (on GitHub this works for a PR
     from a fork too, whose branch is not in `origin`) and check that
     `git rev-parse FETCH_HEAD` equals `headRefOid`. The base is the merge base
     with `origin/<baseRefName>`.
   - A range `base..head`: `git rev-parse <base> <head>`.

   Everything below is about that head. Commits pushed later and uncommitted
   changes in someone's working copy are not part of this review; say so if
   you notice them.
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
   4. *Tests*: would they fail without the change? Do they cover the criteria
      or only the easy path? Is a mock standing in for the code under test?
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
   `.beads/` copy. With no such tree, read the files with `git show`, put the
   checks you could not run under "Not covered", and say which tree at which
   head would let you run them.
7. **Write the findings** as described below, then read them once more
   against the code. Drop what you cannot back up, or turn it into a question.

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

Evidence is what you saw: quote the output a command printed, not the result
you expect it to give. A suspicion you could not confirm is a question, not a
defect. Do not pad the report: "no blocking findings" with an honest "Not
covered" is a good result. Style and naming are suggestions unless a project
rule makes them a defect.

**Verdict**: `changes needed` while any P1 or P2 is open, and while a question
is open whose answer could turn out to be a P1 or P2 (say which one).
Otherwise `no blocking findings`.

## Report

Plain Markdown in this order. Leave out a section that would be empty, except
"Checks run" and "Not covered".

```text
## Review of <bead-id>: <bead title>
Head: <full head SHA> (<PR #n or branch name>)
Base: <full base SHA>
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

### Acceptance criteria
1. <criterion>: met (<evidence>)
2. <criterion>: not met, see R1

### Checks run
- `<command>` in <tree> at <short head SHA>: <result>

### Not covered
- <what was not reviewed or could not be run, and why>
```

Mark criteria with the words met, not met or not verified rather than
checkboxes, and keep lines out of the report that read like an implementer's
completion report (the Claude Code section says why).

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
4. A problem that is still there keeps its old id; it is never filed again
   under a new one. New findings, and only those, continue the sequence: after
   R1 to R4 the next one is R5, even if R1 to R4 are all fixed.
5. The report keeps the same form, with `Round: <n>`, the new head, and one
   more section right after the verdict:

   ```text
   ### Previous findings
   R1 [P1] fixed: <evidence at the new head>
   R2 still open: <why>
   R4 [P3] withdrawn: <why it was wrong>
   ```

   Findings that are still open appear again in full, under their old ids, in
   the Defects, Questions or Suggestions section, so the report stands on its
   own.

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
  who passes it on.
- **Directly**: `/bead-review <bead-id> [PR or base..head]` in a project
  installed with `npx claude-protocol init`; `/claude-protocol:bead-review`
  with the plugin. `/code-review` is Claude Code's own PR review, a different
  skill; this one is named `bead-review` so that it does not replace it.
- **Nothing that looks like a completion report.** The project's SubagentStop
  hook (`validate-completion.cjs`) reads your final message as an implementer
  finishing a task when one line has `BEAD <id> COMPLETE` and one line has
  `Worktree:` or `Branch:` followed by `bd-...`. Depending on the version it
  matches anywhere in a line, quotes and code spans included. It then checks
  the checklist, the worktree, the push and the length of the message, and
  stops you. The report form above has no such lines; when evidence would
  quote one (from an implementer's report, a rule file or the hook's own
  tests), describe it in words or cite `path:line` instead of quoting it.
