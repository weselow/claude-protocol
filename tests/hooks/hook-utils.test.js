import { describe, it, expect, afterAll } from 'vitest';

// hook-utils.cjs exports pure functions we can test directly
const {
  getField,
  parseBeadId,
  parseEpicId,
  containsPathSegment,
} = require('../../templates/hooks/hook-utils.cjs');

describe('getField', () => {
  it('returns nested value via dot path', () => {
    const obj = { tool_input: { command: 'git status' } };
    expect(getField(obj, 'tool_input.command')).toBe('git status');
  });

  it('returns empty string for missing path', () => {
    expect(getField({ a: 1 }, 'a.b.c')).toBe('');
  });

  it('returns empty string for null input', () => {
    expect(getField(null, 'a')).toBe('');
  });

  it('returns empty string for undefined input', () => {
    expect(getField(undefined, 'a')).toBe('');
  });

  it('returns top-level value', () => {
    expect(getField({ name: 'test' }, 'name')).toBe('test');
  });

  it('returns empty string for null leaf', () => {
    expect(getField({ a: { b: null } }, 'a.b')).toBe('');
  });

  it('returns 0 as-is (not empty string)', () => {
    expect(getField({ count: 0 }, 'count')).toBe(0);
  });

  it('returns false as-is', () => {
    expect(getField({ flag: false }, 'flag')).toBe(false);
  });
});

