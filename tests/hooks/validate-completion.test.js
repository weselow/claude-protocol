import { describe, it, expect, vi, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOOK_PATH = path.resolve(__dirname, '../../templates/hooks/validate-completion.cjs');

// Every test builds real repositories, a dozen git processes each. On a busy
// Windows machine one of them took 17s, past the suite's 15s default.
vi.setConfig({ testTimeout: 60000 });

// The bead id and the worktree name differ on purpose: projects with an id
// prefix name the worktree after the number alone, and building the path from
// the id is what made most of the old hook's alarms false.
const BEAD_ID = 'bd_1c-oko-219';
const BRANCH = 'bd-219';
const WORKTREE = `.worktrees/${BRANCH}`;

// Every directory a test makes, removed when the file is done: each test
// builds real repositories, and hundreds of them were once left behind.
const made = [];
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/**
 * Git that knows nothing of the machine it runs on: no global or system
 * config, so a signing key, a hooks path or an autocrlf setting of the person
 * running the tests cannot change what a commit does.
 */
const EMPTY_CONFIG = path.join(tmp('validate-completion-cfg-'), 'gitconfig');
fs.writeFileSync(EMPTY_CONFIG, '');
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: EMPTY_CONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function commitFile(cwd, name, text) {
  fs.writeFileSync(path.join(cwd, name), text);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-q', '-m', `add ${name}`);
}

/**
 * A project with beads, a bare repository as its origin, and a worktree on the
 * bead branch holding one commit — pushed unless asked otherwise.
 */
function project({ origin = true, pushed = true, beads = true } = {}) {
  const root = tmp('validate-completion-');
  const dir = path.join(root, 'project');
  fs.mkdirSync(dir);
  if (beads) fs.mkdirSync(path.join(dir, '.beads'));
  git(dir, 'init', '-q', '-b', 'main');
  commitFile(dir, '.gitignore', '.worktrees/\n');
  fs.mkdirSync(path.join(dir, 'src'));
  commitFile(dir, 'src/a.js', 'a\n');
  if (origin) {
    git(root, 'init', '-q', '--bare', 'origin.git');
    git(dir, 'remote', 'add', 'origin', path.join(root, 'origin.git'));
    git(dir, 'push', '-q', 'origin', 'main');
  }
  git(dir, 'worktree', 'add', '-q', '-b', BRANCH, WORKTREE);
  const worktree = path.join(dir, WORKTREE);
  commitFile(worktree, 'work.txt', 'done\n');
  if (origin && pushed) git(worktree, 'push', '-q', 'origin', BRANCH);
  return { root, dir, worktree };
}

/** One project for the tests that only read it — building one is most of the run time. */
let sharedProject = null;
function shared() {
  sharedProject = sharedProject || project();
  return sharedProject;
}

function report({ worktree = WORKTREE, checklist = '- [x] the requirement' } = {}) {
  const lines = [`BEAD ${BEAD_ID} COMPLETE`];
  if (worktree !== null) lines.push(`Worktree: ${worktree}`);
  if (checklist !== null) lines.push('Checklist:', checklist);
  lines.push('Files: work.txt', 'Tests: pass', 'Summary: did the work');
  return lines.join('\n');
}

/**
 * PATH holding a git that predates --path-format (2.31). Such a git does not
 * fail on the flag: rev-parse prints it back and exits 0 ('echo'). The 'fail'
 * mode exits non-zero instead, for a git that breaks some other way.
 * Everything else goes to the real git. On Windows the wrapper is a .cmd, so
 * the real git must not be on PATH at all, or it would be found first.
 */
function oldGitPath(mode) {
  const dir = tmp('validate-completion-oldgit-');
  const win = process.platform === 'win32';
  const real = spawnSync(win ? 'where' : 'which', ['git'], { encoding: 'utf8' }).stdout
    .split(/\r?\n/).map(line => line.trim()).find(line => line && (!win || /\.exe$/i.test(line)));
  const shim = path.join(dir, 'old-git.js');
  fs.writeFileSync(shim, [
    "const { spawnSync } = require('child_process');",
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    "const at = args.indexOf('--path-format=absolute');",
    'if (at >= 0) {',
    `  if (${JSON.stringify(mode)} === 'fail') process.exit(129);`,
    "  fs.writeSync(1, args[at] + '\\n');",
    '  args.splice(at, 1);',
    '}',
    `const r = spawnSync(${JSON.stringify(real)}, args, { stdio: 'inherit' });`,
    'process.exit(r.status === null ? 1 : r.status);',
  ].join('\n'));
  const run = `"${process.execPath}" "${shim}"`;
  if (win) {
    fs.writeFileSync(path.join(dir, 'git.cmd'), `@${run} %*\r\n`);
    return [dir, path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(path.delimiter);
  }
  const script = path.join(dir, 'git');
  fs.writeFileSync(script, `#!/bin/sh\nexec ${run} "$@"\n`);
  fs.chmodSync(script, 0o755);
  return `${dir}${path.delimiter}${process.env.PATH}`;
}

function runHook(dir, fields = {}, extraEnv = {}) {
  const input = {
    hook_event_name: 'SubagentStop',
    agent_type: 'general-purpose',
    permission_mode: 'default',
    stop_hook_active: false,
    last_assistant_message: report(),
    ...fields,
  };
  const env = {
    ...GIT_ENV,
    CLAUDE_PROJECT_DIR: dir,
    CLAUDE_PLUGIN_ROOT: '',
    CLAUDE_CONFIG_DIR: tmp('validate-completion-claude-'),
  };
  // Windows spells it Path; two spellings in one environment is a coin toss.
  if (extraEnv.PATH) for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key];
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    cwd: dir,
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 30000,
    env: { ...env, ...extraEnv },
  });
  return JSON.parse(result.stdout);
}

