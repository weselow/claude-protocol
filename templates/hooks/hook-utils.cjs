/**
 * hook-utils.js — Shared utilities for Claude Code hooks.
 *
 * Replaces bash+jq patterns with cross-platform Node.js equivalents.
 * No external dependencies — only Node.js built-ins.
 *
 * cwd contract: a hook process does NOT run in the project root — it inherits
 * the working directory of the last Bash tool call. Everything path-related
 * here is therefore anchored to getProjectDir(), and hook commands in
 * settings.json resolve this file through CLAUDE_PROJECT_DIR (see the
 * `node -e` wrapper written by bootstrap.py) instead of a relative path.
 */

'use strict';

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Module-level permission mode — set by readStdinJSON(), read by deny()/ask()
let _permissionMode = '';

// The oldest beads CLI the rules work against: they call bd memories, bd
// remember, bd worktree and bd prime. Keep in sync with BD_MIN_VERSION in
// bootstrap.py — a test asserts the two agree, because two copies of a
// constant in two languages drift silently.
const BD_MIN_VERSION = '1.1.0';

// ---------------------------------------------------------------------------
// Stdin
// ---------------------------------------------------------------------------

/**
 * Read all of stdin and parse as JSON.
 * Returns empty object on failure (hooks should fail open).
 */
function readStdinJSON() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const parsed = JSON.parse(raw);
    _permissionMode = parsed.permission_mode || '';
    return parsed;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Field access
// ---------------------------------------------------------------------------

/**
 * Safe nested property access via dot-path.
 *   getField(obj, 'tool_input.prompt') → obj.tool_input.prompt || ''
 */
function getField(obj, dotPath) {
  const parts = dotPath.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return '';
    cur = cur[p];
  }
  return cur == null ? '' : cur;
}

// ---------------------------------------------------------------------------
// Output helpers (PreToolUse)
// ---------------------------------------------------------------------------

