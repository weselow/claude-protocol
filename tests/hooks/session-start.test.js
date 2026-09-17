import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOOK_PATH = path.resolve(__dirname, '../../templates/hooks/session-start.cjs');
const OWN_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')).version;

/**
 * A throwaway project with beads, optionally wiring hooks of ours itself.
 * The hook runs with its working directory inside it, so the git and gh calls
 * in the other sections fail fast instead of reaching a real repository.
 */
function project({ settings } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-'));
  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  for (const [name, contents] of Object.entries(settings || {})) {
    fs.writeFileSync(path.join(dir, '.claude', name), JSON.stringify(contents));
  }
  return dir;
}

/** A week is the update check's cache window; a fresh entry keeps it offline. */
function pluginDataSayingUpToDate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-data-'));
  fs.writeFileSync(path.join(dir, 'claude-protocol-update-check.json'),
                   JSON.stringify({ latest: OWN_VERSION, checkedAt: Date.now() }));
  return dir;
}

function runHook(dir, env = {}) {
  return spawnSync(process.execPath, [HOOK_PATH], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: dir,
      CLAUDE_PLUGIN_ROOT: '',
      CLAUDE_PLUGIN_DATA: pluginDataSayingUpToDate(),
      CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-cfg-')),
      ...env,
    },
  });
}

const OURS = {
  hooks: {
    PreToolUse: [{
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'node -e "..." bash-guard.cjs' }],
    }],
  },
};

describe('session-start on a project installed twice', () => {
  const asPlugin = { CLAUDE_PLUGIN_ROOT: path.join(os.tmpdir(), 'pretend-plugin') };

  it('says the npx install is still wired up, and what removes it', () => {
    const result = runHook(project({ settings: { 'settings.json': OURS } }), asPlugin);

    expect(result.stdout).toContain('installed twice');
    expect(result.stdout).toContain('bash-guard.cjs');
    expect(result.stdout).toContain('/claude-protocol:init');
  });

  it('says nothing where the project wires no hooks of ours', () => {
    const result = runHook(project(), asPlugin);

    expect(result.stdout).not.toContain('installed twice');
  });

  it('leaves it to the plugin to say — the project copy keeps quiet', () => {
    const result = runHook(project({ settings: { 'settings.json': OURS } }));

    expect(result.stdout).not.toContain('installed twice');
  });
});

// ---------------------------------------------------------------------------
// Worktrees whose branch was merged
// ---------------------------------------------------------------------------

const onWindows = process.platform === 'win32';

/** git with an identity of its own: a bare CI machine has none to commit with. */
function git(cwd, ...args) {
  const result = spawnSync('git', [
    '-c', 'user.name=test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', ...args,
  ], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * A project whose repository has one worktree, .worktrees/<branch>.
 *   work       — 'merged': a commit of its own, merged into main;
 *                'ahead':  a commit of its own and nothing more, the way a
 *                          squash merge leaves it: merged on GitHub, never an
 *                          ancestor of main;
 *                'fresh':  no commit of its own yet.
 *   originHead — origin/HEAD names the main branch, as it does in a clone.
 */
function repoWithWorktree({ main = 'main', branch = 'bd-x', work = 'merged', originHead = false } = {}) {
  const dir = project();
  git(dir, 'init', '-q', '-b', main);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'start');
  if (originHead) {
    git(dir, 'update-ref', `refs/remotes/origin/${main}`, 'HEAD');
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${main}`);
  }
  const worktree = path.join(dir, '.worktrees', branch);
  git(dir, 'worktree', 'add', '-q', '-b', branch, worktree);
  if (work !== 'fresh') git(worktree, 'commit', '-q', '--allow-empty', '-m', 'work');
  if (work === 'merged') git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', branch);
  // The path the way git prints it: forward slashes on Windows too.
  return { dir, worktree: git(worktree, 'rev-parse', '--show-toplevel') };
}

/**
 * A command `name` in `dir` that runs `<name>.cjs` from there. The script's
 * full path is written in, not %~dp0: a .cmd found through PATH and called
 * with its name in quotes, which is how execCommand calls it, gets the wrong
 * directory from %~dp0.
 */
function writeTool(dir, name, body) {
  const script = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(script, `const fs = require('fs');\nconst path = require('path');\n${body}`);
  if (onWindows) {
    fs.writeFileSync(path.join(dir, `${name}.cmd`),
      `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, name),
      `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
}

/**
 * PATH with `dir` first and no real gh or bd behind it. First is enough on
 * Linux and macOS. On Windows Node looks for gh.exe in every PATH directory
 * before cmd.exe gets to look for gh.cmd, so a real gh.exe further down would
 * still answer; those directories are left out.
 */
function pathWith(dir) {
  const hasRealTool = (entry) => ['gh', 'bd'].some(tool =>
    ['.exe', '.com', '.cmd', '.bat'].some(ext => fs.existsSync(path.join(entry, tool + ext))));
  const rest = (process.env.PATH || '').split(path.delimiter)
    .filter(entry => entry && !(onWindows && hasRealTool(entry)));
  return [dir, ...rest].join(path.delimiter);
}

/**
 * Fake gh and bd.
 *   merged — the branches `gh pr list --state merged` answers with, or null
 *            for a gh that fails, as it does without a GitHub remote.
 *   beads  — what bd knows. Like the real one, `bd show` also answers a
 *            partial id with the bead whose id ends in it.
 * Every gh call is logged, so a test can tell whether it was asked at all.
 */
function fakeTools({ merged = null, beads = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-bin-'));
  const log = path.join(dir, 'gh-calls.log');
  writeTool(dir, 'gh', `
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'gh-calls.log'), args.join(' ') + '\\n');
if (!args.includes('merged')) { console.log('[]'); process.exit(0); }
const merged = ${JSON.stringify(merged)};
if (merged === null) process.exit(1);
console.log(JSON.stringify(merged.map(headRefName => ({ headRefName }))));
`);
  writeTool(dir, 'bd', `