const APPROVE = { decision: 'approve' };

describe('validate-completion: when it stays out of the way', () => {
  it('approves anything in a project without .beads', () => {
    const { dir } = project({ beads: false });
    const decision = runHook(dir, { last_assistant_message: report({ checklist: '- [ ] not done' }) });
    expect(decision).toEqual(APPROVE);
  });

  it('approves a message that is not a completion report', () => {
    const { dir } = shared();
    expect(runHook(dir, { last_assistant_message: 'ok' })).toEqual(APPROVE);
  });

  it('approves a message that only quotes the report marker', () => {
    const { dir } = shared();
    const message = `Review: the subagent said "BEAD ${BEAD_ID} COMPLETE" too early.\n` +
      'Worktree: .worktrees/bd-999\nChecklist:\n- [ ] ask for a second pass';
    expect(runHook(dir, { last_assistant_message: message })).toEqual(APPROVE);
  });

  it.each([
    ['a placeholder id', 'BEAD {BEAD_ID} COMPLETE'],
    ['an id in angle brackets', 'BEAD <id> COMPLETE'],
  ])('approves a message quoting the report template with %s', (_, marker) => {
    const { dir } = shared();
    const message = ['Subagents must end with:', '```', marker, 'Worktree: .worktrees/bd-{BEAD_ID}',
      'Checklist:', '- [ ] requirement 1', '```'].join('\n');
    expect(runHook(dir, { last_assistant_message: message })).toEqual(APPROVE);
  });

  it('approves when the message is missing or empty', () => {
    const { dir } = shared();
    expect(runHook(dir, { last_assistant_message: undefined })).toEqual(APPROVE);
    expect(runHook(dir, { last_assistant_message: '' })).toEqual(APPROVE);
  });

  it('approves once it has already sent the subagent back', () => {
    const { dir } = shared();
    const decision = runHook(dir, {
      stop_hook_active: true,
      last_assistant_message: report({ checklist: '- [ ] not done' }),
    });
    expect(decision).toEqual(APPROVE);
  });
});

