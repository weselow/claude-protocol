#!/usr/bin/env node
'use strict';

// SubagentStop: a subagent that files a bead completion report may stop only
// when the report matches the facts — every checklist item ticked, the
// worktree it names committed clean, and its branch on origin at the same
// commit. Anything else is not a report, and the hook stays out of the way.
//
// The report is the subagent's last message, which Claude Code hands over as
// last_assistant_message. The worktree is the one the report names: bead ids
// and worktree names do not always agree (bd_1c-oko-219 lives in
// .worktrees/bd-219), and a path built from the id was wrong more often than
// the reports it checked.
//
// Reports are written by a model, not a template, so the parsing forgives
// what models do: bold labels, a note after the path, the path on the next
// line, `*` and numbered list items, emoji ticks. Where the text is ambiguous
// it leans towards checking: a false block costs one extra turn (the hook lets
// the second stop through), a false pass lets unfinished work out.

const fs = require('fs');
const path = require('path');
const {
  readStdinJSON, getField, approve, block, hasBeads,
  execCommand, getProjectDir, runHook,
} = require('./hook-utils.cjs');

// A report marker opens a line. Anything but a letter or a digit may stand in
// front of it — a heading mark, bold, a backtick, an emoji. A marker inside a
// sentence, or one whose id is a placeholder ({BEAD_ID}, <id>), is not a report.
const REPORT = /^[^\p{L}\p{N}]*BEAD\s+([\p{L}\p{N}._-]+)[^\s\p{L}\p{N}]*\s+COMPLETE/u;
// A checklist item: "- [x]", "* [ ]", "+ [✅]", "1. [ ]", "2) [✔️]". The box
// holds one character at most, so a markdown link "- [a](url)" is not one.
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\[(\s?|[^\s\]]\uFE0F?)\](?=\s|$)/u;
// A bullet with a tick instead of a box: "- ✅ done", "- ❌ not done".
const EMOJI_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(✅|✔\uFE0F?|☑\uFE0F?|❌|⬜|☐)/u;
const TICKED = new Set(['x', 'X', '✓', '✔', '✅', '☑']);
// "Files: a", "**Found along the way**:" — a capital and one more letter at
// least, so "C:\..." is not a label and wrapped prose rarely is.
const LABEL = /^\s*(?:[-*+]\s+)?[*_]*(\p{Lu}[\p{L} ]+?)[*_]*\s*:[*_]*\s*(.*)$/u;
// Labels of the report itself: they end the checklist even with nothing after the colon.
const REPORT_LABELS = /^(?:worktree|checklist|files|tests|summary|found along the way|branch|notes?)$/i;
const FENCE = /^\s*(?:```|~~~)/;
// A piece of a line: quoted text, or a run of anything but spaces, quotes and brackets.
const PIECE = /`([^`]+)`|"([^"]+)"|'([^']+)'|([^\s`"'[\]()<>]+)/g;
const RETRY = 'Put the path of the worktree you actually worked in on the Worktree: line.';

runHook('validate-completion', () => {
  const input = readStdinJSON();

  // Every check here is about the bead lifecycle. As a plugin this runs after
  // every subagent in every project, and a project without .beads/ has no
  // lifecycle to verify.
  if (!hasBeads()) approve();
  // Already sent back once: let it go rather than argue in a loop.
  if (getField(input, 'stop_hook_active') === true) approve();

  const message = getField(input, 'last_assistant_message');
  if (typeof message !== 'string') approve();
  // A report quoted as a blockquote is still the report.
  const lines = message.split(/\r?\n/).map(line => line.replace(/^\s*>\s?/, ''));
  const at = lines.findIndex(line => REPORT.test(line));
  if (at < 0) approve();

  verifyChecklist(lines, at);
  const worktree = resolveWorktree(lines, at);
  verifyLinkedWorktree(worktree);
  verifyCommitted(worktree);
  verifyPushed(worktree);
  approve();
});

// ---------------------------------------------------------------------------
// Reading the report
// ---------------------------------------------------------------------------

/**
 * The "Label:" line — its index, indent and the text after the colon — or
 * null. Looks below the marker first, then above it. A list marker in front
 * and bold around the label are allowed.
 */
function findLabel(lines, at, label) {
  const re = new RegExp(`^(\\s*)(?:[-*+]\\s+)?[*_]*${label}[*_]*\\s*:[*_]*(.*)$`, 'i');
  const order = [...lines.keys()];
  for (const i of order.slice(at).concat(order.slice(0, at))) {
    const m = re.exec(lines[i]);
    if (m) return { index: i, indent: m[1].length, rest: m[2].trim() };
  }
  return null;
}

/**
 * The marks of the checklist's items: "x", " ", "✅". The list runs to the
 * next report label, a closing code fence or the end of the message; bold
 * sub-headings and wrapped text inside it do not end it.
 */
function checklistMarks(lines, label) {
  const marks = [];
  const first = itemMark(label.rest);
  if (first !== null) marks.push(first);
  for (const line of lines.slice(label.index + 1)) {
    const mark = itemMark(line);
    if (mark !== null) marks.push(mark);
    else if (endsChecklist(line, label.indent)) break;
  }
  return marks;
}

function itemMark(line) {
  const m = ITEM.exec(line) || EMOJI_ITEM.exec(line);
  return m ? m[1].replace(/\uFE0F/g, '') : null;
}

/** A fence, or a label no deeper than Checklist: that is the report's own or carries text. */
function endsChecklist(line, indent) {
  if (FENCE.test(line)) return true;
  if (line.search(/\S/) > indent) return false;
  const m = LABEL.exec(line);
  return Boolean(m) && (REPORT_LABELS.test(m[1].trim()) || m[2].trim() !== '');
}

/** The path a Worktree: line names — on the line itself, or on the next one. */
function worktreeText(lines, label) {
  if (label.rest) return pathIn(label.rest);
  const next = lines.slice(label.index + 1).find(line => line.trim()) || '';
  return LABEL.test(next) ? '' : pathIn(next);
}

/**
 * The first piece of the text that looks like a path, quoted or not; else
 * its first piece. A note after the path — "(branch x)", "— pushed to
 * `origin/x`", a full stop — is not part of it.
 */
function pathIn(text) {
  const pieces = [];
  for (const m of text.matchAll(PIECE)) {
    const quoted = m[1] || m[2] || m[3];
    const piece = quoted ? quoted.trim() : tidyToken(m[4]);
    if (piece) pieces.push(piece);
  }
  return pieces.find(isPathLike) || pieces[0] || '';
}

function isPathLike(text) {
  return /[\\/]/.test(text) || text.startsWith('.');
}

function tidyToken(token) {
  return token
    .replace(/^\*+|\*+$/g, '')
    .replace(/[,;:!?]+$/, '')
    .replace(/([^.])\.+$/, '$1');
}

/** Git Bash writes C:\temp as /c/temp; Node on Windows reads that as C:\c\temp. */
function fromGitBash(text) {
  if (process.platform !== 'win32') return text;
  return text.replace(/^\/([A-Za-z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Block unless the report has a Checklist: with items, every one ticked. */
function verifyChecklist(lines, at) {
  const beadId = REPORT.exec(lines[at])[1];
  const label = findLabel(lines, at, 'Checklist');
  const fill = `Re-read the requirements with \`bd show ${beadId}\` and list them, ` +
    'one line each:\nChecklist:\n- [x] requirement 1\n- [x] requirement 2';
  if (!label) block(`The completion report has no Checklist:.\n\n${fill}`);
  const marks = checklistMarks(lines, label);
  if (marks.length === 0) block(`The Checklist: has no items.\n\n${fill}`);
  const open = marks.filter(mark => !TICKED.has(mark)).length;
  if (open) {
    block(
      `The Checklist has ${open} unchecked item(s).\n\n` +
      'Finish them and tick them before reporting COMPLETE. If a requirement ' +
      'cannot be met, say why in a bead comment instead of reporting COMPLETE.'
    );
  }
}

/** The absolute worktree path from the report's Worktree: line, which must exist. */
function resolveWorktree(lines, at) {
  const label = findLabel(lines, at, 'Worktree(?:\\s+(?:path|dir|directory))?');
  const written = label ? worktreeText(lines, label) : '';
  if (!written) {
    block(
      'The completion report names no worktree.\n\n' +
      'Add the path of the worktree you worked in, e.g.\nWorktree: .worktrees/bd-{BEAD_ID}'
    );
  }
  const worktree = path.resolve(getProjectDir(), fromGitBash(written));
  if (!isDirectory(worktree)) {
    block(`The worktree named in the report does not exist: ${worktree}\n\n${RETRY}`);
  }
  return worktree;
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Block unless the path is the top directory of a linked worktree. Git
 * answers both questions itself, so no path strings are compared: a prefix
 * means a directory inside a checkout, and a git dir that is the common one
 * means the main checkout, where bead work does not happen.
 */
function verifyLinkedWorktree(worktree) {
  const prefix = git(worktree, 'rev-parse', '--show-prefix');
  if (prefix === null) {
    block(`The path on the Worktree: line is not a git worktree: ${worktree}\n\n${RETRY}`);
  }
  if (prefix) {
    block(
      'The path on the Worktree: line is inside a git checkout, not the top of ' +
      `a worktree: ${worktree}\n\n${RETRY}`
    );
  }
  const dirs = git(worktree, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir');
  const [own, common] = (dirs || '').split(/\r?\n/);
  if (own && own === common) {
    block(`The path on the Worktree: line is the main checkout, not a bead worktree: ${worktree}\n\n${RETRY}`);
  }
}

/** Block when the worktree has anything uncommitted. */
function verifyCommitted(worktree) {
  const status = git(worktree, 'status', '--porcelain');
  if (!status) return;
  block(
    `The worktree has uncommitted changes: ${worktree}\n\n${status}\n\n` +
    'Commit them from the worktree:\n  git add -A && git commit -m "..."'
  );
}

/**
 * Block unless origin holds the worktree's branch at the worktree's HEAD.
 * No origin, or an origin that cannot be reached, is not the subagent's fault.
 */
function verifyPushed(worktree) {
  if (!git(worktree, 'remote', 'get-url', 'origin')) return;
  const head = git(worktree, 'rev-parse', 'HEAD');
  if (!head) return;
  // The full name: a tag of the same name turns the short one into "heads/x".
  const ref = git(worktree, 'symbolic-ref', '-q', 'HEAD');
  if (!ref) {
    block(`The worktree is on a detached HEAD: ${worktree}\n\nCheck out the bead branch, commit and push it.`);
  }
  const listing = git(worktree, 'ls-remote', '--heads', 'origin', ref);
  if (listing === null) return;
  const branch = ref.replace(/^refs\/heads\//, '');
  const remote = remoteSha(listing, ref);
  const push = `Push it from ${worktree}:\n  git push -u origin HEAD`;
  if (!remote) block(`Branch ${branch} is not on origin.\n\n${push}`);
  if (remote !== head) {
    block(`Branch ${branch} on origin is at ${remote}, the worktree is at ${head}.\n\n${push}`);
  }
}

/** The sha ls-remote lists for exactly this ref, or ''. */
function remoteSha(listing, ref) {
  for (const line of listing.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref) return sha;
  }
  return '';
}

/** git in the worktree; never waits for a password prompt. */
function git(worktree, ...args) {
  return execCommand('git', ['-C', worktree, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}
