import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOOK_PATH = path.resolve(__dirname, '../../templates/hooks/memory-pointer.cjs');

// Every temporary directory made here is removed once the file is done.
const madeHere = [];
afterAll(() => {
  for (const dir of madeHere) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

function tempDir(prefix) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  madeHere.push(dir);
  return dir;
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

/** A git repository with one commit, so a worktree can be made from it. */
function repo() {
  const dir = tempDir('memory-pointer-');
  git(dir, 'init', '-q');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

function withProjectMemory(dir, text = '- [a](a.md) — a fact\n') {
  fs.mkdirSync(path.join(dir, '.memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.memory', 'MEMORY.md'), text);
  return path.join(dir, '.memory', 'MEMORY.md');
}

/** A Claude config folder, with shared memory set up when `choice` is given. */
function configDir({ choice, withIndex = true, indexText = '- shared fact\n' } = {}) {
  const dir = tempDir('memory-pointer-cfg-');
  if (!choice) return { dir };
  const shared = path.join(dir, 'shared-memory');
  fs.mkdirSync(shared, { recursive: true });
  if (withIndex) fs.writeFileSync(path.join(shared, 'MEMORY.md'), indexText);
  fs.writeFileSync(path.join(dir, 'claude-protocol.json'), JSON.stringify({
    shared_memory: choice === 'never' ? { choice } : { choice, path: shared, remote: null },
  }));
  return { dir, index: path.join(shared, 'MEMORY.md') };
}

function runHook(projectDir, config) {
  return spawnSync(process.execPath, [HOOK_PATH], {
    cwd: projectDir,
    input: JSON.stringify({ hook_event_name: 'SubagentStart', agent_type: 'general-purpose' }),
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_PLUGIN_ROOT: '',
      CLAUDE_CONFIG_DIR: config.dir,
    },
  });
}

/** The additionalContext the hook hands the agent, or null when it says nothing. */
function pointer(result) {
  expect(result.status).toBe(0);
  if (result.stdout.trim() === '') return null;
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  expect(output.hookEventName).toBe('SubagentStart');
  return output.additionalContext;
}

describe('memory-pointer (SubagentStart)', () => {
  it('says nothing when there is no memory at all', () => {
    expect(pointer(runHook(repo(), configDir()))).toBeNull();
  });

  it('says nothing when shared memory was declined and the project has none', () => {
    expect(pointer(runHook(repo(), configDir({ choice: 'never' })))).toBeNull();
  });

  it('says nothing when the shared folder has no index yet', () => {
    expect(pointer(runHook(repo(), configDir({ choice: 'local', withIndex: false })))).toBeNull();
  });

  // bootstrap creates the shared MEMORY.md empty: a pointer to it is noise.
  it('says nothing when the shared index is empty', () => {
    expect(pointer(runHook(repo(), configDir({ choice: 'new', indexText: '' })))).toBeNull();
  });

  it('says nothing when the project index holds only whitespace', () => {
    const dir = repo();
    withProjectMemory(dir, ' \r\n\n\t\n');

    expect(pointer(runHook(dir, configDir()))).toBeNull();
  });

  it('points at the project memory alone', () => {
    const dir = repo();
    const index = withProjectMemory(dir);

    const line = pointer(runHook(dir, configDir()));

    expect(line).toContain(index);
    expect(line).not.toMatch(/shared/i);
  });

  it('points at the shared memory alone', () => {
    const config = configDir({ choice: 'local' });

    const line = pointer(runHook(repo(), config));

    expect(line).toContain(config.index);
    expect(line).not.toContain('.memory');
  });

  it('points at both in one short line', () => {
    const dir = repo();
    const index = withProjectMemory(dir);
    const config = configDir({ choice: 'new' });

    const line = pointer(runHook(dir, config));

    expect(line).toContain(index);
    expect(line).toContain(config.index);
    expect(line).not.toContain('\n');
    // ~200 characters of text around two paths of whatever length.
    expect(line.length - index.length - config.index.length).toBeLessThan(200);
  });

  it('from a worktree, points at the main checkout\'s .memory', () => {
    const main = repo();
    const index = withProjectMemory(main);
    const worktree = path.join(main, '.worktrees', 'bd-x');
    git(main, 'worktree', 'add', '-q', '-b', 'bd-x', worktree);

    const line = pointer(runHook(worktree, configDir()));

    expect(line).toContain(index);
  });

  it('outside git, points at the folder\'s own .memory', () => {
    const dir = tempDir('memory-pointer-nogit-');
    withProjectMemory(dir);

    // Not a repository: no main checkout to resolve, but the folder itself
    // is still the project.
    const line = pointer(runHook(dir, configDir()));

    expect(line).toContain(path.join(dir, '.memory', 'MEMORY.md'));
  });

  it('survives an unreadable shared-memory state file', () => {
    const config = configDir();
    fs.writeFileSync(path.join(config.dir, 'claude-protocol.json'), '{ not json');

    expect(pointer(runHook(repo(), config))).toBeNull();
  });
});
