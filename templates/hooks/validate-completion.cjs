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

const fs = require('fs');
const path = require('path');
const {
  readStdinJSON, getField, approve, block, hasBeads,
  execCommand, getProjectDir, runHook,
} = require('./hook-utils.cjs');

const REPORT = /BEAD\s+(\S+)\s+COMPLETE/;

runHook('validate-completion', () => {
  const input = readStdinJSON();

  // Every check here is about the bead lifecycle. As a plugin this runs after
  // every subagent in every project, and a project without .beads/ has no
  // lifecycle to verify.
  if (!hasBeads()) approve();
  // Already sent back once: let it go rather than argue in a loop.
  if (getField(input, 'stop_hook_active') === true) approve();

  const message = getField(input, 'last_assistant_message');
  const report = typeof message === 'string' ? message.match(REPORT) : null;
  if (!report) approve();

  verifyChecklist(message, report[1]);
  const worktree = resolveWorktree(message);
  verifyCommitted(worktree);
  verifyPushed(worktree);
  approve();
});

/** Block unless the report has a Checklist: with every item ticked. */
function verifyChecklist(message, beadId) {
  if (!message.includes('Checklist:')) {
    block(
      'The completion report has no Checklist:.\n\n' +
      `Re-read the requirements with \`bd show ${beadId}\` and add one line per ` +
      'requirement to the report:\nChecklist:\n- [x] requirement 1\n- [x] requirement 2'
    );
  }
  // An item is a line of its own: a report may well mention "- [ ]" in prose.
  const unchecked = message.match(/^\s*- \[ \]/gm);
  if (unchecked) {
    block(
      `The Checklist has ${unchecked.length} unchecked item(s).\n\n` +
      'Finish them and tick them before reporting COMPLETE. If a requirement ' +
      'cannot be met, say why in a bead comment instead of reporting COMPLETE.'
    );
  }
}

/** The absolute worktree path from the report's Worktree: line, which must exist. */
function resolveWorktree(message) {
  const line = message.match(/Worktree:(.*)$/m);
  const written = line ? line[1].replace(/[`'"*]/g, '').trim() : '';
  if (!written) {
    block(
      'The completion report has no Worktree: line.\n\n' +
      'Add the path of the worktree you worked in, e.g.\nWorktree: .worktrees/bd-{BEAD_ID}'
    );
  }
  const worktree = path.resolve(getProjectDir(), written);
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

/** Block when the worktree has anything uncommitted. */
function verifyCommitted(worktree) {
  const status = execCommand('git', ['-C', worktree, 'status', '--porcelain']);
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
  const git = (...args) => execCommand('git', ['-C', worktree, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (!git('remote', 'get-url', 'origin')) return;
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const head = git('rev-parse', 'HEAD');
  if (!branch || !head) return;
  if (branch === 'HEAD') {
    block(`The worktree is on a detached HEAD: ${worktree}\n\nCheck out the bead branch, commit and push it.`);
  }
  const listing = git('ls-remote', '--heads', 'origin', branch);
  if (listing === null) return;
  const remote = remoteSha(listing, branch);
  const push = `Push it from ${worktree}:\n  git push -u origin ${branch}`;
  if (!remote) block(`Branch ${branch} is not on origin.\n\n${push}`);
  if (remote !== head) {
    block(`Branch ${branch} on origin is at ${remote}, the worktree is at ${head}.\n\n${push}`);
  }
}

/** The sha ls-remote lists for exactly refs/heads/<branch>, or ''. */
function remoteSha(listing, branch) {
  for (const line of listing.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref === `refs/heads/${branch}`) return sha;
  }
  return '';
}