describe('parseBeadId', () => {
  it('extracts bead ID from text', () => {
    expect(parseBeadId('BEAD_ID: tcp-7uv.1')).toBe('tcp-7uv.1');
  });

  it('handles alphanumeric IDs with dots and dashes', () => {
    expect(parseBeadId('BEAD_ID: BD-001.2')).toBe('BD-001.2');
  });

  it('handles underscores', () => {
    expect(parseBeadId('BEAD_ID: my_bead_1')).toBe('my_bead_1');
  });

  it('returns empty string when no match', () => {
    expect(parseBeadId('no bead here')).toBe('');
  });

  it('returns empty string for null', () => {
    expect(parseBeadId(null)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(parseBeadId('')).toBe('');
  });

  it('extracts first match from multiline', () => {
    const text = 'line1\nBEAD_ID: abc-123\nBEAD_ID: def-456';
    expect(parseBeadId(text)).toBe('abc-123');
  });
});

describe('parseEpicId', () => {
  it('extracts epic ID from text', () => {
    expect(parseEpicId('EPIC_ID: tcp-7uv')).toBe('tcp-7uv');
  });

  it('returns empty string when no match', () => {
    expect(parseEpicId('BEAD_ID: abc')).toBe('');
  });

  it('returns empty string for null', () => {
    expect(parseEpicId(null)).toBe('');
  });
});

describe('containsPathSegment', () => {
  it('detects segment in unix path', () => {
    expect(containsPathSegment('/foo/.worktrees/bd-1/bar.ts', '.worktrees')).toBe(true);
  });

  it('detects segment in windows path', () => {
    expect(containsPathSegment('C:\\projects\\.worktrees\\bd-1\\file.js', '.worktrees')).toBe(true);
  });

  it('detects segment at end of path', () => {
    expect(containsPathSegment('/foo/.worktrees', '.worktrees')).toBe(true);
  });

  it('returns false for partial match', () => {
    expect(containsPathSegment('/foo/worktrees-old/file.js', '.worktrees')).toBe(false);
  });

  it('returns false for null path', () => {
    expect(containsPathSegment(null, '.worktrees')).toBe(false);
  });

  it('returns false for empty path', () => {
    expect(containsPathSegment('', '.worktrees')).toBe(false);
  });

  it('detects .claude segment', () => {
    expect(containsPathSegment('/project/.claude/plans/plan.md', '.claude')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Project-directory anchoring
// ---------------------------------------------------------------------------
// A hook process inherits the working directory of the last Bash tool call,
// so process.cwd() may be a subdirectory, a worktree, or a path outside the
// repo. Nothing path-related may depend on it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const utilsPath = require.resolve('../../templates/hooks/hook-utils.cjs');
const { getProjectDir, getRepoRoot, execCommand } = require(utilsPath);
const repoRoot = path.resolve(__dirname, '..', '..');

/** Copy hook-utils into a throwaway <tmp>/.claude/hooks/ and load that copy. */
function loadInstalledCopy() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-hooks-'));
  const hooks = path.join(project, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const dest = path.join(hooks, 'hook-utils.cjs');
  fs.copyFileSync(utilsPath, dest);
  return { project, mod: require(dest) };
}

function withEnv(value, fn) {
  const saved = process.env.CLAUDE_PROJECT_DIR;
  if (value === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = saved;
  }
}

function withCwd(dir, fn) {
  const saved = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(saved);
  }
}

describe('getProjectDir', () => {
  it('prefers CLAUDE_PROJECT_DIR', () => {
    withEnv('M:/somewhere/else', () => {
      expect(getProjectDir()).toBe('M:/somewhere/else');
    });
  });

  it('falls back to the project that owns the hook file, not the cwd', () => {
    const { project, mod } = loadInstalledCopy();
    withEnv(undefined, () => {
      withCwd(os.tmpdir(), () => {
        expect(fs.realpathSync(mod.getProjectDir())).toBe(fs.realpathSync(project));
      });
    });
  });

  it('ignores the cwd even when it is a subdirectory of the project', () => {
    withEnv(undefined, () => {
      withCwd(path.join(repoRoot, 'templates', 'hooks'), () => {
        expect(fs.realpathSync(getProjectDir())).toBe(fs.realpathSync(repoRoot));
      });
    });
  });
});

describe('execCommand cwd anchoring', () => {
  it('asks git about the project, not about the inherited cwd', () => {
    withEnv(repoRoot, () => {
      withCwd(os.tmpdir(), () => {
        const root = getRepoRoot();
        expect(root).not.toBeNull();
        expect(fs.realpathSync(root)).toBe(fs.realpathSync(repoRoot));
      });
    });
  });

  it('still lets the caller override cwd explicitly', () => {
    const out = execCommand('git', ['rev-parse', '--show-toplevel'], { cwd: os.tmpdir() });
    // os.tmpdir() is not a repository, so git fails and execCommand returns null
    expect(out).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// splitCommandSegments
// ---------------------------------------------------------------------------

const { splitCommandSegments } = require('../../templates/hooks/hook-utils.cjs');

describe('splitCommandSegments', () => {
  it('returns a single command unchanged', () => {
    expect(splitCommandSegments('git status')).toEqual(['git status']);
  });

  it('splits on && so a guarded command cannot hide behind cd', () => {
    expect(splitCommandSegments('cd sub && git commit --no-verify'))
      .toEqual(['cd sub', 'git commit --no-verify']);
  });

  it('splits on ||, ; , | and newlines', () => {
    expect(splitCommandSegments('a || b ; c | d')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitCommandSegments('a\nb')).toEqual(['a', 'b']);
  });

  it('splits on a single & (background)', () => {
    expect(splitCommandSegments('sleep 1 & git push')).toEqual(['sleep 1', 'git push']);
  });

  it('does not split inside double quotes', () => {
    expect(splitCommandSegments('echo "a && b"')).toEqual(['echo "a && b"']);
  });

  it('does not split inside single quotes', () => {
    expect(splitCommandSegments("git commit -m 'fix; also fix'"))
      .toEqual(["git commit -m 'fix; also fix'"]);
  });

  it('drops empty segments from trailing operators', () => {
    expect(splitCommandSegments('git status &&')).toEqual(['git status']);
    expect(splitCommandSegments('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// execCommand argument passing
// ---------------------------------------------------------------------------
// An args array combined with `shell: true` is concatenated, not escaped —
// that is what Node's DEP0190 warns about. Measured on Windows: a space splits
// one argument into two, quotes are stripped, `^` disappears, `%VAR%` expands,
// and `&&`, `|`, `>` execute as shell operators. These tests pin the fix down:
// every argument must reach the program exactly as it was written.

const { spawnSync } = require('child_process');

// Every directory made through tempDir is removed once the file is done.
const madeForCmdExe = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  madeForCmdExe.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of madeForCmdExe) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

/** A throwaway script that prints each argv entry on its own line. */
function makeArgvPrinter() {
  const dir = tempDir('cp-argv-');
  const file = path.join(dir, 'argv-print.js');
  fs.writeFileSync(file, 'process.argv.slice(2).forEach((a, i) => console.log(i + "=<" + a + ">"));\n');
  return file;
}

/** Split output on newlines without caring which line ending the OS used. */
function lines(out) {
  return String(out).split(/\r?\n/);
}

const onWindows = process.platform === 'win32';
const ONLY_WINDOWS = 'cmd.exe and .cmd wrappers exist only on Windows';

// Arguments the cmd.exe path refuses, one per character it refuses. The tests
// below check that none of them reaches the wrapper's directory in any form.
const REFUSED_ARGS = {
  'a double quote': 'x" & type nul > MARKER & "',
  'a percent sign': 'x%CMDCMDLINE:~-1% & type nul > MARKER & %CMDCMDLINE:~-1%',
  'an exclamation mark': 'x!CMDCMDLINE:~-1! & type nul > MARKER & !CMDCMDLINE:~-1!',
  'a line feed': 'x\n& type nul > MARKER',
  'a carriage return': 'x\r& type nul > MARKER',
  'a NUL': 'x\0 & type nul > MARKER',
};

/**
 * A .cmd wrapper `name` in a fresh directory (whose name holds a space) that
 * forwards its arguments to an argv printer, and the options that run it from
 * that directory. `strayFile` is the file the refused arguments name; the
 * error log goes to that directory too.
 */
function cmdWrapper(name) {
  const dir = path.join(tempDir('cp-cmd-'), 'with space');
  fs.mkdirSync(dir);
  const printer = path.join(dir, 'argv-print.js');
  fs.writeFileSync(printer, 'process.argv.slice(2).forEach((a, i) => console.log(i + "=<" + a + ">"));\n');
  const wrapper = path.join(dir, `${name}.cmd`);
  fs.writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${printer}" %*\r\n`);
  return {
    dir,
    wrapper,
    strayFile: path.join(dir, 'MARKER'),
    log: () => {
      const file = path.join(dir, 'beads_orchestrator_errors.log');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    },
    opts: { cwd: dir, env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH } },
  };
}

/** Run `fn` with the error log sent to `dir`; `fn` may be async. */
async function loggingTo(dir, fn) {
  const saved = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = dir;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = saved;
  }
}

/**
 * A .cmd wrapper `name` whose program writes its pid and then sleeps far
 * longer than any test waits — a hanging bd as seen from here: cmd.exe with
 * the program as its child. `pid()` is the program's pid, once written.
 */
function hangingWrapper(name) {
  const dir = tempDir('cp-hang-');
  const pidFile = path.join(dir, 'pid');
  const sleeper = path.join(dir, 'sleep.js');
  fs.writeFileSync(sleeper, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n`
    + 'setTimeout(() => {}, 60000);\n');
  fs.writeFileSync(path.join(dir, `${name}.cmd`), `@"${process.execPath}" "${sleeper}"\r\n`);
  return {
    dir,
    opts: { timeout: 3000, env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH } },
    pid: () => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : null),
  };
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait up to `ms` for the process to be gone; true when it is. */
async function goneWithin(pid, ms) {
  const until = Date.now() + ms;
  while (isRunning(pid)) {
    if (Date.now() > until) return false;
    await new Promise(r => setTimeout(r, 100));
  }
  return true;
}

/** Stop a process a failed test may have left behind. */
function reap(pid) {
  if (pid && isRunning(pid)) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)]);
}

describe('execCommand argument passing', () => {
  // process.execPath is "C:\Program Files\nodejs\node.exe" on Windows, so this
  // also covers a program whose own path contains a space.
  const printer = makeArgvPrinter();

  it('keeps an argument containing a space as one argument', () => {
    expect(lines(execCommand(process.execPath, [printer, 'two words'])))
      .toEqual(['0=<two words>']);
  });

  it('does not let shell operators inside an argument run as commands', () => {
    expect(lines(execCommand(process.execPath, [printer, 'zzz && echo PWNED'])))
      .toEqual(['0=<zzz && echo PWNED>']);
    expect(lines(execCommand(process.execPath, [printer, 'zzz | echo PWNED'])))
      .toEqual(['0=<zzz | echo PWNED>']);
  });

  it('keeps quotes, carets and percent signs intact', () => {
    expect(lines(execCommand(process.execPath, [printer, 'say "hi"', 'a^b', '%PATH%'])))
      .toEqual(['0=<say "hi">', '1=<a^b>', '2=<%PATH%>']);
  });

  it('finds a repository whose path contains a space', () => {
    const repo = path.join(tempDir('cp-space-'), 'dir with space');
    fs.mkdirSync(repo, { recursive: true });
    expect(execCommand('git', ['init', '-q', repo])).not.toBeNull();

    const root = execCommand('git', ['-C', repo, 'rev-parse', '--show-toplevel']);
    expect(root).not.toBeNull();
    expect(fs.realpathSync(root)).toBe(fs.realpathSync(repo));
  });

  // Guards the retry, not the old bug: a failed direct spawn now falls through
  // to cmd.exe, which must not turn "no such program" into an empty string.
  it('returns null for a program that does not exist', () => {
    expect(execCommand('cp-no-such-tool-xyz', ['--version'])).toBeNull();
  });

  /** A .cmd wrapper on PATH that forwards its arguments to the argv printer. */
  function wrapperOnPath() {
    const dir = tempDir('cp-wrapper-');
    fs.writeFileSync(path.join(dir, 'cp-printer.cmd'),
      `@echo off\r\n"${process.execPath}" "${printer}" %*\r\n`);
    return { env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH } };
  }

  // .cmd/.bat wrappers cannot be spawned directly at all (Node refuses with
  // EINVAL/ENOENT), so they are the one case that still goes through cmd.exe —
  // and therefore the one case where a shell parser sees the arguments.
  it('runs a .cmd wrapper and keeps its arguments intact', ({ skip }) => {
    skip(!onWindows, ONLY_WINDOWS);
    const out = execCommand(
      'cp-printer',
      ['two words', 'a^b', 'C:\\Users\\R&D\\project', 'a|b>c', 'C:\\dir\\', ''],
      wrapperOnPath(),
    );
    expect(lines(out)).toEqual([
      '0=<two words>', '1=<a^b>', '2=<C:\\Users\\R&D\\project>', '3=<a|b>c>', '4=<C:\\dir\\>', '5=<>',
    ]);
  });

  // A full path is refused with EINVAL rather than ENOENT; the space in it
  // must survive cmd.exe as well.
  it('runs a .cmd wrapper given by a full path with a space in it', ({ skip }) => {
    skip(!onWindows, ONLY_WINDOWS);
    const { wrapper } = cmdWrapper('cp-full-path');

    expect(lines(execCommand(wrapper, ['one', 'two words']))).toEqual(['0=<one>', '1=<two words>']);
  });

  // Node quotes an argument only when it contains whitespace, so a
  // metacharacter with no spaces around it reaches cmd.exe bare — `x&&echo.>f`
  // used to run as a second command and really created the file.
  it('does not let a .cmd wrapper argument run a second command', ({ skip }) => {
    skip(!onWindows, ONLY_WINDOWS);
    const opts = wrapperOnPath();
    const mark = path.join(tempDir('cp-mark-'), 'INJECTED.txt');

    const out = execCommand('cp-printer', [`x&&echo.>${mark}`, `y>${mark}`], opts);

    expect(fs.existsSync(mark)).toBe(false);
    expect(lines(out)).toEqual([`0=<x&&echo.>${mark}>`, `1=<y>${mark}>`]);
  });

  // Not sent at all — on the first call to a wrapper (the retry through
  // cmd.exe) and on a later one alike.
  Object.entries(REFUSED_ARGS).forEach(([what, payload], i) => {
    it(`refuses to pass ${what} through cmd.exe, and says so in the error log`, async ({ skip }) => {
      skip(!onWindows, ONLY_WINDOWS);
      const name = `cp-refuse-sync-${i}`;
      const tool = cmdWrapper(name);

      await loggingTo(tool.dir, () => {
        expect(execCommand(name, ['ok', payload], tool.opts)).toBeNull();
        expect(lines(execCommand(name, ['ok'], tool.opts))).toEqual(['0=<ok>']);
        expect(execCommand(name, [payload], tool.opts)).toBeNull();
      });

      expect(fs.existsSync(tool.strayFile)).toBe(false);
      expect(tool.log()).toContain(name);
      expect(tool.log()).toContain('cmd.exe');
    });
  });

  // The wait for a wrapper runs on a worker thread, and a function cannot be
  // handed to one. That is a failed call, not a thrown one.
  it('gives null, and logs why, when the call cannot be handed to a worker', async ({ skip }) => {
    skip(!onWindows, ONLY_WINDOWS);
    const tool = cmdWrapper('cp-no-worker');
    const opts = { ...tool.opts, notCloneable: () => {} };

    const out = await loggingTo(tool.dir, () => execCommand('cp-no-worker', ['ok'], opts));

    expect(out).toBeNull();
    expect(tool.log()).toContain('worker thread failed');
  });

  // A worker that cannot run the command at all is a failure of its own, not
  // a command that failed. Here it loads a copy of this file that lacks the
  // export it needs.
  it('gives null, and logs why, when the worker itself fails', async ({ skip }) => {
    skip(!onWindows, ONLY_WINDOWS);
    const tool = cmdWrapper('cp-broken-worker');
    const source = fs.readFileSync(utilsPath, 'utf8');
    const withoutSettle = source.replace(/^ {2}settle,\r?\n/m, '');
    expect(withoutSettle).not.toBe(source);
    const copy = path.join(tempDir('cp-broken-utils-'), 'hook-utils.cjs');
    fs.writeFileSync(copy, withoutSettle);
    const broken = require(copy);

    const out = await loggingTo(tool.dir, () => broken.execCommand('cp-broken-worker', ['ok'], tool.opts));

    expect(out).toBeNull();
    expect(tool.log()).toContain('worker thread failed');
  });

  // A quote is fine where no shell is involved.
  it('passes the same arguments to a program started directly', () => {
    const payloads = Object.values(REFUSED_ARGS).filter(payload => !payload.includes('\0'));
    expect(lines(execCommand(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...payloads])))
      .toEqual([JSON.stringify(payloads)]);
  });

  // execFileSync's own time limit stops cmd.exe and nothing else: the program
  // behind the wrapper ran on, and every hanging bd left one more behind.
  it('stops the program behind a .cmd wrapper when its time is up', async ({ skip }) => {
    skip(!onWindows, ONLY_WINDOWS);
    const tool = hangingWrapper('cp-hang-sync');
    let pid = null;
    try {
      expect(await loggingTo(tool.dir, () => execCommand('cp-hang-sync', [], tool.opts))).toBeNull();
      pid = tool.pid();
      expect(pid, 'the program never started, so nothing was tested').not.toBeNull();
      expect(await goneWithin(pid, 3000)).toBe(true);
    } finally {
      reap(pid || tool.pid());
    }
  });

  it('writes nothing to stderr — no DEP0190 deprecation noise', () => {
    const script = `require(${JSON.stringify(utilsPath)}).execCommand('git', ['--version']);`;
    const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(res.stderr).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Programs in the project directory
// ---------------------------------------------------------------------------
// Windows looks for a program named without a path in the current directory
// first — Node and cmd.exe alike — unless NoDefaultCurrentDirectoryInExePath
// is set. Claude Code sets it; a hook started any other way may lack it.

describe('programs of the same name in the project directory', () => {
  it('are never started in place of the real ones', async ({ skip }) => {
    skip(!onWindows, ONLY_WINDOWS);
    const project = tempDir('cp-planted-');
    const started = path.join(project, 'started.log');
    // Every node that starts notes its own file name — the copies below too.
    const note = path.join(project, 'note.js');
    fs.writeFileSync(note, `require('fs').appendFileSync(${JSON.stringify(started)}, `
      + 'require(\'path\').basename(process.execPath) + \'\\n\');\n');
    const planted = path.join(project, 'git.exe');
    fs.copyFileSync(process.execPath, planted);
    for (const name of ['bd.exe', 'gh.exe', 'cmd.exe', 'taskkill.exe']) {
      fs.linkSync(planted, path.join(project, name));
    }
    fs.writeFileSync(path.join(project, 'cp-here-only.cmd'), `@echo cp-here-only.cmd>>"${started}"\r\n`);

    // The real wrappers live elsewhere on PATH; one of them hangs.
    const tools = tempDir('cp-planted-tools-');
    const printer = path.join(tools, 'argv-print.js');
    fs.writeFileSync(printer, 'process.argv.slice(2).forEach((a, i) => console.log(i + "=<" + a + ">"));\n');
    fs.writeFileSync(path.join(tools, 'cp-elsewhere.cmd'), `@"${process.execPath}" "${printer}" %*\r\n`);
    const pids = path.join(tools, 'pids');
    const sleeper = path.join(tools, 'sleep.js');
    fs.writeFileSync(sleeper, `require('fs').appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');\n`
      + 'setTimeout(() => {}, 60000);\n');
    fs.writeFileSync(path.join(tools, 'cp-hangs.cmd'), `@"${process.execPath}" "${sleeper}"\r\n`);

    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => key.toUpperCase() !== 'NODEFAULTCURRENTDIRECTORYINEXEPATH'));
    Object.assign(env, {
      PATH: tools + path.delimiter + process.env.PATH,
      CLAUDE_PROJECT_DIR: project,
      // A backslash inside NODE_OPTIONS quotes is an escape.
      NODE_OPTIONS: `--require "${note.replace(/\\/g, '/')}"`,
    });
    // `version`, not `--version`: a node answers that one before it loads
    // note.js, and would pass unnoticed.
    const script = `const u = require(${JSON.stringify(utilsPath)});
(async () => {
  const answers = {
    git: u.execCommand('git', ['version']),
    bd: u.execCommand('bd', ['version']),
    gh: u.execCommand('gh', ['version']),
    hereOnly: u.execCommand('cp-here-only', []),
    elsewhere: u.execCommand('cp-elsewhere', ['ok']),
    elsewhereAsync: await u.execCommandAsync('cp-elsewhere', ['ok']),
    hangs: u.execCommand('cp-hangs', [], { timeout: 2000 }),
    hangsAsync: await u.execCommandAsync('cp-hangs', [], { timeout: 2000 }),
  };
  process.stdout.write(JSON.stringify(answers));
})();`;

    const readPids = () => (fs.existsSync(pids)
      ? fs.readFileSync(pids, 'utf8').split(/\s+/).filter(Boolean).map(Number) : []);
    try {
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: project, env, encoding: 'utf8', timeout: 60000,
      });
      const answers = JSON.parse(result.stdout || '{}');
      const names = fs.existsSync(started) ? fs.readFileSync(started, 'utf8').split(/\r?\n/) : [];

      expect(names.filter(name => name && name !== 'node.exe'), result.stderr).toEqual([]);
      expect(answers.git).toMatch(/^git version/);
      expect(answers.hereOnly).toBeNull();
      expect(answers.elsewhere).toBe('0=<ok>');
      expect(answers.elsewhereAsync).toBe('0=<ok>');
      expect([answers.hangs, answers.hangsAsync]).toEqual([null, null]);
      expect(readPids(), 'the hanging wrapper never started').toHaveLength(2);
      for (const pid of readPids()) expect(await goneWithin(pid, 3000)).toBe(true);
    } finally {
      readPids().forEach(reap);
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// beads version
// ---------------------------------------------------------------------------
// An old bd does not announce itself: it fails one command at a time with
// "unknown command". These two functions turn that into one line at session
// start — so a false positive would nag every session, and a false negative
// only costs the warning.

const {
  BD_MIN_VERSION,
  parseBdVersion,
  versionBelow,
} = require('../../templates/hooks/hook-utils.cjs');

describe('parseBdVersion', () => {
  it('reads the version out of real `bd version` output', () => {
    expect(parseBdVersion('bd version 1.1.0 (8e4e59d39: HEAD@8e4e59d39f34)')).toBe('1.1.0');
  });

  it('reads a multi-digit version', () => {
    expect(parseBdVersion('bd version 10.2.13')).toBe('10.2.13');
  });

  it('returns null for empty output', () => {
    expect(parseBdVersion('')).toBeNull();
    expect(parseBdVersion(null)).toBeNull();
  });

  it('returns null when there is no version in the text', () => {
    expect(parseBdVersion('bd version unknown')).toBeNull();
  });
});

describe('versionBelow', () => {
  it('is true below the minimum', () => {
    expect(versionBelow('1.0.9', '1.1.0')).toBe(true);
    expect(versionBelow('0.9.0', '1.1.0')).toBe(true);
  });

  it('is false at or above the minimum', () => {
    expect(versionBelow('1.1.0', '1.1.0')).toBe(false);
    expect(versionBelow('1.1.1', '1.1.0')).toBe(false);
    expect(versionBelow('2.0.0', '1.1.0')).toBe(false);
  });

  it('compares numbers, not strings', () => {
    expect(versionBelow('1.10.0', '1.9.0')).toBe(false);
    expect(versionBelow('1.9.0', '1.10.0')).toBe(true);
  });

  it('stays silent on anything it cannot read', () => {
    expect(versionBelow(null, '1.1.0')).toBe(false);
    expect(versionBelow(undefined, '1.1.0')).toBe(false);
    expect(versionBelow('nonsense', '1.1.0')).toBe(false);
    expect(versionBelow('1.1', '1.1.0')).toBe(false);
  });
});

describe('BD_MIN_VERSION', () => {
  it('is a three-part version', () => {
    expect(BD_MIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ---------------------------------------------------------------------------
// Where a hook thinks it is, and whether beads lives there
// ---------------------------------------------------------------------------
// Started from the plugin, these files sit in the plugin's own checkout, which
// has a .claude/ and a .beads/ of its own. Walking up from __dirname would then
// answer with the plugin instead of the project being worked on, and every
// check built on the answer would be about the wrong place.

const { hasBeads, isPluginInstall } = require(utilsPath);

function withPluginRoot(value, run) {
  const saved = process.env.CLAUDE_PLUGIN_ROOT;
  if (value === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = value;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = saved;
  }
}

function askInSubprocess(expression, cwd, env) {
  const script = `const u=require(${JSON.stringify(utilsPath)});`
    + `process.stdout.write(String(${expression}));`;
  return spawnSync(process.execPath, ['-e', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', CLAUDE_PLUGIN_ROOT: '', ...env },
  }).stdout;
}

describe('isPluginInstall', () => {
  it('is true only when a plugin root is in the environment', () => {
    expect(withPluginRoot('/x/plugins/claude-protocol',
                          () => isPluginInstall())).toBe(true);
    expect(withPluginRoot(undefined, () => isPluginInstall())).toBe(false);
  });
});

describe('hasBeads', () => {
  it('is true where the project tracks work in beads', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-beads-'));
    fs.mkdirSync(path.join(project, '.beads'));

    expect(withEnv(project, () => hasBeads())).toBe(true);
  });

  it('is false where it does not', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-plain-'));

    expect(withEnv(project, () => hasBeads())).toBe(false);
  });
});

describe('getProjectDir under a plugin', () => {
  it('answers with CLAUDE_PROJECT_DIR whenever it is set', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-env-'));

    expect(askInSubprocess('u.getProjectDir()', os.tmpdir(),
                           { CLAUDE_PROJECT_DIR: project })).toBe(project);
  });

  it('walks up from the hook file for a copy installed in a project', () => {
    expect(askInSubprocess('u.getProjectDir()', os.tmpdir(), {})).toBe(repoRoot);
  });

  it('does not walk up to the plugin when it was started from one', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-cwd-'));

    const answer = askInSubprocess('u.getProjectDir()', elsewhere,
                                   { CLAUDE_PLUGIN_ROOT: '/x/plugins/claude-protocol' });

    expect(answer).not.toBe(repoRoot);
  });
});

// ---------------------------------------------------------------------------
// Which version is running, and what to say when a newer one is out
// ---------------------------------------------------------------------------

const { readOwnVersion, updateNotice } = require(utilsPath);

describe('readOwnVersion', () => {
  it('reads the plugin manifest when it runs as a plugin', () => {
    const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-plugin-'));
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'));
    fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
                     JSON.stringify({ name: 'claude-protocol', version: '3.9.1' }));

    expect(withPluginRoot(pluginRoot, () => readOwnVersion())).toBe('3.9.1');
  });

  it('reads the project manifest for an install from npx', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-npx-'));
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(path.join(project, '.claude', '.manifest.json'),
                     JSON.stringify({ version: '3.4.0', files: {} }));

    expect(withPluginRoot(undefined,
      () => withEnv(project, () => readOwnVersion()))).toBe('3.4.0');
  });

  it('is null when there is nothing to read', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-none-'));

    expect(withPluginRoot(undefined,
      () => withEnv(empty, () => readOwnVersion()))).toBeNull();
  });

  it('is null when the manifest has no version', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-noversion-'));
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(path.join(project, '.claude', '.manifest.json'),
                     JSON.stringify({ files: {} }));

    expect(withPluginRoot(undefined,
      () => withEnv(project, () => readOwnVersion()))).toBeNull();
  });
});

describe('updateNotice', () => {
  it('says nothing when the running version is current', () => {
    expect(updateNotice('3.7.0', '3.7.0', false)).toBeNull();
    expect(updateNotice('3.8.0', '3.7.0', false)).toBeNull();
  });

  it('says nothing when the latest version could not be read', () => {
    expect(updateNotice('3.7.0', null, false)).toBeNull();
    expect(updateNotice('3.7.0', '', true)).toBeNull();
  });

  it('names both versions when one is behind', () => {
    const lines = updateNotice('3.6.0', '3.7.0', false).join('\n');

    expect(lines).toContain('3.6.0');
    expect(lines).toContain('3.7.0');
  });

  it('tells an npx install to run the upgrade', () => {
    expect(updateNotice('3.6.0', '3.7.0', false).join('\n'))
      .toContain('npx claude-protocol@latest upgrade');
  });

  it('warns a plugin install that auto-update is off by default', () => {
    const lines = updateNotice('3.6.0', '3.7.0', true).join('\n');

    expect(lines).toContain('/plugin');
    expect(lines).toContain('off by default');
  });
});

// ---------------------------------------------------------------------------
// Is the plugin the one supplying these hooks in this project?
// ---------------------------------------------------------------------------
// Both routes wire the same three hooks, and Claude Code merges hooks from
// every source, so a project carrying both fires each one twice. The answer
// comes from Claude Code's own plugin registry, and any registry we cannot
// read has to answer "no" — a copy that stands down on a guess is a copy that
// stops enforcing anything.

const { pluginActiveHere } = require(utilsPath);

/** A throwaway CLAUDE_CONFIG_DIR holding the given registry text. */
function withRegistry(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-registry-'));
  if (contents !== undefined) {
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'plugins', 'installed_plugins.json'),
      typeof contents === 'string' ? contents : JSON.stringify(contents),
    );
  }
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
}

function registryWith(...entries) {
  return { version: 2, plugins: { 'claude-protocol@claude-protocol': entries } };
}

describe('pluginActiveHere', () => {
  const project = path.join(os.tmpdir(), 'hu-active-project');
  const elsewhere = path.join(os.tmpdir(), 'hu-other-project');

  it('is true for every project when the plugin is installed at user scope', () => {
    const registry = registryWith({ scope: 'user', version: '3.8.1' });

    expect(withRegistry(registry, () => pluginActiveHere(project))).toBe(true);
  });

  it('is true for the project a project-scope install names', () => {
    const registry = registryWith({ scope: 'project', projectPath: project });

    expect(withRegistry(registry, () => pluginActiveHere(project))).toBe(true);
  });

  it('is false for a project a project-scope install does not name', () => {
    const registry = registryWith({ scope: 'project', projectPath: elsewhere });

    expect(withRegistry(registry, () => pluginActiveHere(project))).toBe(false);
  });

  it('ignores a trailing separator on the recorded path', () => {
    const registry = registryWith({ scope: 'project', projectPath: project + path.sep });

    expect(withRegistry(registry, () => pluginActiveHere(project))).toBe(true);
  });

  it('is false when the registry holds other plugins only', () => {
    const registry = { version: 2, plugins: { 'feature-dev@somewhere': [{ scope: 'user' }] } };

    expect(withRegistry(registry, () => pluginActiveHere(project))).toBe(false);
  });

  it('is false when a lookalike name merely starts the same', () => {
    const registry = { version: 2, plugins: { 'claude-protocol-extras@x': [{ scope: 'user' }] } };

    expect(withRegistry(registry, () => pluginActiveHere(project))).toBe(false);
  });

  it('is false when the registry is not there', () => {
    expect(withRegistry(undefined, () => pluginActiveHere(project))).toBe(false);
  });

  it('is false when the registry is not JSON', () => {
    expect(withRegistry('not json {{{', () => pluginActiveHere(project))).toBe(false);
  });

  it('is false when the registry has a shape we do not know', () => {
    expect(withRegistry({ version: 9 }, () => pluginActiveHere(project))).toBe(false);
    expect(withRegistry({ plugins: 'nope' }, () => pluginActiveHere(project))).toBe(false);
    expect(withRegistry(registryWith(), () => pluginActiveHere(project))).toBe(false);
    expect(withRegistry({ version: 2, plugins: { 'claude-protocol@x': 'nope' } },
                        () => pluginActiveHere(project))).toBe(false);
  });

  it('falls back to the project it is asked about', () => {
    const registry = registryWith({ scope: 'project', projectPath: project });

    expect(withRegistry(registry, () => withEnv(project, () => pluginActiveHere())))
      .toBe(true);
  });
});

// ---------------------------------------------------------------------------
// One source at a time: the project copy stands down under an active plugin
// ---------------------------------------------------------------------------
// Every hook the plugin ships goes through runHook, so the stand-down lives
// there once instead of at the top of each of them.

/** Write a registry naming `project` at project scope, return its config dir. */
function registryDirFor(project) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-standdown-'));
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'installed_plugins.json'),
                   JSON.stringify(registryWith({ scope: 'project', projectPath: project })));
  return dir;
}

/** Run runHook in its own process; returns what the body managed to print. */
function runHookInSubprocess(env) {
  const script = `const u=require(${JSON.stringify(utilsPath)});`
    + `u.runHook('probe', () => process.stdout.write('RAN'));`;
  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: '',
      CLAUDE_CONFIG_DIR: '',
      ...env,
    },
  });
}