describe('validate-completion: the checklist', () => {
  it('blocks a report without Checklist:', () => {
    const { dir } = shared();
    const decision = runHook(dir, { last_assistant_message: report({ checklist: null }) });
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('Checklist:');
    expect(decision.reason).toContain(`bd show ${BEAD_ID}`);
  });

  it('blocks a report with an unchecked item', () => {
    const { dir } = shared();
    const checklist = '- [x] first\n- [ ] second';
    const decision = runHook(dir, { last_assistant_message: report({ checklist }) });
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('1 unchecked');
  });

  it('counts only lines that are unchecked items, not a mention of one', () => {
    const { dir } = shared();
    const checklist = '- [x] the hook blocks on `- [ ]` items\n  - [x] nested and ticked';
    expect(runHook(dir, { last_assistant_message: report({ checklist }) })).toEqual(APPROVE);
  });

  it('counts an indented unchecked item', () => {
    const { dir } = shared();
    const checklist = '- [x] first\n   - [ ] nested and open';
    const decision = runHook(dir, { last_assistant_message: report({ checklist }) });
    expect(decision.reason).toContain('1 unchecked');
  });

  it.each([
    ['a star', '* [ ] open'],
    ['a plus', '+ [ ] open'],
    ['a number', '1. [x] done\n2. [ ] open'],
  ])('counts an unchecked item marked with %s', (_, checklist) => {
    const { dir } = shared();
    const decision = runHook(dir, { last_assistant_message: report({ checklist }) });
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('1 unchecked');
  });

  it('ignores an open item outside the Checklist', () => {
    const { dir } = shared();
    const message = `${report()}\nFound along the way:\n- [ ] something for later`;
    expect(runHook(dir, { last_assistant_message: message })).toEqual(APPROVE);
  });

  it('blocks an empty Checklist', () => {
    const { dir } = shared();
    const decision = runHook(dir, { last_assistant_message: report({ checklist: '' }) });
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('no items');
  });

  it('reads past a bold sub-heading to a later open item', () => {
    const { dir } = shared();
    const checklist = '- [x] hooks\n**Docs**\n- [ ] README';
    const decision = runHook(dir, { last_assistant_message: report({ checklist }) });
    expect(decision.reason).toContain('1 unchecked');
  });

  it('reads past wrapped text to a later open item', () => {
    const { dir } = shared();
    const checklist = '- [x] a long requirement that\nwraps here: and goes on\n- [ ] b';
    const decision = runHook(dir, { last_assistant_message: report({ checklist }) });
    expect(decision.reason).toContain('1 unchecked');
  });

  it('accepts sub-headings around the items', () => {
    const { dir } = shared();
    const checklist = '**Hooks**\n- [x] a\n**Docs:**\n- [x] b';
    expect(runHook(dir, { last_assistant_message: report({ checklist }) })).toEqual(APPROVE);
  });

  it('ends the checklist at a report label even with nothing after its colon', () => {
    const { dir } = shared();
    const message = [`BEAD ${BEAD_ID} COMPLETE`, `Worktree: ${WORKTREE}`, 'Checklist:', '- [x] a',
      'Files:', '- work.txt', 'Found along the way:', '- [ ] follow-up'].join('\n');
    expect(runHook(dir, { last_assistant_message: message })).toEqual(APPROVE);
  });

  it('ends the checklist at a closing code fence', () => {
    const { dir } = shared();
    const message = ['```', `BEAD ${BEAD_ID} COMPLETE`, `Worktree: ${WORKTREE}`, 'Checklist:',
      '- [x] a', '```', '', '- [ ] an idea for later'].join('\n');
    expect(runHook(dir, { last_assistant_message: message })).toEqual(APPROVE);
  });

  it('counts emoji ticks as ticked', () => {
    const { dir } = shared();
    const checklist = '- [✅] a\n- [✔️] b\n- [✔] c\n- ✅ d';
    expect(runHook(dir, { last_assistant_message: report({ checklist }) })).toEqual(APPROVE);
  });

  it('does not let an emoji tick hide a later open item', () => {
    const { dir } = shared();
    const checklist = '- [x] a\n- [✔️] b\n- [ ] c';
    const decision = runHook(dir, { last_assistant_message: report({ checklist }) });
    expect(decision.reason).toContain('1 unchecked');
  });

  it.each([
    ['inline code', (m) => m.replace(/^(BEAD .*)$/m, '`$1`')],
    ['an emoji heading', (m) => `## ✅ ${m}`],
    ['a blockquote', (m) => m.split('\n').map(line => `> ${line}`).join('\n')],
  ])('reads a report whose marker is in %s', (_, dress) => {
    const { dir } = shared();
    const message = dress(report({ checklist: '- [ ] not done' }));
    const decision = runHook(dir, { last_assistant_message: message });
    expect(decision.reason).toContain('1 unchecked');
  });

  it.each([
    ['in backticks', 'BEAD `ID` COMPLETE'],
    ['in bold', 'BEAD **ID** COMPLETE'],
    ['followed by a dash', 'BEAD ID — COMPLETE'],
    ['after a colon', 'BEAD: ID COMPLETE'],
  ])('reads a report whose id is %s', (_, marker) => {
    const { dir } = shared();
    const message = report({ checklist: '- [ ] not done' })
      .replace(`BEAD ${BEAD_ID} COMPLETE`, marker.replace('ID', BEAD_ID));
    const decision = runHook(dir, { last_assistant_message: message });
    expect(decision.reason).toContain('1 unchecked');
  });

  it('counts a box with two spaces as unchecked', () => {
    const { dir } = shared();
    const decision = runHook(dir, { last_assistant_message: report({ checklist: '- [x] a\n- [  ] b' }) });
    expect(decision.reason).toContain('1 unchecked');
  });

  it('reads a report under a heading or in bold', () => {
    const { dir } = shared();
    const open = report({ checklist: '- [ ] not done' });
    for (const prefix of ['## ', '**']) {
      const decision = runHook(dir, { last_assistant_message: prefix + open });
      expect(decision.decision).toBe('block');
    }
  });

  it('checks the checklist before the worktree', () => {
    const { dir } = shared();
    const decision = runHook(dir, {
      last_assistant_message: report({ checklist: null, worktree: '.worktrees/bd-999' }),
    });
    expect(decision.reason).toContain('Checklist:');
  });

  it('checks a report whatever the agent type', () => {
    const { dir } = shared();
    const decision = runHook(dir, {
      agent_type: 'worker',
      last_assistant_message: report({ checklist: '- [ ] not done' }),
    });
    expect(decision.decision).toBe('block');
  });

  it('blocks in bypassPermissions mode too, with nothing but the decision on stdout', () => {
    const { dir } = shared();
    const decision = runHook(dir, {
      permission_mode: 'bypassPermissions',
      last_assistant_message: report({ checklist: '- [ ] not done' }),
    });
    expect(decision.decision).toBe('block');
  });
});

