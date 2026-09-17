#!/usr/bin/env node
'use strict';

// SessionStart: Surface what the task tracker cannot see.
//
// Deliberately NOT here: the list of in-progress / ready / blocked / stale
// beads. `bd prime` already prints it at session start, and running four more
// `bd` calls to print the same thing twice only slows the session down. What
// stays is what bd has no way to know: the state of the working tree, merged
// worktrees waiting to be cleaned up, and open pull requests.

const fs = require('fs');
const path = require('path');
const {
  injectText, execCommand, execCommandJSON, getProjectDir, runHook,
  parseBdVersion, versionBelow, BD_MIN_VERSION,
  hasBeads, isPluginInstall, readOwnVersion, updateNotice,
  leftoverProjectHooks,
} = require('./hook-utils.cjs');

runHook('session-start', () => {
  const projectDir = getProjectDir();

  if (!hasBeads()) {
    // A copy installed under a project's .claude/hooks/ is there because
    // someone put it there, so the missing directory is worth saying out loud.
    // The plugin runs in every project it is enabled for, and telling each of
    // them to run `bd init` every session is noise, not help.
    if (!isPluginInstall()) {
      injectText("No .beads directory found. Run 'bd init' to initialize.\n");
    }
    process.exit(0);
  }

  const output = [];
  const repoRoot = execCommand('git', ['-C', projectDir, 'rev-parse', '--show-toplevel']);

  collectDoubleInstall(projectDir, output);
  collectOutdatedBd(output);
  collectUpdateNotice(output);
  collectDirtyWarning(repoRoot, output);
  collectMergedWorktrees(projectDir, repoRoot, output);
  collectOpenPrs(output);

  if (output.length === 0) process.exit(0);
  injectText(output.join('\n') + '\n');
});

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * A bd older than the rules rely on does not announce itself: it fails one
 * command at a time with "unknown command" in the middle of a task. One line
 * here is the explanation. Silent when bd cannot be read at all — an
 * unreadable version is not evidence of an old one.
 */
function collectOutdatedBd(output) {
  const found = parseBdVersion(execCommand('bd', ['version']) || '');
  if (!versionBelow(found, BD_MIN_VERSION)) return;

  output.push(`WARNING: bd ${found} is older than ${BD_MIN_VERSION}, which the rules rely on`);
  output.push('   (bd memories, bd remember, bd worktree, bd prime).');
  output.push('   Update it: npm install -g @beads/bd@latest');
  output.push('');
}

/**
 * This project installed the hooks from npx, and the plugin supplies them too.
 *
 * The copy under .claude/hooks/ has already stood down — runHook sees the
 * plugin is active and exits — so nothing fires twice. That silence is only
 * explainable if someone says the leftovers are there, and only the plugin
 * copy is in a position to: the project copy is the one keeping quiet.
 */
function collectDoubleInstall(projectDir, output) {
  if (!isPluginInstall()) return;
  const leftover = leftoverProjectHooks(projectDir);
  if (leftover.length === 0) return;

  output.push('Claude Protocol is installed twice here: as a plugin, and in');
  output.push(`   .claude/settings.json from npx (${leftover.join(', ')}).`);
  output.push('   The plugin is running them; the copies in the project stand');
  output.push('   down, so nothing fires twice.');
  output.push('   Run /claude-protocol:init to remove the leftovers.');
  output.push('');
}

/**
 * A newer claude-protocol than the one running here.
 *
 * The check lives in its own process with a hard time limit, and its answer is
 * cached for a week — a session start is not the place to wait on the network.
 * Nothing to say when the version cannot be read, when the check fails, or
 * when there is no network: an update people do not hear about costs less than
 * a slow start every time.
 */
function collectUpdateNotice(output) {
  const current = readOwnVersion();
  if (!current) return;

  const script = path.join(__dirname, 'update-check.cjs');
  if (!fs.existsSync(script)) return;

  const latest = execCommand(process.execPath, [script],
                             { shell: false, timeout: 6000 });
  const lines = updateNotice(current, latest, isPluginInstall());
  if (lines) output.push(...lines);
}

