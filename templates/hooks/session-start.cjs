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

  // Both sources measure against the main branch; without one, neither can.
  const main = resolveMainBranch(repoRoot);
  const sources = {
    github: main && mergedPullRequests(repoRoot, main.name),
    git: main && branchesMergedInGit(repoRoot, main.ref, worktrees.map(w => w.branch)),
  };
  if (!sources.github && !sources.git) return warnNobodyAnswered(output);

  const found = worktrees
    .map(worktree => ({ ...worktree, verdict: mergeVerdict(repoRoot, worktree, sources) }))
    .filter(worktree => worktree.verdict);
  if (found.length === 0) return;

  const beads = confirmedBeads(found.map(worktree => worktree.beadGuess));
  for (const worktree of found) {
    reportMergedWorktree(worktree, beads.get(worktree.beadGuess), output);
  }
}

function warnNobodyAnswered(output) {
  output.push('WARNING: could not tell which .worktrees/bd-* branches were merged.');
  output.push('   Neither GitHub (merged pull requests of origin) nor git (branches');
  output.push('   merged into the main branch) answered, so leftover worktrees go');
  output.push('   unreported.');
  output.push('');
}

/** Worktrees under .worktrees/bd-*, each with its branch, tip and lock. */
function listBeadWorktrees(repoRoot) {
  const list = execCommand('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']);
  if (!list) return [];
  return list.split(/\r?\n\r?\n/).map(parseWorktreeEntry).filter(Boolean);
}

/** One `git worktree list --porcelain` entry, or null if it is not ours. */
function parseWorktreeEntry(entry) {
  const lines = entry.split(/\r?\n/);
  const field = (name) => {
    const line = lines.find(candidate => candidate.startsWith(`${name} `));
    return line ? line.slice(name.length + 1) : '';
  };
  const where = field('worktree');
  const ref = field('branch');
  // A detached worktree has no branch that could have been merged.
  if (!where.includes('.worktrees/bd-') || !ref.startsWith('refs/heads/')) return null;

  const branch = ref.slice('refs/heads/'.length);
  return {
    path: where,
    branch,
    head: field('HEAD'),
    locked: lines.some(line => line === 'locked' || line.startsWith('locked ')),
    beadGuess: branch.startsWith('bd-') ? branch.slice('bd-'.length) : '',
  };
}

/**
 * 'merged', 'unconfirmed' (looks merged, but there is no reflog to check it
 * against), or null.
 *
 * Neither source is taken at its word. git lists every branch whose tip sits
 * on the main branch's history — a fresh one, or one whose commit was undone
 * with `git reset` — so its answer counts only when the tip is a commit made
 * on this branch. GitHub knows branch names, and short names come back, so a
 * pull request counts only when it was merged with this tip in it, and only
 * for a branch someone has committed on.
 */
function mergeVerdict(repoRoot, worktree, sources) {
  const claims = mergeClaims(repoRoot, worktree, sources);
  if (!claims.git && !claims.github) return null;

  const history = branchHistory(repoRoot, worktree);
  if (!history) return 'unconfirmed';
  const confirmed = (claims.git && history.tipCommitted)
    || (claims.github && history.everCommitted);
  return confirmed ? 'merged' : null;
}

/** Which sources say this worktree's branch was merged. */
function mergeClaims(repoRoot, worktree, sources) {
  const pullRequests = sources.github || [];
  return {
    git: Boolean(sources.git && sources.git.has(worktree.branch)),
    github: pullRequests.some(pr => pr.headRefName === worktree.branch
      && pullRequestContains(repoRoot, pr.headRefOid, worktree.head)),
  };
}

/** True when a merged pull request's head is this tip or comes after it. */
function pullRequestContains(repoRoot, prHead, tip) {
  if (!tip || typeof prHead !== 'string' || !/^[0-9a-f]{40,64}$/.test(prHead)) return false;
  if (prHead === tip) return true;
  // null is both "not an ancestor" and "that commit is not here at all".
  return execCommand('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', tip, prHead]) !== null;
}

/**
 * What the branch's own reflog says about commits made on it, or null when
 * there is no reflog: gc expires it after 90 days, and
 * core.logAllRefUpdates=false never writes one.
 */
function branchHistory(repoRoot, worktree) {
  const reflog = execCommand('git', [
    '-C', repoRoot, 'reflog', 'show', '--format=%H %gs', `refs/heads/${worktree.branch}`, '--',
  ]);
  if (!reflog) return null;

  // "<hash> commit: ...", "<hash> commit (amend): ..." — not reset, merge,
  // rebase or the branch's creation, which move it without making anything.
  const commits = reflog.split(/\r?\n/)
    .map(line => line.split(' '))
    .filter(([, action]) => action && action.startsWith('commit'));
  return {
    everCommitted: commits.length > 0,
    tipCommitted: commits.some(([hash]) => hash === worktree.head),
  };
}

/**
 * Pull requests of origin merged into `mainName`, or null when GitHub could
 * not be asked.
 *
 * Always about origin by name: without a default repository set, gh picks the
 * fork's parent on its own and answers with an empty list, which looks
 * exactly like "nothing merged". One question for all worktrees — asking per
 * branch took seconds each — so only the latest 200 merges are seen; a
 * squash merge older than that goes unreported.
 */
function mergedPullRequests(repoRoot, mainName) {
  const repo = githubRepo(repoRoot);
  if (!repo) return null;

  const prs = execCommandJSON('gh', [
    'pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '200',
    '--json', 'headRefName,headRefOid,baseRefName',
  ]);
  if (!Array.isArray(prs)) return null;
  return prs.filter(pr => pr && typeof pr.headRefName === 'string'
    && pr.baseRefName === mainName);
}