describe('runHook under an active plugin', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-sd-project-'));

  it('does not run the body of a project copy', () => {
    const result = runHookInSubprocess({
      CLAUDE_PROJECT_DIR: project,
      CLAUDE_CONFIG_DIR: registryDirFor(project),
    });

    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('runs the body of the plugin copy, which is the one doing the work', () => {
    const result = runHookInSubprocess({
      CLAUDE_PROJECT_DIR: project,
      CLAUDE_CONFIG_DIR: registryDirFor(project),
      CLAUDE_PLUGIN_ROOT: path.join(os.tmpdir(), 'pretend-plugin'),
    });

    expect(result.stdout).toBe('RAN');
  });

  it('runs the body when no plugin is installed at all', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-sd-empty-'));
    const result = runHookInSubprocess({
      CLAUDE_PROJECT_DIR: project,
      CLAUDE_CONFIG_DIR: empty,
    });

    expect(result.stdout).toBe('RAN');
  });

  it('runs the body when the plugin is active for a different project', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-sd-other-'));
    const result = runHookInSubprocess({
      CLAUDE_PROJECT_DIR: project,
      CLAUDE_CONFIG_DIR: registryDirFor(other),
    });

    expect(result.stdout).toBe('RAN');
  });
});

// A plugin can be installed and switched off. Standing down for one that never
// runs leaves the project with no hooks at all and nothing said about it, so an
// explicit false anywhere outranks the registry. Absence is not a false: a
// project-scope install writes no enabledPlugins entry at all.
describe('pluginActiveHere with the plugin switched off', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-off-project-'));

  function withSettings(where, contents, fn) {
    const registry = registryWith({ scope: 'user' });
    return withRegistry(registry, () => {
      const target = where === 'user'
        ? path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')
        : path.join(project, '.claude', where);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, typeof contents === 'string'
        ? contents : JSON.stringify(contents));
      try {
        return fn();
      } finally {
        fs.rmSync(target, { force: true });
      }
    });
  }

  const off = { enabledPlugins: { 'claude-protocol@claude-protocol': false } };
  const on = { enabledPlugins: { 'claude-protocol@claude-protocol': true } };

  it('is false when user settings switch it off', () => {
    expect(withSettings('user', off, () => pluginActiveHere(project))).toBe(false);
  });

  it('is false when the project switches it off', () => {
    expect(withSettings('settings.json', off, () => pluginActiveHere(project)))
      .toBe(false);
  });

  it('is false when the local project settings switch it off', () => {
    expect(withSettings('settings.local.json', off, () => pluginActiveHere(project)))
      .toBe(false);
  });

  it('is true when settings switch it on', () => {
    expect(withSettings('user', on, () => pluginActiveHere(project))).toBe(true);
  });

  it('is true when settings say nothing about it', () => {
    expect(withSettings('user', { permissions: {} }, () => pluginActiveHere(project)))
      .toBe(true);
  });

  it('ignores settings it cannot read', () => {
    expect(withSettings('user', 'not json {{{', () => pluginActiveHere(project)))
      .toBe(true);
  });
});

