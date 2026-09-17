# Review hand-off

What an implementer or a lead gives the reviewer. Fill in what applies; the
reviewer finds the rest (the bead text, the PR, the merge base) without help.

```text
Review request
Bead: <bead id>   (no bd access: paste the task text and acceptance criteria)
Target: PR <number or link> | <repository> <base>..<head> | branch bd-<id>
Head: <full SHA the review is for>
Author's checks:
- `<command>`: <result>
Known limits: <what is not done or not verified, and why; or "none">
Points to cover: <optional: what to look at in particular>
Post to: conversation (default) | PR | bead
Language: <optional: the report's language, if not the one of this request>
```

For a re-review, add:

```text
Round: <n>
Previous report: <link, or its findings pasted>
Author's answers:
- R1 fixed in <short SHA>
- R2 disputed: <reason>
- R3 answered: <answer>
```

Requests that start a review, shortest first:

- `Review bead proj-42.`
- `Review bead proj-42, PR #57.`
- `Review proj-42 on main...bd-proj-42 at 3f2c1ab. npm test passes.`
- `Review proj-42, commits 1a2b3c4..3f2c1ab. Windows is not tested.`
- `Review bead proj-42, PR #57. Check the retry path in particular.`
- `Re-review proj-42 at 9e81d04. R1, R3 fixed; R2 disputed.`

A range that starts with a branch name is reviewed from the merge base,
whether it is written with two dots or three; a range of two commit SHAs is
taken as given; to learn whether it still merges, name the branch it goes
into. Commit before asking: the review reads commits, not a working tree.