/**
 * owner/name of origin when origin is on GitHub, or null. Takes https and ssh
 * URLs, the scp form (git@github.com:o/n), a port, ssh.github.com, an ssh
 * host alias written as github.com-<name>, any letter case, with or without
 * .git. GitHub Enterprise hosts are not recognised.
 */
function githubRepo(repoRoot) {
  const url = execCommand('git', ['-C', repoRoot, 'remote', 'get-url', 'origin']) || '';
  const match = /^(?:[a-z][\w+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i
    .exec(url);
  const onGitHub = match && /^(?:ssh\.|www\.)?github\.com(?:-[\w.-]+)?$/i.test(match[1]);
  return onGitHub ? `${match[2]}/${match[3]}` : null;
}

/** Those of `candidates` git lists as merged into `mainRef`, or null. */
function branchesMergedInGit(repoRoot, mainRef, candidates) {
  // --format, not the plain listing: that one marks a branch checked out in
  // another worktree with "+ ", and every bd-* branch here is one.
  const merged = execCommand('git', [
    '-C', repoRoot, 'branch', '--format=%(refname:short)', '--merged', mainRef,
  ]);
  if (merged === null) return null;
  return new Set(merged.split(/\r?\n/).map(name => name.trim())
    .filter(name => candidates.includes(name)));
}

/**
 * The main branch: its name, and the ref to measure merges against. The name
 * comes from origin/HEAD, as a clone records it; without it, main before
 * master — a repository carrying both has usually moved to main and kept the
 * old one around. origin's copy is the ref of choice: a local main nobody has
 * pulled lately does not know what was merged.
 */
function resolveMainBranch(repoRoot) {
  const git = (...args) => execCommand('git', ['-C', repoRoot, ...args]);
  const head = git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD');
  const names = head ? [head.replace(/^refs\/remotes\/origin\//, '')] : ['main', 'master'];
  for (const name of names) {
    const ref = [`refs/remotes/origin/${name}`, `refs/heads/${name}`]
      .find(candidate => git('rev-parse', '--verify', '--quiet', candidate));
    if (ref) return { name, ref };
  }
  return null;
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

function reportMergedWorktree(worktree, bead, output) {
  const confirmed = worktree.verdict === 'merged';
  output.push(confirmed
    ? `ACTION REQUIRED: branch ${worktree.branch} was merged, but its worktree is still here.`
    : `CHECK BY HAND: branch ${worktree.branch} looks merged, but git keeps no reflog for it to confirm that.`);
  output.push(...beadLines(bead));
  output.push(...(confirmed ? cleanupLines(worktree) : [`   Worktree: ${worktree.path}`]));
  output.push('');
}

function beadLines(bead) {
  if (!bead) {
    return [
      '   bd did not confirm which bead it belongs to — look the bead up and',
      '   close it if it is still open.',
    ];
  }
  if (bead.status === 'closed') return [];
  return [`   Its bead ${bead.id} is still ${bead.status}: bd close "${bead.id}"`];
}

/**
 * How to clean up, or why not to.
 *
 * Whatever the merge check above concluded, a removal command is printed only
 * for a worktree read as clean — and without --force, so git's own check
 * stays as a second net. A locked worktree refuses removal, and `&&` would
 * then skip the prune. `bd worktree remove` is broken on Windows (u51); the
 * rules allow git's own commands instead.
 */
function cleanupLines(worktree) {
  if (worktree.locked) {
    return [`   It is locked (git worktree lock), so it is left alone: ${worktree.path}`];
  }
  if (!worktreeIsClean(worktree.path)) {
    return [
      '   Not suggesting removal: it holds uncommitted work, or its state could',
      `   not be read. Look at it by hand: ${worktree.path}`,
    ];
  }
  return [
    `   Remove it: git worktree remove "${worktree.path}" && git worktree prune`,
    '   (ignored files in it, such as .env, go with the directory)',
  ];
}

/**
 * True only when git read this worktree and found nothing uncommitted.
 *
 * Plain `git status --porcelain` is not enough: it obeys
 * status.showUntrackedFiles=no and a submodule's ignore = all, and it never
 * shows a change in a file marked skip-worktree or assume-unchanged — every
 * one of those was deleted in a test. And a worktree that lost its .git file
 * sends `git -C` up to the main checkout, which would be read instead.
 */
function worktreeIsClean(worktreePath) {
  if (!isLinkedWorktreeRoot(worktreePath)) return false;

  const status = execCommand('git', [
    '-C', worktreePath, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none',
  ]);
  // -v tags each file: H is an ordinary one; S is skip-worktree, lower case
  // is assume-unchanged. One line per file, hence the larger buffer.
  const index = execCommand('git', ['-C', worktreePath, 'ls-files', '-v'],
                            { maxBuffer: 64 * 1024 * 1024 });
  return status === '' && index !== null
    && index.split(/\r?\n/).every(line => line === '' || line.startsWith('H '));
}

/** True when `git -C` answers from this linked worktree's root, not from above it. */
function isLinkedWorktreeRoot(worktreePath) {
  const answer = execCommand('git', [
    '-C', worktreePath, 'rev-parse', '--path-format=absolute',
    '--git-dir', '--show-prefix', '--git-common-dir',
  ]);
  // The prefix sits in the middle, so an empty one survives the trim.
  const [gitDir, prefix, commonDir, ...rest] = (answer || '').split(/\r?\n/);
  return Boolean(gitDir && commonDir) && prefix === '' && gitDir !== commonDir
    && rest.length === 0;
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