// Two ways a recorded path can name the right directory in the wrong words,
// and one way it can name nothing at all.
describe('pluginActiveHere on a path spelled differently', () => {
  it('is false for a relative path, which resolves against nothing knowable', () => {
    const registry = registryWith({ scope: 'project', projectPath: './somewhere' });

    expect(withRegistry(registry, () => pluginActiveHere(path.resolve('./somewhere'))))
      .toBe(false);
  });

  it('sees through a symlink to the same directory', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-real-'));
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hu-link-')), 'as-seen');
    try {
      fs.symlinkSync(real, link, 'junction');
    } catch {
      return; // Windows without the privilege to make one. Nothing to prove here.
    }
    const registry = registryWith({ scope: 'project', projectPath: real });

    expect(withRegistry(registry, () => pluginActiveHere(link))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// An npx install still wired up next to the plugin
// ---------------------------------------------------------------------------
// The project copy stands down on its own, silently. This is what makes the
// silence explainable: the plugin says the leftovers are there and names the
// command that removes them.

const { leftoverProjectHooks } = require(utilsPath);

function projectWithSettings(files) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-leftover-'));
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(project, '.claude', name),
                     typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return project;
}

function wiring(...commands) {
  return {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: commands.map(c => ({ type: 'command', command: c })) }],
    },
  };
}