describe('validate-completion: the worktree', () => {
  it('blocks a report without a Worktree: line', () => {
    const { dir } = shared();
    const decision = runHook(dir, { last_assistant_message: report({ worktree: null }) });
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('Worktree:');
  });

  it('blocks when the named worktree does not exist, and names the path it looked at', () => {
    const { dir } = shared();
    const decision = runHook(dir, {
      last_assistant_message: report({ worktree: '.worktrees/bd-999' }),
    });
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain(path.join(dir, '.worktrees', 'bd-999'));
  });

  it('takes the path from backticks', () => {
    const { dir } = shared();
    const decision = runHook(dir, { last_assistant_message: report({ worktree: `\`${WORKTREE}\`` }) });
    expect(decision).toEqual(APPROVE);
  });

  it('takes the path from a bold label', () => {
    const { dir } = shared();
    const message = report().replace('Worktree:', '**Worktree:**');
    expect(runHook(dir, { last_assistant_message: message })).toEqual(APPROVE);
  });

  it('takes an absolute path in quotes', () => {
    const { dir, worktree } = shared();
    const decision = runHook(dir, { last_assistant_message: report({ worktree: `"${worktree}"` }) });
    expect(decision).toEqual(APPROVE);
  });

  it.each([
    ['a note after the path', `${WORKTREE} (branch ${BRANCH})`],
    ['a note after backticks', `\`${WORKTREE}\` — pushed`],
    ['a full stop', `${WORKTREE}.`],
    ['a markdown link', `[${WORKTREE}](${WORKTREE})`],
  ])('takes the path from a line with %s', (_, worktree) => {
    const { dir } = shared();
    expect(runHook(dir, { last_assistant_message: report({ worktree }) })).toEqual(APPROVE);
  });

  it('takes the path from a label bold up to the colon', () => {
    const { dir } = shared();
    const message = report().replace('Worktree:', '**Worktree**:');
    expect(runHook(dir, { last_assistant_message: message })).toEqual(APPROVE);
  });

  it('takes the path from the line after the label', () => {
    const { dir } = shared();
    const message = report().replace(`Worktree: ${WORKTREE}`, `Worktree:\n  ${WORKTREE}`);
    expect(runHook(dir, { last_assistant_message: message })).toEqual(APPROVE);
  });

  it.runIf(process.platform === 'win32')('takes a Git Bash path on Windows', () => {
    const { dir, worktree } = shared();
    const bash = worktree.replace(/^([A-Za-z]):\\/, (_, d) => `/${d.toLowerCase()}/`)
      .replace(/\\/g, '/');
    expect(runHook(dir, { last_assistant_message: report({ worktree: bash }) })).toEqual(APPROVE);
  });

  it('takes the path at the start of the line, not a quoted one after it', () => {
    const { dir, worktree } = project();
    fs.writeFileSync(path.join(worktree, 'forgotten.txt'), 'not committed\n');
    const decision = runHook(dir, {
      last_assistant_message: report({ worktree: `${WORKTREE} (only touched \`src/\`)` }),
    });
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('forgotten.txt');
  });

  it('takes a path line with a quoted branch after it', () => {
    const { dir } = shared();
    const worktree = `${WORKTREE} — pushed to \`origin/${BRANCH}\``;
    expect(runHook(dir, { last_assistant_message: report({ worktree }) })).toEqual(APPROVE);
  });

  it('finds the Worktree: line above the marker', () => {
    const { dir } = shared();
    const message = [`Worktree: ${WORKTREE}`, `BEAD ${BEAD_ID} COMPLETE`, 'Checklist:', '- [x] a'].join('\n');
    expect(runHook(dir, { last_assistant_message: message })).toEqual(APPROVE);
  });

  it('takes a "Worktree path:" label', () => {
    const { dir } = shared();
    const message = report().replace('Worktree:', 'Worktree path:');
    expect(runHook(dir, { last_assistant_message: message })).toEqual(APPROVE);
  });

  it.each([
    ['a plain directory inside the main checkout', '.worktrees/bd-stale', 'not the top'],
    ['a subdirectory of the main checkout', 'src', 'not the top'],
    ['a subdirectory of the worktree', `${WORKTREE}/src`, 'not the top'],
    ['the main checkout itself', '.', 'main checkout'],
  ])('blocks %s', (_, worktree, why) => {
    const { dir } = shared();
    fs.mkdirSync(path.join(dir, '.worktrees', 'bd-stale'), { recursive: true });
    const decision = runHook(dir, { last_assistant_message: report({ worktree }) });
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain(why);
    expect(decision.reason).toContain(path.resolve(dir, worktree));
  });

  it('blocks a directory that is not a git worktree', () => {
    const { dir } = shared();
    const plain = tmp('validate-completion-plain-');
    const decision = runHook(dir, { last_assistant_message: report({ worktree: plain }) });
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('not a git worktree');
    expect(decision.reason).toContain(plain);
  });

  it('sees an untracked file even where the config hides untracked files', () => {
    const { dir, worktree } = project();
    git(dir, 'config', 'status.showUntrackedFiles', 'no');
    fs.writeFileSync(path.join(worktree, 'hidden.txt'), 'untracked\n');
    const decision = runHook(dir);
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('hidden.txt');
  });

  it('blocks when the worktree status cannot be read', () => {
    const { dir, worktree } = project();
    const gitDir = git(worktree, 'rev-parse', '--absolute-git-dir');
    fs.writeFileSync(path.join(gitDir, 'index'), 'not an index');
    const decision = runHook(dir);
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('could not read');
    expect(decision.reason).toContain(worktree);
  });

  it('blocks on uncommitted changes and names the file', () => {
    const { dir, worktree } = project();
    fs.writeFileSync(path.join(worktree, 'forgotten.txt'), 'not committed\n');
    const decision = runHook(dir);
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('forgotten.txt');
  });
});