/** Uncommitted work in the main checkout means agents would branch off it. */
function collectDirtyWarning(repoRoot, output) {
  if (!repoRoot) return;
  if (!execCommand('git', ['-C', repoRoot, 'status', '--porcelain'])) return;

  output.push('WARNING: Main directory has uncommitted changes.');
  output.push('   Agents should only work in .worktrees/');
  output.push('');
}

/**
 * A .worktrees/bd-* worktree whose branch was merged, and its bead.
 *
 * For a long time this check never fired, and nothing said so: it asked git
 * about a branch literally called main, git ancestry cannot see a squash
 * merge, and the plain `git branch` listing marks every worktree's branch with
 * "+ ", so no name ever matched. A check that fails quietly looks exactly like
 * one with nothing to report — when neither source can answer, that is said.
 */
function collectMergedWorktrees(projectDir, repoRoot, output) {
  if (!repoRoot || !fs.existsSync(path.join(projectDir, '.worktrees'))) return;

  const worktrees = listBeadWorktrees(repoRoot);
  if (worktrees.length === 0) return;

  const merged = collectMergedBranches(repoRoot, worktrees.map(worktree => worktree.branch));
  if (!merged) {
    output.push('WARNING: could not tell which .worktrees/bd-* branches were merged.');
    output.push('   Neither gh (merged pull requests) nor git (branches merged into');
    output.push('   the main branch) answered, so leftover worktrees go unreported.');
    output.push('');
    return;
  }

  const done = worktrees.filter(worktree => merged.has(worktree.branch));
  if (done.length === 0) return;

  const beads = confirmedBeads(done.map(worktree => worktree.beadGuess));
  for (const worktree of done) {
    reportMergedWorktree(worktree, beads.get(worktree.beadGuess), output);
  }
}

/** Worktrees under .worktrees/bd-*, with the branch each one has checked out. */
function listBeadWorktrees(repoRoot) {
  const list = execCommand('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']);
  if (!list) return [];

  const worktrees = [];
  for (const entry of list.split(/\r?\n\r?\n/)) {
    const lines = entry.split(/\r?\n/);
    const where = lines.find(line => line.startsWith('worktree '));
    const ref = lines.find(line => line.startsWith('branch refs/heads/'));
    // A detached worktree has no branch that could have been merged.
    if (!where || !ref || !where.includes('.worktrees/bd-')) continue;

    const branch = ref.slice('branch refs/heads/'.length);
    worktrees.push({
      path: where.slice('worktree '.length),
      branch,
      beadGuess: branch.startsWith('bd-') ? branch.slice('bd-'.length) : '',
    });
  }
  return worktrees;
}

/**
 * Names of merged branches, or null when no source could answer.
 *
 * Two sources, because each misses what the other sees: a squash-merged pull
 * request never becomes an ancestor of the main branch, and a branch merged
 * locally never shows up on GitHub. git is asked about `candidates` only.
 */
function collectMergedBranches(repoRoot, candidates) {
  const fromGitHub = mergedPullRequestBranches();
  const fromGit = branchesMergedInGit(repoRoot, candidates);
  if (!fromGitHub && !fromGit) return null;
  return new Set([...(fromGitHub || []), ...(fromGit || [])]);
}

function mergedPullRequestBranches() {
  const prs = execCommandJSON('gh', [
    'pr', 'list', '--state', 'merged', '--limit', '100', '--json', 'headRefName',
  ]);
  if (!Array.isArray(prs)) return null;
  return prs.map(pr => pr && pr.headRefName).filter(Boolean);
}