function deny(reason) {
  // In bypass mode (--dangerously-skip-permissions), convert deny to warning
  if (_permissionMode === 'bypassPermissions') {
    process.stdout.write(`[HOOK WARNING — would deny] ${reason}\n`);
    process.exit(0);
  }
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

function ask(reason) {
  // In bypass mode, skip ask entirely (allow the action)
  if (_permissionMode === 'bypassPermissions') process.exit(0);
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Output helpers (SubagentStop)
// ---------------------------------------------------------------------------

function approve() {
  process.stdout.write('{"decision":"approve"}');
  process.exit(0);
}

function block(reason) {
  // Blocks in every permission mode, bypassPermissions included. Unlike
  // deny(), there is no warning to fall back to: a SubagentStop hook that
  // exits 0 with plain text is never seen by the model — the text lands in the
  // subagent's transcript after it has finished. Measured: 266 such warnings,
  // not one of them read.
  const out = { decision: 'block', reason };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Output helpers (plain text — SessionStart, UserPromptSubmit, PreCompact)
// ---------------------------------------------------------------------------

function injectText(text) {
  process.stdout.write(text);
}

// ---------------------------------------------------------------------------
// External CLI
// ---------------------------------------------------------------------------

// Programs that turned out to be .cmd/.bat wrappers, so the direct spawn is
// known to fail for them. A single hook run calls the same tool several times;
// remember the answer instead of paying for a doomed spawn every time.
const _needsCmdExe = new Set();

// The characters known to get past quoteForCmdExe. An argument holding one is
// not sent at all. bd and gh never need them. git's format strings do
// need '%', so a git that is itself a .cmd/.bat wrapper (depot_tools puts one
// first on PATH) gets null for those calls; a real git.exe is started
// directly and never comes this way.
const NOT_FOR_CMD_EXE = /["%!\r\n\0]/;

// Windows looks for a program named without a path in the current directory
// first — the project root here — unless this variable is set. Claude Code
// sets it; a hook started any other way may not have it.
const NO_CWD_SEARCH = 'NoDefaultCurrentDirectoryInExePath';

// What settle answers for a command that was not sent to cmd.exe.
const REFUSED = Object.freeze({ error: new Error('not safe to pass through cmd.exe'), stdout: null });

// taskkill answers in about 150 ms; this is for a machine under load.
const TASKKILL_TIMEOUT_MS = 3000;

// How long settleSync waits for its worker beyond the command's own limit:
// long enough for the worker to start and for taskkill to finish.
const WORKER_GRACE_MS = TASKKILL_TIMEOUT_MS + 2000;

/**
 * Quote one argument for `cmd.exe`. Letting Node do it is not enough: Node
 * quotes an argument only when it contains whitespace, so `x&&whoami` arrives
 * bare and cmd.exe runs it as a second command (measured — an argument built
 * that way really did create a file). Inside double quotes cmd.exe treats
 * `&`, `|`, `<`, `>` and `^` as ordinary characters, and the callee's C
 * runtime strips the quotes again, so the program sees what the caller wrote.
 *
 * That holds only for an argument free of NOT_FOR_CMD_EXE, and only with
 * delayed expansion off — viaCmdExe sees to both.
 */
function quoteForCmdExe(arg) {
  // With no quote inside, a backslash matters only in front of the closing
  // quote, so the trailing run is doubled.
  return `"${String(arg).replace(/(\\*)$/, '$1$1')}"`;
}

/**
 * The cmd.exe call that runs a command — the only way to reach a .cmd/.bat
 * wrapper — as [file, args, options]; or null, logged, when an argument holds
 * a character cmd.exe cannot carry.
 */
function viaCmdExe(cmd, args, options) {
  const unsafe = [cmd, ...args].map(String).find(arg => NOT_FOR_CMD_EXE.test(arg));
  if (unsafe !== undefined) {
    logError('hook-utils', `not run through cmd.exe: ${JSON.stringify(String(cmd))} was given `
      + `an argument holding ", %, !, CR, LF or NUL: ${JSON.stringify(unsafe).slice(0, 200)}`);
    return null;
  }
  // `/d` skips AutoRun commands, and `/v:off` switches off delayed expansion,
  // which the registry can switch on for every cmd.exe. `/s` makes cmd.exe
  // strip exactly the outermost pair of quotes and take the rest literally,
  // which is why the whole command goes inside one more pair.
  // windowsVerbatimArguments stops Node from re-quoting what is already quoted.
  const line = [cmd, ...args].map(quoteForCmdExe).join(' ');
  return [system32('cmd.exe'), ['/d', '/v:off', '/s', '/c', `"${line}"`], {
    ...options,
    windowsVerbatimArguments: true,
  }];
}

/** A program of Windows itself, by full path: never one found by its name. */
function system32(name) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', name);
}

/**
 * The environment for a command on Windows: `env`, or this process's when
 * none is given, with NO_CWD_SEARCH set. Node reads the variable from this
 * process's own environment when it looks a name up (measured: the child's
 * does not count), cmd.exe from the one it is given — so it goes into both.
 */
function withoutCwdSearch(env) {
  process.env[NO_CWD_SEARCH] = '1';
  const result = {};
  for (const [key, value] of Object.entries(env || process.env)) {
    if (key.toUpperCase() !== NO_CWD_SEARCH.toUpperCase()) result[key] = value;
  }
  result[NO_CWD_SEARCH] = '1';
  return result;
}

/** Run a command through cmd.exe: a promise of settle's { error, stdout }. */
function settleViaCmdExe(cmd, args, options) {
  const call = viaCmdExe(cmd, args, options);
  return call ? settle(...call) : Promise.resolve(REFUSED);
}

/** settleViaCmdExe, waited for. */
function settleViaCmdExeSync(cmd, args, options) {
  const call = viaCmdExe(cmd, args, options);
  return call ? settleSync(call) : REFUSED;
}

/**
 * True when Windows refused to start a program directly. ENOENT/EINVAL here
 * means either "no such program" or "this program is a wrapper script". Only
 * the second is recoverable, and the two are indistinguishable, so the caller
 * retries through cmd.exe: a genuinely missing program fails again.
 */
function spawnRefused(err) {
  return process.platform === 'win32' &&
    (err.code === 'ENOENT' || err.code === 'EINVAL');
}

/** The options every external command runs with (see execCommand). */
function commandOptions(opts) {
  const options = {
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Anchor to the project root, not the hook's inherited cwd. Without
    // this, git/bd/gh answer about whatever directory the Bash tool last
    // used — a worktree, a subdirectory, or a path outside the repo — and
    // every check built on the answer silently passes. Callers may still
    // override via opts.cwd.
    cwd: getProjectDir(),
    ...opts,
  };
  if (process.platform === 'win32') options.env = withoutCwdSearch(options.env);
  return options;
}

/** JSON.parse that answers null instead of throwing, and null for null. */
function parseJSONOrNull(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Run an external command and return trimmed stdout, or `null` on failure.
 *
 * No shell, ever. An args array combined with `shell: true` is NOT escaped —
 * Node concatenates it into one command line (that is what DEP0190 warns
 * about). Measured on Windows: a space splits one argument into two, quotes
 * are stripped, `^` disappears, `%VAR%` expands, and `&&`, `|`, `>` are
 * executed by the shell. It also breaks ordinary use: `git -C "C:\Users\Ivan
 * Petrov\repo" status` falls apart on the space, execCommand returns null, and
 * every check built on the answer silently passes.
 *
 * Windows still needs a shell for one case: `.cmd`/`.bat` wrappers (bd and gh
 * installed through npm) cannot be spawned directly at all — Node refuses with
 * EINVAL for a full path and ENOENT for a bare name. Those go through
 * `cmd.exe` with arguments quoted by quoteForCmdExe above; an argument with
 * a character known to get past that quoting gets null without being sent.
 * On Windows a program is never looked for in the project directory first
 * (see withoutCwdSearch).
 *
 * @param {string}   cmd   - Executable name (e.g. 'git', 'bd', 'gh')
 * @param {string[]} args  - Argument array
 * @param {object}   [opts] - Extra execFileSync options (cwd, env, etc.)
 * @returns {string|null}
 */
function execCommand(cmd, args, opts) {
  const options = commandOptions(opts);
  if (_needsCmdExe.has(cmd)) return settleViaCmdExeSync(cmd, args, options).stdout;
  try {
    return execFileSync(cmd, args, options).trim();
  } catch (err) {
    if (!spawnRefused(err)) return null;
  }
  const viaShim = settleViaCmdExeSync(cmd, args, options);
  if (!viaShim.error) _needsCmdExe.add(cmd);
  return viaShim.stdout;
}

/**
 * Run a command and parse its stdout as JSON, or return `null` on failure.
 */
function execCommandJSON(cmd, args, opts) {
  return parseJSONOrNull(execCommand(cmd, args, opts));
}

/**
 * execCommand for commands that should run side by side: the same options,
 * the same wrapper handling, and a promise of trimmed stdout or `null`. It
 * never rejects.
 */
async function execCommandAsync(cmd, args, opts) {
  const options = commandOptions(opts);
  if (_needsCmdExe.has(cmd)) return (await settleViaCmdExe(cmd, args, options)).stdout;

  const direct = await settle(cmd, args, options);
  // Another call may have learned meanwhile that this is a wrapper; the
  // retry is right either way.
  if (!direct.error || !spawnRefused(direct.error)) return direct.stdout;
  const viaShim = await settleViaCmdExe(cmd, args, options);
  if (!viaShim.error) _needsCmdExe.add(cmd);
  return viaShim.stdout;
}

/** execCommandAsync, with stdout parsed as JSON; `null` on any failure. */
async function execCommandJSONAsync(cmd, args, opts) {
  return parseJSONOrNull(await execCommandAsync(cmd, args, opts));
}

/**
 * Start a program and resolve with { error, stdout } once it is done or its
 * time is up.
 *
 * The time limit is kept here, not left to execFile. When this process is too
 * busy to read an answer before the limit, execFile stops a program that has
 * already finished and reports success with empty output — an answer lost
 * would read as an empty one. Here the limit always ends in an error.
 */
function settle(file, args, options) {
  return new Promise((resolve) => {
    let timer = null;
    const finish = (error, stdout) => {
      clearTimeout(timer);
      resolve({ error, stdout: error ? null : String(stdout).trim() });
    };
    let child;
    try {
      child = execFile(file, args, { ...options, timeout: 0 }, finish);
    } catch (err) {
      // A .cmd started directly is refused on the spot (EINVAL), not later.
      finish(err);
      return;
    }
    // 0 is no limit, as it is for execFileSync.
    if (options.timeout > 0) {
      timer = setTimeout(() => {
        stopChild(child);
        finish(new Error(`${file}: no answer within ${options.timeout} ms`));
      }, options.timeout);
    }
    // Nothing is ever written to it; closing it at once is what execFileSync
    // does too. A program that is already gone can make that close fail with
    // EPIPE, which says nothing about the answer.
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

/**
 * settle, waited for: [file, args, options] run on a worker thread while this
 * thread blocks, with the same { error, stdout } as the answer.
 *
 * execFileSync would be simpler, but at its time limit it stops only the
 * process it started. For a .cmd wrapper that is cmd.exe, and the program
 * behind it ran on — a hanging bd left one more process behind at every call.
 * settle stops the whole tree, and a worker is how to wait for it without an
 * event loop. That costs about 25 ms a call, next to the 200 ms a call
 * through cmd.exe takes for bd anyway.
 */
function settleSync([file, args, options]) {
  const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');
  const done = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  try {
    new Worker(SETTLE_IN_WORKER, {
      eval: true,
      workerData: { utils: __filename, call: [file, args, options], done, port: port2 },
      transferList: [port2],
    }).unref();
    // The worker keeps the time limit itself; this wait only has to outlast it.
    Atomics.wait(done, 0, 0, options.timeout > 0 ? options.timeout + WORKER_GRACE_MS : undefined);
    const reply = receiveMessageOnPort(port1);
    if (!reply) throw new Error('the worker never answered');
    const { broken, failed, reason, stdout } = reply.message;
    if (broken) throw new Error(`the worker could not run it: ${reason}`);
    return failed ? { error: new Error(reason), stdout: null } : { error: null, stdout };
  } catch (err) {
    // No worker to be had, options it cannot be handed, no answer from it,
    // or a worker that could not run the command.
    logError('hook-utils', `waiting for ${file} on a worker thread failed: ${err.message}`);
    return { error: err, stdout: null };
  } finally {
    port1.close();
  }
}

// The worker's side of settleSync. It answers whatever happens, so the wait
// ends as soon as the command does: `failed` when the command failed,
// `broken` when the worker could not run it at all.
const SETTLE_IN_WORKER = `
const { workerData: { utils, call, done, port } } = require('worker_threads');
Promise.resolve()
  .then(() => require(utils).settle(...call))
  .then(({ error, stdout }) => ({ failed: Boolean(error), reason: error ? String(error.message) : '', stdout }))
  .catch((err) => ({ broken: true, reason: String((err && err.message) || err) }))
  .then((reply) => {
    port.postMessage(reply);
    Atomics.store(done, 0, 1);
    Atomics.notify(done, 0);
  });
`;

/**
 * What execFile does at its own time limit: close the output pipes, then stop
 * the program. Closing them first matters — a program that runs on as a
 * grandchild (behind a .cmd wrapper, or behind npm's bd launcher) keeps them
 * open, and would otherwise keep this process alive.
 */
function stopChild(child) {
  child.stdout.destroy();
  child.stderr.destroy();
  if (process.platform === 'win32') stopTree(child);
  child.kill();
}

/**
 * Stop a Windows process together with everything it started. Stopping the
 * process alone leaves its children running: the program behind a .cmd
 * wrapper is cmd.exe's child. taskkill /T finds the children through their
 * parent, so it runs before child.kill(), while the parent is still there.
 * It is waited for: Node stops its own children when it exits, and a hook
 * may exit right after a time limit — taskkill included.
 */
function stopTree(child) {
  // Once the process has exited, its pid may already name another one.
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    execFileSync(system32('taskkill.exe'), ['/T', '/F', '/PID', String(child.pid)], {
      stdio: 'ignore', timeout: TASKKILL_TIMEOUT_MS, windowsHide: true,
    });
  } catch (err) {
    // 128 is "not found": the program finished just as its time ran out.
    if (err.status === 128) return;
    logError('hook-utils', `taskkill could not stop the process tree of ${child.spawnfile} `
      + `(pid ${child.pid}): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// beads version
// ---------------------------------------------------------------------------

/**
 * First dotted version in `bd version` output: 'bd version 1.1.0 (...)'.
 * Returns null when the text holds none.
 */
function parseBdVersion(text) {
  if (!text) return null;
  const match = /\d+\.\d+\.\d+/.exec(text);
  return match ? match[0] : null;
}

/**
 * True when `current` is older than `minimum`.
 *
 * Anything unreadable is false: a version we cannot parse is not evidence of
 * an old one, and a false alarm on every session start is worse than silence.
 */
function versionBelow(current, minimum) {
  const parts = (v) => String(v).split('.').map(Number);
  const a = parts(current);
  const b = parts(minimum);
  if (a.length !== 3 || a.some(Number.isNaN)) return false;
  if (b.length !== 3 || b.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

// ---------------------------------------------------------------------------
// Our own version
// ---------------------------------------------------------------------------

/**
 * The version of claude-protocol this project is running, or null.
 *
 * Two installs, two places to look. As a plugin the version is the plugin's
 * own manifest. Installed with npx, bootstrap records it in the project's
 * .claude/.manifest.json, which is the only record of it there.
 */
function readOwnVersion() {
  const file = isPluginInstall()
    ? path.join(process.env.CLAUDE_PLUGIN_ROOT, '.claude-plugin', 'plugin.json')
    : path.join(getProjectDir(), '.claude', '.manifest.json');
  try {
    const version = JSON.parse(fs.readFileSync(file, 'utf8')).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/**
 * The lines to print when a newer version is out, or null when it is not.
 *
 * The two installs are updated differently, and the plugin path needs the part
 * people do not expect: auto-update is off by default for a third-party
 * marketplace, so nothing arrives until someone turns it on.
 */
function updateNotice(current, latest, fromPlugin) {
  if (!versionBelow(current, latest)) return null;
  return [
    `claude-protocol ${current} is behind ${latest}.`,
    fromPlugin
      ? '   Update it in /plugin → Marketplaces → claude-protocol. Auto-update is'
        + ' off by default for third-party marketplaces — turn it on there too.'
      : '   Update it with: npx claude-protocol@latest upgrade',
    '',
  ];
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function getRepoRoot() {
  return execCommand('git', ['rev-parse', '--show-toplevel']);
}

function getCurrentBranch() {
  return execCommand('git', ['branch', '--show-current']) || '';
}

// ---------------------------------------------------------------------------
// Project helpers
// ---------------------------------------------------------------------------

/**
 * Absolute path of the project root.
 *
 * NEVER resolve project paths from process.cwd() alone: a hook process
 * inherits the working directory of the last Bash tool call, so it drifts
 * into subdirectories and worktrees (measured — hook cwd == Bash tool cwd).
 * Resolution order:
 *   1. CLAUDE_PROJECT_DIR — set by Claude Code for hook processes (measured).
 *   2. <this file>/../.. — hooks always live in <project>/.claude/hooks/.
 *   3. process.cwd() — last resort.
 */
function getProjectDir() {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv) return fromEnv;
  // Walking up from __dirname is only meaningful for the copy installed under
  // a project's .claude/hooks/. Started from the plugin, this file lives in the
  // plugin's own checkout — which has a .claude/ and a .beads/ of its own, so
  // the guess would answer with the plugin instead of the project being worked
  // on, and every check built on the answer would be about the wrong place.
  if (!isPluginInstall()) {
    const fromHere = path.resolve(__dirname, '..', '..');
    if (fs.existsSync(path.join(fromHere, '.claude'))) return fromHere;
  }
  return process.cwd();
}

/** True when this hook was started by the plugin, not by a copy in a project. */
function isPluginInstall() {
  return Boolean(process.env.CLAUDE_PLUGIN_ROOT);
}

/** Claude Code's own record of which plugins are installed, and where. */
function pluginRegistryPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'plugins', 'installed_plugins.json');
}

/** The same directory, however either side happened to spell it. */
function samePath(a, b) {
  const tidy = (p) => {
    if (!p) return null;
    const trimmed = String(p).replace(/[\\/]+$/, '');
    // A relative path has no meaning here. Resolving it would use this
    // process's working directory, which for a hook is wherever the last Bash
    // call happened to leave it — an answer invented out of nothing.
    if (!path.isAbsolute(trimmed)) return null;
    let resolved = path.resolve(trimmed);
    try {
      // Follows symlinks and expands Windows short names, so /tmp and
      // /private/tmp are one directory. Only possible for a path that exists;
      // for one that does not, the text is the best there is.
      resolved = fs.realpathSync.native(resolved);
    } catch { /* not on disk — compare what was written */ }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const left = tidy(a);
  return left !== null && left === tidy(b);
}

/**
 * True when settings anywhere switch the plugin off.
 *
 * A plugin can be installed and disabled, and standing down for one that never
 * runs leaves the project with no hooks and nothing said about it. An explicit
 * false therefore outranks the registry. Absence is not a false: a
 * project-scope install writes no enabledPlugins entry at all.
 */
function pluginSwitchedOff(projectDir) {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const files = [
    path.join(dir, 'settings.json'),
    path.join(projectDir, '.claude', 'settings.json'),
    path.join(projectDir, '.claude', 'settings.local.json'),
  ];
  for (const file of files) {
    let enabled;
    try {
      enabled = JSON.parse(fs.readFileSync(file, 'utf8')).enabledPlugins;
    } catch {
      continue; // Absent or unreadable settings say nothing either way.
    }
    if (!enabled || typeof enabled !== 'object') continue;
    for (const [name, on] of Object.entries(enabled)) {
      if (name.split('@')[0] === 'claude-protocol' && on === false) return true;
    }
  }
  return false;
}

/**
 * True when the registry says claude-protocol is the plugin supplying hooks
 * here: installed at user scope, which covers every project, or at project
 * scope naming this one.
 *
 * Both install routes wire the same three hooks and Claude Code merges hooks
 * from every source, so a project carrying both fires each one twice. This is
 * how the copy installed under a project knows to stand down.
 *
 * Missing, unreadable or a shape we do not recognise all answer false. A copy
 * that stands down on a guess enforces nothing and says nothing about it,
 * which is the worse of the two failures by far.
 */
function pluginActiveHere(projectDir) {
  const here = projectDir || getProjectDir();
  // The registry first, and the settings only if it says yes: this runs before
  // every hook, and on the overwhelmingly common machine with no such plugin
  // installed that is one missing file instead of four.
  if (!registrySaysActive(here)) return false;
  return !pluginSwitchedOff(here);
}

// Everything the plugin supplies. A project that wires any of these in its own
// settings was installed from npx before the plugin arrived.
const PLUGIN_PROVIDED_HOOKS = [
  'bash-guard.cjs', 'validate-completion.cjs', 'session-start.cjs',
  'update-check.cjs',
];

/**
 * Which of our hooks a project still wires up itself, by file name.
 *
 * The project copy stands down on its own and says nothing, which is only
 * explainable because the plugin can say the leftovers are there. Named after
 * the file rather than the path: the installer writes the hook command as a
 * `node -e` wrapper that passes the file name as an argument, so the path
 * never appears whole.
 */
function leftoverProjectHooks(projectDir) {
  const found = new Set();
  for (const name of ('settings.json settings.local.json').split(' ')) {
    let hooks;
    try {
      hooks = JSON.parse(
        fs.readFileSync(path.join(projectDir, '.claude', name), 'utf8')).hooks;
    } catch {
      continue; // Absent or unreadable settings wire nothing we can see.
    }
    if (!hooks || typeof hooks !== 'object') continue;
    for (const groups of Object.values(hooks)) {
      for (const group of (Array.isArray(groups) ? groups : [])) {
        for (const hook of (group && Array.isArray(group.hooks) ? group.hooks : [])) {
          const command = String((hook && hook.command) || '');
          for (const provided of PLUGIN_PROVIDED_HOOKS) {
            if (command.includes(provided)) found.add(provided);
          }
        }
      }
    }
  }
  return PLUGIN_PROVIDED_HOOKS.filter(name => found.has(name));
}

/** The registry half of pluginActiveHere: installed, and covering this project. */
function registrySaysActive(projectDir) {
  try {
    const registry = JSON.parse(fs.readFileSync(pluginRegistryPath(), 'utf8'));
    const plugins = registry && registry.plugins;
    if (!plugins || typeof plugins !== 'object') return false;
    for (const [name, entries] of Object.entries(plugins)) {
      if (name.split('@')[0] !== 'claude-protocol') continue;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.scope === 'user') return true;
        if (entry.scope === 'project'
            && samePath(entry.projectPath, projectDir)) return true;
      }
    }
  } catch {
    // No registry, or one we cannot read. Neither is evidence of a plugin.
  }
  return false;
}

/**
 * True when the project being worked on tracks its work in beads.
 *
 * The plugin's hooks run in every project it is enabled for. Everything these
 * hooks enforce — bead lifecycle, worktree isolation, the completion report —
 * is meaningless where there is no .beads/, and refusing `git commit
 * --no-verify` in someone's unrelated repository is not our call to make.
 */
function hasBeads() {
  return fs.existsSync(path.join(getProjectDir(), '.beads'));
}

// ---------------------------------------------------------------------------
// Bead helpers
// ---------------------------------------------------------------------------

/**
 * Extract BEAD_ID from text.  Matches "BEAD_ID: <id>" where id may contain
 * alphanumerics, dots, dashes, underscores.  Returns empty string if not found.
 */
function parseBeadId(text) {
  if (!text) return '';
  const m = text.match(/BEAD_ID:\s*([A-Za-z0-9._-]+)/);
  return m ? m[1] : '';
}

/**
 * Extract EPIC_ID from text (same pattern as BEAD_ID but with EPIC_ID prefix).
 */
function parseEpicId(text) {
  if (!text) return '';
  const m = text.match(/EPIC_ID:\s*([A-Za-z0-9._-]+)/);
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a file path contains a segment, using platform-independent
 * comparison.  Normalises separators to forward slashes before matching.
 *   containsPathSegment('/foo/.worktrees/bd-1/bar.ts', '.worktrees') → true
 */
function containsPathSegment(filePath, segment) {
  if (!filePath) return false;
  const normalised = filePath.replace(/\\/g, '/');
  return normalised.includes('/' + segment + '/') ||
    normalised.endsWith('/' + segment);
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

/**
 * Split a shell command line into the commands a guard must inspect one by one.
 *
 * A guard that looks at the first word of the whole string sees only `cd` in
 * `cd sub && git commit --no-verify` and lets the rest through. Splitting on
 * the chaining operators gives every command its own turn.
 *
 * Quoted text is never split, so `echo "a && b"` stays a single command.
 * Command substitution (`$(...)`, backticks) is deliberately NOT split: doing
 * so would tear flags away from the command they belong to, which loses more
 * checks than it gains.
 *
 *   splitCommandSegments('cd x && git push | tee log')
 *     → ['cd x', 'git push', 'tee log']
 */
function splitCommandSegments(command) {
  if (!command) return [];
  const segments = [];
  let current = '';
  let quote = '';

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);

  return segments.map(s => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Subagent detection
// ---------------------------------------------------------------------------

/**
 * Detect whether the current tool call originates from a subagent.
 * Subagents get full tool access — orchestrator restrictions don't apply.
 *
 * Checks transcript_path + tool_use_id against the subagents directory.
 * Returns false on any error (fail-open: treat as orchestrator).
 */
function isSubagent(input) {
  const transcriptPath = getField(input, 'transcript_path');
  const toolUseId = getField(input, 'tool_use_id');
  if (!transcriptPath || !toolUseId) return false;

  const sessionDir = transcriptPath.replace(/\.jsonl$/, '');
  const subagentsDir = path.join(sessionDir, 'subagents');

  try {
    const files = fs.readdirSync(subagentsDir)
      .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'));
    for (const f of files) {
      const content = fs.readFileSync(path.join(subagentsDir, f), 'utf8');
      if (content.includes(`"id":"${toolUseId}"`)) return true;
    }
  } catch {
    // No subagents dir or read error — treat as orchestrator
  }
  return false;
}

// ---------------------------------------------------------------------------
// Error logging
// ---------------------------------------------------------------------------

const LOG_FILE_NAME = 'beads_orchestrator_errors.log';

/**
 * Append a timestamped error entry to beads_orchestrator_errors.log
 * in the project root.  Never throws — logging failure must not break hooks.
 */
function logError(hookName, err) {
  try {
    const projectDir = getProjectDir();
    const logPath = path.join(projectDir, LOG_FILE_NAME);
    const ts = new Date().toISOString();
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    fs.appendFileSync(logPath, `[${ts}] [${hookName}] ${msg}\n`);
  } catch {
    // Logging must never break the hook
  }
}

/**
 * Wrap a hook's main function with error handling.
 * On unhandled exception: logs to beads_orchestrator_errors.log and exits 0
 * (fail open — hook error should not block the user).
 *
 * The body may be async. Its rejection is handled the same way as a throw;
 * otherwise nothing waits for it here, and the process ends on its own once
 * the body is done and its output written.
 *
 * Usage in each hook file:
 *   const { runHook } = require('./hook-utils.cjs');
 *   runHook('hook-name', () => { ... });
 */
function runHook(hookName, fn) {
  // Both install routes wire the same hooks, and Claude Code merges hooks from
  // every source, so a project carrying both runs each one twice — a doubled
  // `bd prime` alone is ~19KB of context per session. Where the plugin is
  // active it is the one source; the copy installed under the project stands
  // down. Silently: the plugin's session-start says the leftovers are there
  // and what removes them, and one voice saying it is enough.
  if (!isPluginInstall() && pluginActiveHere()) process.exit(0);
  const fail = (err) => {
    logError(hookName, err);
    process.exit(0);
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') result.then(undefined, fail);
  } catch (err) {
    fail(err);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  BD_MIN_VERSION,
  parseBdVersion,
  versionBelow,
  readStdinJSON,
  getField,
  deny,
  ask,
  approve,
  block,
  injectText,
  execCommand,
  execCommandJSON,
  execCommandAsync,
  execCommandJSONAsync,
  // For settleSync's worker thread, which loads this file on its own.
  settle,
  getRepoRoot,
  getCurrentBranch,
  getProjectDir,
  isPluginInstall,
  pluginActiveHere,
  leftoverProjectHooks,
  hasBeads,
  readOwnVersion,
  updateNotice,
  parseBeadId,
  parseEpicId,
  containsPathSegment,
  splitCommandSegments,
  isSubagent,
  logError,
  runHook,
};