const [command, ...args] = process.argv.slice(2);
const beads = ${JSON.stringify(beads)};
const found = beads.filter(b => args.some(a => b.id === a || b.id.endsWith('-' + a)));
if (command !== 'show' || found.length === 0) process.exit(1);
console.log(JSON.stringify(found));
`);
  return {
    env: { PATH: pathWith(dir) },
    ghCalls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''),
  };
}

// A repository, a worktree and a dozen processes per test, several of them
// through cmd.exe on Windows: on a loaded machine that neared the 15 s default.
const SLOW = { timeout: 30000 };

describe('session-start on a worktree whose branch was merged', SLOW, () => {
  const report = (repo, tools) => runHook(repo.dir, tools.env).stdout;

  // Also the case the old check could never see: git marks a branch checked
  // out in another worktree with "+ ", and every bd-* branch is one.
  it('finds it in a repository whose main branch is master', () => {
    const repo = repoWithWorktree({ main: 'master' });
    const out = report(repo, fakeTools());

    expect(out).toContain('branch bd-x was merged');
    expect(out).toContain(`git worktree remove --force "${repo.worktree}"`);
    expect(out).toContain('git worktree prune');
  });

  it('takes the main branch from origin/HEAD, whatever it is called', () => {
    const repo = repoWithWorktree({ main: 'trunk', originHead: true });

    expect(report(repo, fakeTools())).toContain('branch bd-x was merged');
  });

  it('finds a branch merged by fast-forward, with no merge commit to show', () => {
    const repo = repoWithWorktree({ work: 'ahead' });
    git(repo.dir, 'merge', '-q', '--ff-only', 'bd-x');

    expect(report(repo, fakeTools())).toContain('branch bd-x was merged');
  });

  it('finds a squash-merged branch among the merged pull requests', () => {
    const repo = repoWithWorktree({ work: 'ahead' });

    expect(report(repo, fakeTools({ merged: ['bd-x'] })))
      .toContain('branch bd-x was merged');
  });

  it('says so when neither gh nor git can tell what was merged', () => {
    const repo = repoWithWorktree({ main: 'trunk' });
    const out = report(repo, fakeTools());

    expect(out).toContain('could not tell which');
    expect(out).not.toContain('was merged');
  });

  it('says nothing when the branch was not merged', () => {
    const repo = repoWithWorktree({ work: 'ahead' });
    const out = report(repo, fakeTools({ merged: ['bd-other'] }));

    expect(out).not.toContain('was merged');
    expect(out).not.toContain('could not tell');
  });

  // git lists a branch with no commits of its own as merged: it sits on main's
  // history too. The advice would be to force-remove a worktree in use.
  it('does not take a worktree nobody has committed in yet for a merged one', () => {
    const repo = repoWithWorktree({ work: 'fresh' });

    expect(report(repo, fakeTools({ merged: [] }))).not.toContain('was merged');
  });

  it('not even once main moved on and the fresh branch caught up with it', () => {
    const repo = repoWithWorktree({ work: 'fresh' });
    git(repo.dir, 'commit', '-q', '--allow-empty', '-m', 'someone else');
    git(repo.worktree, 'merge', '-q', '--ff-only', 'main');

    expect(report(repo, fakeTools({ merged: [] }))).not.toContain('was merged');
  });

  it('does not ask about merges when there is no bd-* worktree', () => {
    const dir = project();
    git(dir, 'init', '-q');
    fs.mkdirSync(path.join(dir, '.worktrees'));
    const tools = fakeTools({ merged: [] });
    const out = runHook(dir, tools.env).stdout;

    // The fake was reached (the open pull requests), just not about merges.
    expect(tools.ghCalls()).toContain('--state open');
    expect(tools.ghCalls()).not.toContain('merged');
    expect(out).not.toContain('could not tell');
  });
});

describe('session-start on the bead behind a merged worktree', SLOW, () => {
  const report = (repo, beads) => runHook(repo.dir, fakeTools({ beads }).env).stdout;

  it('names the bead and its status when bd knows that exact id', () => {
    const repo = repoWithWorktree({ branch: 'bd-app-7' });
    const out = report(repo, [{ id: 'app-7', status: 'in_progress' }]);

    expect(out).toContain('app-7 is still in_progress');
    expect(out).toContain('bd close "app-7"');
  });

  // bd show 219 finds app-219, which does not make it the bead of bd-219.
  it('takes nothing from a partial match', () => {
    const repo = repoWithWorktree({ branch: 'bd-219' });
    const out = report(repo, [{ id: 'app-219', status: 'open' }]);

    expect(out).toContain('branch bd-219 was merged');
    expect(out).not.toContain('app-219');
    expect(out).not.toContain('bd close');
    expect(out).toContain('look the bead up');
  });

  it('names no bead when bd does not answer', () => {
    const repo = repoWithWorktree();
    const out = report(repo, []);

    expect(out).toContain('branch bd-x was merged');
    expect(out).not.toContain('bd close');
    expect(out).not.toMatch(/bead \S+ is still/);
    expect(out).toContain('look the bead up');
  });

  it('asks nothing more of a bead that is already closed', () => {
    const repo = repoWithWorktree();
    const out = report(repo, [{ id: 'x', status: 'closed' }]);

    expect(out).toContain('branch bd-x was merged');
    expect(out).not.toContain('bd close');
    expect(out).not.toContain('look the bead up');
  });
});