describe('leftoverProjectHooks', () => {
  it('names a hook of ours wired in settings.json', () => {
    const project = projectWithSettings({
      'settings.json': wiring('node .claude/hooks/bash-guard.cjs'),
    });

    expect(leftoverProjectHooks(project)).toEqual(['bash-guard.cjs']);
  });

  it('names one wired in settings.local.json', () => {
    const project = projectWithSettings({
      'settings.local.json': wiring('node .claude/hooks/validate-completion.cjs'),
    });

    expect(leftoverProjectHooks(project)).toEqual(['validate-completion.cjs']);
  });

  it('names each hook once, however many places wire it', () => {
    const project = projectWithSettings({
      'settings.json': wiring('node .claude/hooks/session-start.cjs'),
      'settings.local.json': wiring('node .claude/hooks/session-start.cjs'),
    });

    expect(leftoverProjectHooks(project)).toEqual(['session-start.cjs']);
  });

  it('is empty for settings that wire someone else’s script', () => {
    const project = projectWithSettings({
      'settings.json': wiring('node .claude/hooks/their-own-thing.cjs', 'bd prime'),
    });

    expect(leftoverProjectHooks(project)).toEqual([]);
  });

  it('is empty where there are no settings at all', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hu-nosettings-'));

    expect(leftoverProjectHooks(project)).toEqual([]);
  });

  it('is empty for settings it cannot read', () => {
    const project = projectWithSettings({ 'settings.json': 'not json {{{' });

    expect(leftoverProjectHooks(project)).toEqual([]);
  });

  it('is empty for settings with no hooks in them', () => {
    const project = projectWithSettings({ 'settings.json': { permissions: {} } });

    expect(leftoverProjectHooks(project)).toEqual([]);
  });

  it('finds the name inside the node -e wrapper the installer writes', () => {
    const project = projectWithSettings({
      'settings.json': wiring(
        'node -e "const p=require(\'path\')..." bash-guard.cjs'),
    });

    expect(leftoverProjectHooks(project)).toEqual(['bash-guard.cjs']);
  });
});

