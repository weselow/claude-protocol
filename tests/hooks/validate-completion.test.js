import { describe, it, expect, vi } from 'vitest';
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

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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
  commitFile(dir, 'README.md', 'project\n');
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

function runHook(dir, fields = {}) {
  const input = {
    hook_event_name: 'SubagentStop',
    agent_type: 'general-purpose',
    permission_mode: 'default',
    stop_hook_active: false,
    last_assistant_message: report(),
    ...fields,
  };
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    cwd: dir,
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...GIT_ENV,
      CLAUDE_PROJECT_DIR: dir,
      CLAUDE_PLUGIN_ROOT: '',
      CLAUDE_CONFIG_DIR: tmp('validate-completion-claude-'),
    },
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

  it('blocks a directory that is not a git worktree', () => {
    const { dir } = shared();
    const plain = tmp('validate-completion-plain-');
    const decision = runHook(dir, { last_assistant_message: report({ worktree: plain }) });
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('not a git worktree');
    expect(decision.reason).toContain(plain);
  });

  it('blocks on uncommitted changes and names the file', () => {
    const { dir, worktree } = project();
    fs.writeFileSync(path.join(worktree, 'forgotten.txt'), 'not committed\n');
    const decision = runHook(dir);
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('forgotten.txt');
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