function branchesMergedInGit(repoRoot, candidates) {
  const main = resolveMainBranch(repoRoot);
  if (!main) return null;
  // --format, not the plain listing: that one marks a branch checked out in
  // another worktree with "+ ", and every bd-* branch here is one.
  const merged = execCommand('git', [
    '-C', repoRoot, 'branch', '--format=%(refname:short)', '--merged', main,
  ]);
  if (merged === null) return null;
  return merged.split(/\r?\n/).map(name => name.trim())
    .filter(name => candidates.includes(name) && hasOwnCommits(repoRoot, name));
}

/**
 * True when someone ever committed on this branch.
 *
 * `git branch --merged` also lists a branch with no commits of its own — it
 * sits on the main branch's history as well. That is every worktree created a
 * minute ago, and the advice would be to force-remove it while someone works
 * in it. The branch's own reflog tells the two apart. A branch whose reflog is
 * gone counts as not merged: a cleanup nobody hears about costs less than a
 * worktree removed from under someone.
 */
function hasOwnCommits(repoRoot, branch) {
  const reflog = execCommand('git', [
    '-C', repoRoot, 'reflog', 'show', '--format=%gs', `refs/heads/${branch}`, '--',
  ]);
  return Boolean(reflog) && reflog.split(/\r?\n/).some(entry => entry.startsWith('commit'));
}

/**
 * The main branch: whatever origin/HEAD names, as a clone records it.
 * Without it, main before master — a repository carrying both has usually
 * moved to main and kept the old one around.
 */
function resolveMainBranch(repoRoot) {
  const git = (...args) => execCommand('git', ['-C', repoRoot, ...args]);
  const head = git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD');
  if (head) return head.replace(/^refs\/remotes\/origin\//, '');
  return ['main', 'master']
    .find(name => git('rev-parse', '--verify', '--quiet', `refs/heads/${name}`)) || null;
}

/**
 * The beads bd knows by exactly these ids, one `bd show` for all of them.
 *
 * A worktree's name is only a guess at its bead's id: in a project whose ids
 * carry a prefix, bd-219 is not the id of anything. And `bd show` answers a
 * partial id with whatever bead it matches, so a bead counts only when its id
 * comes back unchanged.
 */
function confirmedBeads(guesses) {
  const ids = guesses.filter(Boolean);
  const beads = new Map();
  if (ids.length === 0) return beads;

  const found = execCommandJSON('bd', ['show', '--json', '--', ...ids]);
  for (const bead of (Array.isArray(found) ? found : [])) {
    if (bead && ids.includes(bead.id) && typeof bead.status === 'string') {
      beads.set(bead.id, bead);
    }
  }
  return beads;
}

/**
 * The cleanup is `git worktree remove --force` and `git worktree prune`:
 * `bd worktree remove` is broken on Windows (u51), and the rules allow these.
 */
function reportMergedWorktree(worktree, bead, output) {
  output.push(`ACTION REQUIRED: branch ${worktree.branch} was merged, but its worktree is still here.`);
  if (!bead) {
    output.push('   bd did not confirm which bead it belongs to — look the bead up and');
    output.push('   close it if it is still open.');
  } else if (bead.status !== 'closed') {
    output.push(`   Its bead ${bead.id} is still ${bead.status}: bd close "${bead.id}"`);
  }
  output.push(`   Remove it: git worktree remove --force "${worktree.path}" && git worktree prune`);
  output.push('');
}

/** Open pull requests are easy to forget between sessions. */
function collectOpenPrs(output) {
  const openPrs = execCommand('gh', [
    'pr', 'list', '--author', '@me', '--state', 'open',
    '--json', 'number,title,headRefName',
  ]);
  if (!openPrs || openPrs === '[]') return;

  let prs;
  try {
    prs = JSON.parse(openPrs);
  } catch {
    return;
  }
  if (!Array.isArray(prs) || prs.length === 0) return;

  output.push('You have open PRs:');
  for (const pr of prs) {
    output.push(`  #${pr.number} ${pr.title} (${pr.headRefName})`);
  }
  output.push('');
}