// A hook added to templates/hooks and forgotten here would go unnoticed in a
// project that wires it: the leftovers would be reported as partly cleaned up.
it('knows every hook the plugin ships', () => {
  const shipped = fs.readdirSync(path.join(repoRoot, 'templates', 'hooks'))
    .filter(name => name.endsWith('.cjs') && name !== 'hook-utils.cjs');
  const project = projectWithSettings({
    'settings.json': wiring(...shipped.map(name => `node .claude/hooks/${name}`)),
  });

  expect(leftoverProjectHooks(project).sort()).toEqual(shipped.sort());
});

// ---------------------------------------------------------------------------
// execCommandAsync — for commands that should run side by side
// ---------------------------------------------------------------------------
// session-start asks bd four questions that each take seconds. Run one after
// another they add up; run side by side they cost about the slowest one.

const { execCommandAsync, execCommandJSONAsync, runHook } = require(utilsPath);

// Every directory made from here on is removed once the file is done.
const madeForAsync = [];
function asyncTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  madeForAsync.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of madeForAsync) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe('execCommandAsync', () => {
  it('resolves with the trimmed output', async () => {
    const out = await execCommandAsync(process.execPath, ['-e', 'console.log("  hello  ")']);
    expect(out).toBe('hello');
  });

  it('resolves with null when the command fails', async () => {
    expect(await execCommandAsync(process.execPath, ['-e', 'process.exit(3)'])).toBeNull();
  });

  it('resolves with null for a program that does not exist', async () => {
    expect(await execCommandAsync('cp-no-such-tool-xyz', ['--version'])).toBeNull();
  });

  it('parses JSON output, and gives null for anything else', async () => {
    const json = (text) => execCommandJSONAsync(process.execPath, ['-e', `console.log(${JSON.stringify(text)})`]);
    expect(await json('[1, 2]')).toEqual([1, 2]);
    expect(await json('not json')).toBeNull();
  });

  /** A .cmd wrapper `name` on PATH that forwards its arguments to an argv printer. */
  function asyncWrapper(name) {
    const dir = asyncTempDir('hu-async-wrapper-');
    const printer = path.join(dir, 'argv-print.js');
    fs.writeFileSync(printer, 'process.argv.slice(2).forEach((a, i) => console.log(i + "=<" + a + ">"));\n');
    fs.writeFileSync(path.join(dir, `${name}.cmd`),
      `@echo off\r\n"${process.execPath}" "${printer}" %*\r\n`);
    return { env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH } };
  }

  // The same wrapper handling as execCommand: bd and gh installed through npm
  // are .cmd files, which cannot be spawned directly.
  it('runs a .cmd wrapper and keeps its arguments intact', async ({ skip }) => {
    skip(!onWindows, ONLY_WINDOWS);
    const out = await execCommandAsync(
      'cp-async-printer', ['two words', 'a^b', 'x&&echo PWNED', 'a|b>c', 'C:\\dir\\'],
      asyncWrapper('cp-async-printer'));

    expect(lines(out)).toEqual([
      '0=<two words>', '1=<a^b>', '2=<x&&echo PWNED>', '3=<a|b>c>', '4=<C:\\dir\\>',
    ]);
  });

  it('runs a .cmd wrapper given by a full path with a space in it', async ({ skip }) => {
    skip(!onWindows, ONLY_WINDOWS);
    const { wrapper } = cmdWrapper('cp-async-full-path');

    expect(lines(await execCommandAsync(wrapper, ['one', 'two words']))).toEqual(['0=<one>', '1=<two words>']);
  });

  // As for execCommand: not sent at all, on the first call or a later one.
  Object.entries(REFUSED_ARGS).forEach(([what, payload], i) => {
    it(`refuses to pass ${what} through cmd.exe, and says so in the error log`, async ({ skip }) => {
      skip(!onWindows, ONLY_WINDOWS);
      const name = `cp-refuse-async-${i}`;
      const tool = cmdWrapper(name);

      await loggingTo(tool.dir, async () => {
        expect(await execCommandAsync(name, ['ok', payload], tool.opts)).toBeNull();
        expect(lines(await execCommandAsync(name, ['ok'], tool.opts))).toEqual(['0=<ok>']);
        expect(await execCommandAsync(name, [payload], tool.opts)).toBeNull();
        expect(await execCommandJSONAsync(name, [payload], tool.opts)).toBeNull();
      });

      expect(fs.existsSync(tool.strayFile)).toBe(false);
      expect(tool.log()).toContain(name);
      expect(tool.log()).toContain('cmd.exe');
    });
  });

  // Stopping cmd.exe alone left the program behind the wrapper running.
  it('stops the program behind a .cmd wrapper when its time is up', async ({ skip }) => {
    skip(!onWindows, ONLY_WINDOWS);
    const tool = hangingWrapper('cp-hang-async');
    let pid = null;
    try {
      expect(await loggingTo(tool.dir, () => execCommandAsync('cp-hang-async', [], tool.opts))).toBeNull();
      pid = tool.pid();
      expect(pid, 'the program never started, so nothing was tested').not.toBeNull();
      expect(await goneWithin(pid, 3000)).toBe(true);
    } finally {
      reap(pid || tool.pid());
    }
  });

  // The first call learns that the name is a wrapper; the second goes to
  // cmd.exe straight away.
  it('goes straight to cmd.exe for a wrapper it already knows', async ({ skip }) => {
    skip(!onWindows, ONLY_WINDOWS);
    const opts = asyncWrapper('cp-async-twice');

    const first = await execCommandAsync('cp-async-twice', ['one', 'a^b'], opts);
    const second = await execCommandAsync('cp-async-twice', ['two words', 'x&&echo PWNED'], opts);

    expect(lines(first)).toEqual(['0=<one>', '1=<a^b>']);
    expect(lines(second)).toEqual(['0=<two words>', '1=<x&&echo PWNED>']);
  });

  // Behind a wrapper (a .cmd, or npm's bd launcher) the program runs as a
  // grandchild and outlives the wrapper when that is stopped. Neither the
  // answer nor this process may wait for it.
  it('gives up at the time limit without waiting for the command to finish', () => {
    const dir = asyncTempDir('hu-async-slow-');
    const sleeper = path.join(dir, 'sleep.js');
    fs.writeFileSync(sleeper, 'setTimeout(() => {}, 8000);\n');
    // What npm's bd launcher does: start the real program as its own child.
    const launcher = path.join(dir, 'launch.js');
    fs.writeFileSync(launcher, `require('child_process').spawn(process.execPath, `
      + `[${JSON.stringify(sleeper)}], { stdio: 'inherit' });`);
    let call = [process.execPath, [launcher]];
    if (onWindows) {
      fs.writeFileSync(path.join(dir, 'cp-sleeper.cmd'), `@"${process.execPath}" "${sleeper}"\r\n`);
      call = ['cp-sleeper', []];
    }
    const script = `require(${JSON.stringify(utilsPath)})`
      + `.execCommandAsync(${JSON.stringify(call[0])}, ${JSON.stringify(call[1])}, { timeout: 500 })`
      + '.then(out => process.stdout.write(String(out)));';

    const started = Date.now();
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH },
    });

    expect(result.stdout).toBe('null');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  // execFile reports a program stopped at its time limit as a success with no
  // output when the program had in fact finished, but this process was too
  // busy to read its answer before the limit. An empty answer is not "no
  // answer".
  it('gives null, not an empty answer, when the answer is read only after the time limit', () => {
    const script = `const u = require(${JSON.stringify(utilsPath)});`
      + `u.execCommandAsync(process.execPath, ['-e', 'console.log("[1]")'], { timeout: 500 })`
      + '.then(out => process.stdout.write(JSON.stringify(out)));'
      + 'const busyUntil = Date.now() + 2000; while (Date.now() < busyUntil) {}';

    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });

    expect(result.stdout).toBe('null');
  });
});

describe('runHook with an asynchronous body', () => {
  /** Run a body under runHook in its own process, with its error log. */
  function runBody(body) {
    const project = asyncTempDir('hu-async-hook-');
    const script = `require(${JSON.stringify(utilsPath)}).runHook('probe', ${body});`;
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: '', CLAUDE_CONFIG_DIR: project },
    });
    const log = path.join(project, 'beads_orchestrator_errors.log');
    return { ...result, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
  }

  it('logs a rejection the way it logs a throw, and exits 0', () => {
    const result = runBody('async () => { await null; throw new Error("async boom"); }');

    expect(result.status).toBe(0);
    expect(result.log).toContain('[probe]');
    expect(result.log).toContain('async boom');
  });

  it('lets the body finish writing before the process ends', () => {
    const result = runBody(
      'async () => { await new Promise(r => setTimeout(r, 300)); process.stdout.write("LATE"); }');

    expect(result.stdout).toBe('LATE');
    expect(result.log).toBe('');
  });
});
