import { describe, it, expect, afterAll } from 'vitest';
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

/** A day is the update check's cache window; a fresh entry keeps it offline. */
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

// Every temporary directory this file makes is removed once it is done — a
// few hundred per run otherwise. Caught at fs.mkdtempSync, so each helper
// above and below is covered without passing a list around; only our own
// prefix is recorded.
const madeHere = [];
const mkdtemp = fs.mkdtempSync;
fs.mkdtempSync = (prefix, ...rest) => {
  const dir = mkdtemp(prefix, ...rest);
  if (path.basename(String(prefix)).startsWith('session-start-')) madeHere.push(dir);
  return dir;
};
afterAll(() => {
  fs.mkdtempSync = mkdtemp;
  for (const dir of madeHere) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

const onWindows = process.platform === 'win32';
const GITHUB = 'https://github.com/acme/widgets.git';

/** git with an identity of its own: a bare CI machine has none to commit with. */
function git(cwd, ...args) {
  const result = spawnSync('git', [
    '-c', 'user.name=test', '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args,
  ], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * A worktree .worktrees/<branch> in the repository at `dir`.
 *   work — 'merged': a commit of its own (work.txt), merged into main;
 *          'ahead':  a commit of its own and nothing more, the way a squash
 *                    merge leaves it: merged on GitHub, never an ancestor of
 *                    main;
 *          'fresh':  no commit of its own yet.
 * Returns the path the way git prints it: forward slashes on Windows too.
 */
function addWorktree(dir, branch, work) {
  const where = path.join(dir, '.worktrees', branch);
  git(dir, 'worktree', 'add', '-q', '-b', branch, where);
  if (work !== 'fresh') {
    fs.writeFileSync(path.join(where, 'work.txt'), `${branch}\n`);
    git(where, 'add', 'work.txt');
    git(where, 'commit', '-q', '-m', `work on ${branch}`);
  }
  if (work === 'merged') git(dir, 'merge', '-q', '--no-ff', '-m', `merge ${branch}`, branch);
  return git(where, 'rev-parse', '--show-toplevel');
}

/**
 * A project whose repository has one worktree (see addWorktree).
 *   origin     — the URL of an origin remote, if there is to be one.
 *   originHead — origin/<main> and origin/HEAD, as a clone that has pushed
 *                its main branch has them.
 */
function repoWithWorktree({
  main = 'main', branch = 'bd-x', work = 'merged', origin, originHead = false,
} = {}) {
  const dir = project();
  git(dir, 'init', '-q', '-b', main);
  // As the installer's .gitignore entry does: the main checkout reads clean.
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '\n.worktrees/\n');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'start');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  const worktree = addWorktree(dir, branch, work);
  if (originHead) {
    git(dir, 'update-ref', `refs/remotes/origin/${main}`, 'HEAD');
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${main}`);
  }
  return { dir, worktree, tip: () => git(worktree, 'rev-parse', 'HEAD') };
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
 * still answer; those directories are left out. Where git shares one with
 * them (a shims directory), the hook would find no git and every test below
 * would fail on a misleading assertion, so that is said up front instead.
 */
function pathWith(dir) {
  const has = (entry, tools) => tools.some(tool =>
    ['.exe', '.com', '.cmd', '.bat'].some(ext => fs.existsSync(path.join(entry, tool + ext))));
  const rest = (process.env.PATH || '').split(path.delimiter)
    .filter(entry => entry && !(onWindows && has(entry, ['gh', 'bd'])));
  if (onWindows && !rest.some(entry => has(entry, ['git']))) {
    throw new Error('git shares a PATH directory with gh or bd; these tests cannot hide one without the other');
  }
  return [dir, ...rest].join(path.delimiter);
}

/**
 * Fake gh and bd.
 *   prs     — the merged pull requests gh knows for acme/widgets, or null for
 *             a gh that fails. Asked about any other repository — or about
 *             none, which is how gh without a default repository ends up
 *             answering about the fork's parent — it answers with an empty
 *             list.
 *   openPrs — the open pull requests gh knows for acme/widgets; the same
 *             empty list for any other repository.
 *   beads   — what bd knows. Like the real one, `bd show` also answers a
 *             partial id with the bead whose id ends in it.
 *   lists   — what bd answers for each task list, by name: in_progress,
 *             ready, blocked, stale. An array is the answer; { after, beads }
 *             is the same answer `after` milliseconds late; a list left out
 *             fails, the way bd fails with no database to read.
 * Every gh and bd call is logged, so a test can tell what was asked.
 */
function fakeTools({ prs = null, openPrs = [], beads = [], lists = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-bin-'));
  const logOf = (tool) => {
    const log = path.join(dir, `${tool}-calls.log`);
    return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  };
  writeTool(dir, 'gh', `
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'gh-calls.log'), args.join(' ') + '\\n');
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const ours = value('--repo') === 'acme/widgets';
if (args.includes('open')) { console.log(JSON.stringify(ours ? ${JSON.stringify(openPrs)} : [])); process.exit(0); }
if (!args.includes('merged')) { console.log('[]'); process.exit(0); }
const prs = ${JSON.stringify(prs)};
if (prs === null) process.exit(1);
console.log(JSON.stringify(ours ? prs : []));
`);
  writeTool(dir, 'bd', `
fs.appendFileSync(path.join(__dirname, 'bd-calls.log'), process.argv.slice(2).join(' ') + '\\n');
const [command, ...args] = process.argv.slice(2);
if (command === 'show') {
  const beads = ${JSON.stringify(beads)};
  const found = beads.filter(b => args.some(a => b.id === a || b.id.endsWith('-' + a)));
  if (found.length === 0) process.exit(1);
  console.log(JSON.stringify(found));
  process.exit(0);
}
const lists = ${JSON.stringify(lists)};
const answer = lists[command === 'list' ? args[args.indexOf('--status') + 1] : command];
if (!answer) process.exit(1);
setTimeout(() => console.log(JSON.stringify(answer.beads || answer, null, 2)), answer.after || 0);
`);
  return {
    env: { PATH: pathWith(dir) },
    ghCalls: logOf('gh'),
    bdCalls: logOf('bd'),
  };
}

const pr = (headRefOid, { head = 'bd-x', base = 'main' } = {}) =>
  ({ headRefName: head, headRefOid, baseRefName: base });
const report = (repo, tools = fakeTools()) => runHook(repo.dir, tools.env).stdout;
const REMOVE = 'git worktree remove';

// A repository, a worktree and a dozen processes per test, several of them
// through cmd.exe on Windows: on a loaded machine that neared the 15 s default.
const SLOW = { timeout: 30000 };

describe('session-start on a worktree whose branch was merged', SLOW, () => {
  // Also the case the old check could never see: git marks a branch checked
  // out in another worktree with "+ ", and every bd-* branch is one.
  it('finds it in a repository whose main branch is master', () => {
    const repo = repoWithWorktree({ main: 'master' });
    const out = report(repo);

    expect(out).toContain('branch bd-x was merged');
    expect(out).toContain(`git worktree remove "${repo.worktree}" && git worktree prune`);
    // No --force: git's own check stays in place as a second net.
    expect(out).not.toContain('--force');
    expect(out).toContain('ignored files');
  });

  it('takes the main branch from origin/HEAD, whatever it is called', () => {
    const repo = repoWithWorktree({ main: 'trunk', originHead: true });

    expect(report(repo)).toContain('branch bd-x was merged');
  });

  it("goes by origin's main branch when the local one is behind it", () => {
    const repo = repoWithWorktree({ originHead: true });
    git(repo.dir, 'reset', '-q', '--hard', 'HEAD~1');

    expect(report(repo)).toContain('branch bd-x was merged');
  });

  it('finds a branch merged by fast-forward, with no merge commit to show', () => {
    const repo = repoWithWorktree({ work: 'ahead' });
    git(repo.dir, 'merge', '-q', '--ff-only', 'bd-x');

    expect(report(repo)).toContain('branch bd-x was merged');
  });

  it('finds a squash-merged branch with one question to GitHub', () => {
    const repo = repoWithWorktree({ work: 'ahead', origin: GITHUB });
    for (const n of [1, 2]) addWorktree(repo.dir, `bd-y${n}`, 'fresh');
    const tools = fakeTools({ prs: [pr(repo.tip())] });

    expect(report(repo, tools)).toContain('branch bd-x was merged');
    const asked = tools.ghCalls().split('\n').filter(call => call.includes('merged'));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('--limit 200');
    expect(asked[0]).toContain('baseRefName');
  });

  // Without --repo, gh with no default repository answers about the fork's
  // parent: an empty list, exit 0 — indistinguishable from "nothing merged".
  it.each([
    'git@github.com:acme/widgets.git',
    'git@github.com-work:acme/widgets.git',
    'ssh://git@github.com:22/acme/widgets.git',
    'ssh://git@ssh.github.com:443/acme/widgets.git',
    'https://GitHub.com/acme/widgets',
  ])('asks GitHub about origin by name, origin being %s', (origin) => {
    const repo = repoWithWorktree({ work: 'ahead', origin });
    const tools = fakeTools({ prs: [pr(repo.tip())] });

    expect(report(repo, tools)).toContain('branch bd-x was merged');
    expect(tools.ghCalls()).toContain('--repo acme/widgets');
  });

  it('finds a pull request that was merged with more commits than the worktree has', () => {
    const repo = repoWithWorktree({ work: 'ahead', origin: GITHUB });
    const mine = repo.tip();
    git(repo.worktree, 'commit', '-q', '--allow-empty', '-m', 'pushed from elsewhere');
    const merged = repo.tip();
    git(repo.worktree, 'reset', '-q', '--hard', mine);

    expect(report(repo, fakeTools({ prs: [pr(merged)] }))).toContain('branch bd-x was merged');
  });

  // Short ids come back: bd-8t9 was merged here long before any new bd-8t9.
  it('does not take a pull request of the same name for this branch', () => {
    const repo = repoWithWorktree({ work: 'ahead', origin: GITHUB });
    const tools = fakeTools({ prs: [pr('0123456789abcdef0123456789abcdef01234567')] });

    expect(report(repo, tools)).not.toContain('merged');
  });

  it('does not count a pull request the branch has moved past', () => {
    const repo = repoWithWorktree({ work: 'ahead', origin: GITHUB });
    const merged = repo.tip();
    git(repo.worktree, 'commit', '-q', '--allow-empty', '-m', 'after the merge');

    expect(report(repo, fakeTools({ prs: [pr(merged)] }))).not.toContain('merged');
  });

  it('does not count a pull request merged into another branch', () => {
    const repo = repoWithWorktree({ work: 'ahead', origin: GITHUB });
    const tools = fakeTools({ prs: [pr(repo.tip(), { base: 'release' })] });

    expect(report(repo, tools)).not.toContain('merged');
  });

  it('says so when neither GitHub nor git can tell what was merged', () => {
    const repo = repoWithWorktree({ main: 'trunk', origin: 'https://gitlab.com/acme/widgets.git' });
    const tools = fakeTools({ prs: [] });
    const out = report(repo, tools);

    expect(out).toContain('could not tell which');
    expect(out).not.toContain('was merged');
    // Not a GitHub origin: gh is not asked, and its silence is no answer.
    expect(tools.ghCalls()).not.toContain('merged');
  });

  it('says nothing when the branch was not merged', () => {
    const repo = repoWithWorktree({ work: 'ahead', origin: GITHUB });
    const out = report(repo, fakeTools({ prs: [pr(repo.tip(), { head: 'bd-other' })] }));

    expect(out).not.toContain('merged');
    expect(out).not.toContain('could not tell');
  });

  // git lists a branch with no commits of its own as merged: it sits on main's
  // history too. The advice would be to remove a worktree in use.
  it('does not take a worktree nobody has committed in yet for a merged one', () => {
    const repo = repoWithWorktree({ work: 'fresh', origin: GITHUB });

    expect(report(repo, fakeTools({ prs: [pr(repo.tip())] }))).not.toContain('merged');
  });

  it('not even once main moved on and the fresh branch caught up with it', () => {
    const repo = repoWithWorktree({ work: 'fresh' });
    git(repo.dir, 'commit', '-q', '--allow-empty', '-m', 'someone else');
    git(repo.worktree, 'merge', '-q', '--ff-only', 'main');

    expect(report(repo)).not.toContain('merged');
  });

  it('not after a commit was undone and its changes left uncommitted', () => {
    const repo = repoWithWorktree({ work: 'fresh' });
    fs.writeFileSync(path.join(repo.worktree, 'notes.txt'), 'unsaved');
    git(repo.worktree, 'add', 'notes.txt');
    git(repo.worktree, 'commit', '-q', '-m', 'notes');
    git(repo.worktree, 'reset', '-q', 'HEAD~1');
    const out = report(repo);

    expect(out).not.toContain('merged');
    expect(out).not.toContain(REMOVE);
  });

  it('not after the branch was reset to main and its work thrown away', () => {
    const repo = repoWithWorktree({ work: 'ahead' });
    git(repo.worktree, 'reset', '-q', '--hard', 'main');

    expect(report(repo)).not.toContain('merged');
  });

  it('does not ask about merges when there is no bd-* worktree', () => {
    const dir = project();
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', GITHUB);
    fs.mkdirSync(path.join(dir, '.worktrees'));
    const tools = fakeTools({ prs: [] });
    const out = runHook(dir, tools.env).stdout;

    // The fake was reached (the open pull requests), just not about merges.
    expect(tools.ghCalls()).toContain('--state open');
    expect(tools.ghCalls()).not.toContain('merged');
    expect(out).not.toContain('could not tell');
  });
});

// Whatever the merge check gets wrong, the cleanup line must not delete work.
describe('session-start on cleaning up a merged worktree', SLOW, () => {
  const expectNoRemoval = (out) => {
    expect(out).toContain('branch bd-x was merged');
    expect(out).toContain('by hand');
    expect(out).not.toContain(REMOVE);
  };

  it('does not suggest removing a worktree with uncommitted work', () => {
    const repo = repoWithWorktree();
    fs.writeFileSync(path.join(repo.worktree, 'notes.txt'), 'unsaved');
    const out = report(repo);

    expectNoRemoval(out);
    expect(out).toContain('uncommitted work');
  });

  // Under this setting plain `git worktree remove` deletes the file as well.
  it('sees an untracked file where git status is told to hide them', () => {
    const repo = repoWithWorktree();
    git(repo.dir, 'config', 'status.showUntrackedFiles', 'no');
    fs.writeFileSync(path.join(repo.worktree, 'notes.txt'), 'unsaved');

    expectNoRemoval(report(repo));
  });

  it.each(['--skip-worktree', '--assume-unchanged'])(
    'sees a change git status skips, in a file marked %s', (flag) => {
      const repo = repoWithWorktree();
      git(repo.worktree, 'update-index', flag, 'work.txt');
      fs.appendFileSync(path.join(repo.worktree, 'work.txt'), 'unsaved\n');

      expectNoRemoval(report(repo));
    });

  it('sees a change inside a submodule marked ignore = all', () => {
    const library = project();
    git(library, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(library, 'lib.txt'), 'v1\n');
    git(library, 'add', 'lib.txt');
    git(library, 'commit', '-q', '-m', 'lib');
    const repo = repoWithWorktree({ work: 'fresh' });
    git(repo.worktree, 'submodule', '-q', 'add', library, 'lib');
    git(repo.worktree, 'config', '-f', '.gitmodules', 'submodule.lib.ignore', 'all');
    git(repo.worktree, 'add', '.gitmodules');
    git(repo.worktree, 'commit', '-q', '-m', 'add lib');
    git(repo.dir, 'merge', '-q', '--no-ff', '-m', 'merge bd-x', 'bd-x');
    fs.appendFileSync(path.join(repo.worktree, 'lib', 'lib.txt'), 'unsaved\n');

    expectNoRemoval(report(repo));
  });

  it('does not suggest removing a worktree whose directory is gone', () => {
    const repo = repoWithWorktree();
    fs.rmSync(repo.worktree, { recursive: true, force: true });

    expectNoRemoval(report(repo));
  });

  // Without it, git -C climbs to the main checkout and reads that instead.
  it('does not suggest removing a worktree that lost its .git file', () => {
    const repo = repoWithWorktree();
    fs.rmSync(path.join(repo.worktree, '.git'));

    expectNoRemoval(report(repo));
  });

  // `bd worktree create` run inside a worktree nests the new one there, and
  // .worktrees/ is ignored, so the outer one still reads clean.
  it('does not suggest removing a worktree that holds another worktree', () => {
    const repo = repoWithWorktree();
    const inner = addWorktree(repo.worktree, 'bd-y', 'ahead');
    fs.writeFileSync(path.join(inner, 'notes.txt'), 'unsaved');
    const out = report(repo);

    expectNoRemoval(out);
    expect(out).toContain('another worktree');
  });

  // A locked worktree refuses removal, and && would skip the prune.
  it('says a locked worktree is locked instead of a command that fails', () => {
    const repo = repoWithWorktree();
    git(repo.dir, 'worktree', 'lock', repo.worktree);
    const out = report(repo);

    expect(out).toContain('locked');
    expect(out).not.toContain(REMOVE);
  });

  it('says a branch without a reflog only looks merged, and suggests nothing', () => {
    const repo = repoWithWorktree();
    fs.rmSync(path.join(repo.dir, '.git', 'logs', 'refs', 'heads', 'bd-x'));
    const out = report(repo);

    expect(out).toContain('branch bd-x looks merged');
    expect(out).not.toContain('was merged');
    expect(out).not.toContain(REMOVE);
  });
});

describe('session-start on the bead behind a merged worktree', SLOW, () => {
  const withBeads = (repo, beads) => report(repo, fakeTools({ beads }));

  it('names the bead and its status when bd knows that exact id', () => {
    const repo = repoWithWorktree({ branch: 'bd-app-7' });
    const out = withBeads(repo, [{ id: 'app-7', status: 'in_progress' }]);

    expect(out).toContain('app-7 is still in_progress');
    expect(out).toContain('bd close "app-7"');
  });

  // bd show 219 finds app-219, which does not make it the bead of bd-219.
  it('takes nothing from a partial match', () => {
    const repo = repoWithWorktree({ branch: 'bd-219' });
    const out = withBeads(repo, [{ id: 'app-219', status: 'open' }]);

    expect(out).toContain('branch bd-219 was merged');
    expect(out).not.toContain('app-219');
    expect(out).not.toContain('bd close');
    expect(out).toContain('look the bead up');
  });

  // A branch name may hold what no bead id does. bd is not asked about it —
  // and the other worktrees keep their answer, which on Windows they lost:
  // a call through cmd.exe with such an argument is not made at all.
  it('asks bd only about names a bead id can have', () => {
    const repo = repoWithWorktree({ branch: 'bd-app-7' });
    addWorktree(repo.dir, 'bd-app-8%x', 'merged');
    const tools = fakeTools({ beads: [{ id: 'app-7', status: 'in_progress' }] });
    const out = report(repo, tools);

    expect(out).toContain('app-7 is still in_progress');
    expect(out).toContain('branch bd-app-8%x was merged');
    expect(tools.bdCalls()).toContain('show');
    expect(tools.bdCalls()).not.toContain('app-8');
  });

  // bd takes its prefix from the directory name, which need not be English.
  it('asks about an id in any alphabet', () => {
    const repo = repoWithWorktree({ branch: 'bd-проект-7' });
    const out = withBeads(repo, [{ id: 'проект-7', status: 'open' }]);

    expect(out).toContain('проект-7 is still open');
  });

  it('names no bead when bd does not answer', () => {
    const repo = repoWithWorktree();
    const out = withBeads(repo, []);

    expect(out).toContain('branch bd-x was merged');
    expect(out).not.toContain('bd close');
    expect(out).not.toMatch(/bead \S+ is still/);
    expect(out).toContain('look the bead up');
  });

  it('asks nothing more of a bead that is already closed', () => {
    const repo = repoWithWorktree();
    const out = withBeads(repo, [{ id: 'x', status: 'closed' }]);

    expect(out).toContain('branch bd-x was merged');
    expect(out).not.toContain('bd close');
    expect(out).not.toContain('look the bead up');
  });
});

// ---------------------------------------------------------------------------
// Open pull requests
// ---------------------------------------------------------------------------

describe('session-start on open pull requests', SLOW, () => {
  const repoWithOrigin = (origin) => {
    const dir = project();
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', origin);
    return dir;
  };
  const openPrs = [{ number: 12, title: 'Fix the thing', headRefName: 'bd-x' }];

  // Without --repo, gh with no default repository answers about the fork's
  // parent: an empty list, exit 0 — indistinguishable from "none open".
  it('asks GitHub about the open pull requests of origin by name', () => {
    const tools = fakeTools({ openPrs });
    const out = runHook(repoWithOrigin(GITHUB), tools.env).stdout;

    const asked = tools.ghCalls().split('\n').filter(call => call.includes('open'));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('--repo acme/widgets');
    expect(out).toContain('#12 Fix the thing (bd-x)');
  });

  it('does not ask when origin is not on GitHub', () => {
    const tools = fakeTools({ openPrs });
    const out = runHook(repoWithOrigin('https://gitlab.com/acme/widgets.git'), tools.env).stdout;

    expect(tools.ghCalls()).not.toContain('open');
    expect(out).not.toContain('open PRs');
  });
});

// ---------------------------------------------------------------------------
// Task lists
// ---------------------------------------------------------------------------
// `bd prime` prints memories and a command reference, not the beads: these
// lists are the only picture of unfinished work a session starts with.

/** A bead as `bd ... --json` prints it. */
const bead = (id, fields = {}) => ({
  id,
  title: `Title of ${id}`,
  description: `What ${id} is about.`,
  status: 'open',
  priority: 2,
  issue_type: 'task',
  owner: 'someone@example.com',
  created_at: '2026-09-01T10:00:00Z',
  created_by: 'someone',
  updated_at: '2026-09-01T10:00:00Z',
  ...fields,
});

const NO_BEADS = 'No beads in progress, ready, blocked or stale';

describe('session-start on the task lists', SLOW, () => {
  const run = (lists) => {
    const tools = fakeTools({ lists });
    return { out: runHook(project(), tools.env).stdout, tools };
  };

  it('prints the first few beads of each list, and how many more there are', () => {
    const { out, tools } = run({
      in_progress: [bead('app-w1', { status: 'in_progress', priority: 1 })],
      ready: [1, 2, 3, 4, 5, 6, 7].map(n => bead(`app-r${n}`)),
      blocked: [bead('app-b1', { status: 'blocked', blocked_by_count: 1, blocked_by: ['app-w1'] })],
      stale: [bead('app-s1', { status: 'in_progress' })],
    });

    expect(out).toContain('## Task Status');
    expect(out).toMatch(/In Progress[^\n]*\n {2}app-w1 \[P1\] Title of app-w1\n/);
    expect(out).toContain('app-r5');
    expect(out).not.toContain('app-r6');
    expect(out).toContain('2 more: bd ready');
    expect(out).toMatch(/app-b1 \[P2\] Title of app-b1 .*blocked by app-w1/);
    expect(out).toMatch(/app-s1 \[P2\] Title of app-s1 .*in_progress/);
    expect(out).not.toContain(NO_BEADS);
    expect(out).not.toContain('WARNING');

    const calls = tools.bdCalls();
    expect(calls).toMatch(/^list --status in_progress .*--json$/m);
    expect(calls).toMatch(/^ready .*--json$/m);
    expect(calls).toMatch(/^blocked .*--json$/m);
    expect(calls).toMatch(/^stale --days 3 .*--json$/m);
  });

  it('says there are no beads when bd answers every list with an empty one', () => {
    const { out } = run({ in_progress: [], ready: [], blocked: [], stale: [] });

    expect(out).toContain(NO_BEADS);
    expect(out).not.toContain('WARNING');
  });

  // Silence from bd used to read exactly like an empty board.
  it('says out loud that bd answered nothing, instead of reporting no beads', () => {
    const { out } = run({});

    expect(out).toContain('WARNING: bd answered none of the task-list queries');
    expect(out).not.toContain(NO_BEADS);
  });

  it('prints the lists bd answered, and names the one it did not', () => {
    const { out } = run({
      in_progress: [bead('app-w1', { status: 'in_progress' })],
      ready: [],
      stale: [],
    });

    expect(out).toContain('app-w1');
    expect(out).toContain('WARNING: bd did not answer for the Blocked list');
    expect(out).not.toContain('answered none');
    expect(out).not.toContain(NO_BEADS);
  });

  it('waits for a slow list while the others have answered', () => {
    const { out } = run({
      in_progress: [bead('app-w1', { status: 'in_progress' })],
      ready: [bead('app-r1')],
      blocked: { after: 3000, beads: [bead('app-b1', { blocked_by: ['app-w1'] })] },
      stale: [],
    });

    expect(out).toContain('app-w1');
    expect(out).toContain('app-r1');
    expect(out).toContain('app-b1');
    expect(out).not.toContain('WARNING');
  });

  // Warm, each call takes up to a few seconds; one after another they added up.
  it('asks bd for all four lists at once', () => {
    const late = (beads) => ({ after: 2500, beads });
    const started = Date.now();
    const { out } = run({
      in_progress: late([bead('app-w1', { status: 'in_progress' })]),
      ready: late([bead('app-r1')]),
      blocked: late([]),
      stale: late([]),
    });

    expect(out).toContain('app-w1');
    expect(out).toContain('app-r1');
    // One after another the fake alone would take 10 s.
    expect(Date.now() - started).toBeLessThan(8000);
  });
});

describe('session-start on a project without beads', () => {
  const withoutBeads = () => {
    const dir = project();
    fs.rmSync(path.join(dir, '.beads'), { recursive: true });
    return dir;
  };

  it('asks for bd init, and says nothing else', () => {
    const result = runHook(withoutBeads());

    expect(result.stdout).toBe("No .beads directory found. Run 'bd init' to initialize.\n");
    expect(result.status).toBe(0);
  });

  it('keeps quiet as a plugin, which runs in projects that never chose beads', () => {
    const result = runHook(withoutBeads(), { CLAUDE_PLUGIN_ROOT: path.join(os.tmpdir(), 'pretend-plugin') });

    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });
});