describe('validate-completion: on a git older than --path-format', () => {
  it.each(['echo', 'fail'])('still blocks the main checkout (%s)', (mode) => {
    const { dir } = shared();
    const decision = runHook(dir, { last_assistant_message: report({ worktree: '.' }) },
      { PATH: oldGitPath(mode) });
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('main checkout');
  });

  it('still approves a linked worktree', () => {
    const { dir } = shared();
    expect(runHook(dir, {}, { PATH: oldGitPath('echo') })).toEqual(APPROVE);
  });
});

describe('validate-completion: the branch on origin', () => {
  it('blocks a branch that was never pushed', () => {
    const { dir } = project({ pushed: false });
    const decision = runHook(dir);
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain(BRANCH);
    expect(decision.reason).toContain('git push');
  });

  it('blocks when the worktree HEAD is ahead of origin', () => {
    const { dir, worktree } = project();
    commitFile(worktree, 'later.txt', 'after the push\n');
    const decision = runHook(dir);
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain(`Branch ${BRANCH} on origin is at`);
    expect(decision.reason).toContain('git push');
  });

  it('blocks when origin has only a longer branch name ending in the same one', () => {
    const { dir, worktree } = project({ pushed: false });
    git(worktree, 'push', '-q', 'origin', `HEAD:refs/heads/foo/${BRANCH}`);
    const decision = runHook(dir);
    expect(decision.reason).toContain(`Branch ${BRANCH} is not on origin`);
  });

  it('is not misled by a longer branch name on origin at another commit', () => {
    const { dir, worktree } = project();
    git(worktree, 'push', '-q', 'origin', `main:refs/heads/foo/${BRANCH}`);
    expect(runHook(dir)).toEqual(APPROVE);
  });

  it('approves a branch that shares its name with a tag', () => {
    const { dir, worktree } = project();
    git(worktree, 'tag', BRANCH);
    expect(runHook(dir)).toEqual(APPROVE);
  });

  it('blocks a worktree on a detached HEAD', () => {
    const { dir, worktree } = project();
    git(worktree, 'checkout', '-q', '--detach');
    const decision = runHook(dir);
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('detached');
  });

  it('approves when origin cannot be reached', () => {
    const { root, dir } = project();
    git(dir, 'remote', 'set-url', 'origin', path.join(root, 'no-such-repo.git'));
    expect(runHook(dir)).toEqual(APPROVE);
  });

  it('approves when there is no origin at all', () => {
    const { dir } = project({ origin: false });
    expect(runHook(dir)).toEqual(APPROVE);
  });

  it('approves a report that matches the facts', () => {
    const { dir } = shared();
    expect(runHook(dir)).toEqual(APPROVE);
  });
});
