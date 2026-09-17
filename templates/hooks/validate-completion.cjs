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
// line, `*` and numbered list items. A false block costs a subagent a whole
// extra turn; every such shape here was once a false block.

const fs = require('fs');
const path = require('path');
const {
  readStdinJSON, getField, approve, block, hasBeads,
  execCommand, getProjectDir, runHook,
} = require('./hook-utils.cjs');

// A report starts a line, maybe under a heading mark or in bold. A marker
// quoted inside a sentence is someone talking about a report.
const REPORT = /^[ \t]*(?:#+[ \t]*)?[*_]*BEAD\s+(\S+)\s+COMPLETE/m;
// A checklist item: "- [x]", "* [ ]", "+ [ ]", "1. [ ]", "2) [ ]".
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\[(.?)\]/;
const TICKED = new Set(['x', 'X', '✓', '✔']);
// "Files:", "**Found along the way**:" — two letters at least, so "C:\..." is not one.
const LABEL_LINE = /^\s*(?:[-*+]\s+)?[*_]*[A-Za-z][A-Za-z ]+[*_]*\s*:/;
const QUOTED = [/`([^`]+)`/g, /"([^"]+)"/g, /'([^']+)'/g];

runHook('validate-completion', () => {
  const input = readStdinJSON();

  // Every check here is about the bead lifecycle. As a plugin this runs after
  // every subagent in every project, and a project without .beads/ has no
  // lifecycle to verify.
  if (!hasBeads()) approve();
  // Already sent back once: let it go rather than argue in a loop.
  if (getField(input, 'stop_hook_active') === true) approve();

  const message = getField(input, 'last_assistant_message');
  const found = typeof message === 'string' ? REPORT.exec(message) : null;
  if (!found) approve();

  // What the report says follows its first line; prose before it is not part of it.
  const lines = message.slice(found.index).split(/\r?\n/);
  verifyChecklist(lines, found[1]);
  const worktree = resolveWorktree(lines);
  verifyCommitted(worktree);
  verifyPushed(worktree);
  approve();
});

// ---------------------------------------------------------------------------
// Reading the report
// ---------------------------------------------------------------------------

/**
 * The first "Label:" line — its index, indent and the text after the colon —
 * or null. A list marker in front and bold around the label are allowed.
 */
function findLabel(lines, label) {
  const re = new RegExp(`^(\\s*)(?:[-*+]\\s+)?[*_]*${label}[*_]*\\s*:[*_]*(.*)$`, 'i');
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) return { index: i, indent: m[1].length, rest: m[2].trim() };
  }
  return null;
}

/**
 * The marks of the checklist's items: "x", " ", "". The list ends at the
 * first line that is neither an item nor indented deeper than the label, so
 * "Found along the way:" and whatever follows it are not part of it.
 */
function checklistMarks(lines, label) {
  const marks = [];
  const first = ITEM.exec(label.rest);
  if (first) marks.push(first[1]);
  for (const line of lines.slice(label.index + 1)) {
    if (!line.trim()) continue;
    const item = ITEM.exec(line);
    if (item) marks.push(item[1]);
    else if (line.search(/\S/) <= label.indent) break;
  }
  return marks;
}

/** The path a Worktree: line names — on the line itself, or on the next one. */
function worktreeText(lines, label) {
  if (label.rest) return pathIn(label.rest);
  const next = lines.slice(label.index + 1).find(line => line.trim()) || '';
  return LABEL_LINE.test(next) ? '' : pathIn(next);
}

/**
 * The path in a piece of text: quoted if it is quoted, else the first token
 * that looks like a path. What follows it — "(branch x)", "— pushed", a full
 * stop — is not part of it.
 */
function pathIn(text) {
  for (const re of QUOTED) {
    for (const m of text.matchAll(re)) {
      if (isPathLike(m[1])) return m[1].trim();
    }
  }
  const tokens = text.split(/[\s[\]()<>]+/).map(tidyToken).filter(Boolean);
  return tokens.find(isPathLike) || tokens[0] || '';
}

function isPathLike(text) {
  return /[\\/]/.test(text) || text.trim().startsWith('.');
}

function tidyToken(token) {
  return token
    .replace(/^[`'"*]+|[`'"*]+$/g, '')
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
function verifyChecklist(lines, beadId) {
  const label = findLabel(lines, 'Checklist');
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
function resolveWorktree(lines) {
  const label = findLabel(lines, 'Worktree');
  const written = label ? worktreeText(lines, label) : '';
  if (!written) {
    block(
      'The completion report names no worktree.\n\n' +
      'Add the path of the worktree you worked in, e.g.\nWorktree: .worktrees/bd-{BEAD_ID}'
    );
  }
  const worktree = path.resolve(getProjectDir(), fromGitBash(written));
  if (!isDirectory(worktree)) {
    block(
      `The worktree named in the report does not exist: ${worktree}\n\n` +
      'Put the path of the worktree you actually worked in on the Worktree: line.'
    );
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

/** Block when the path is no git worktree, or the worktree has anything uncommitted. */
function verifyCommitted(worktree) {
  if (git(worktree, 'rev-parse', '--is-inside-work-tree') !== 'true') {
    block(
      `The path on the Worktree: line is not a git worktree: ${worktree}\n\n` +
      'Put the path of the worktree you actually worked in on the Worktree: line.'
    );
  }
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
