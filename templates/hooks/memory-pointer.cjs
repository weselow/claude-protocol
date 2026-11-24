#!/usr/bin/env node
'use strict';

// SubagentStart: one line telling the agent where the memory is.
//
// An agent does not see the main session's memory. It gets a pointer, not the
// indexes: what a task needs the orchestrator puts in the bead's description
// and comments, which is more precise, and a full index for every agent is up
// to 10,000 characters a start, mostly noise. Nothing at all when there is no
// memory to point at.

const {
  readStdinJSON, getProjectDir, runHook, projectMemoryIndex, sharedMemoryIndex,
} = require('./hook-utils.cjs');

runHook('memory-pointer', () => {
  readStdinJSON();
  const line = memoryLine(projectMemoryIndex(getProjectDir()), sharedMemoryIndex());
  if (!line) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: line },
  }));
});

/** The pointer for whichever indexes exist, or '' for none. */
function memoryLine(project, shared) {
  const where = [
    project && `project memory — ${project}`,
    shared && `shared memory — ${shared}`,
  ].filter(Boolean);
  if (where.length === 0) return '';
  const text = where.join('; ');
  return `${text[0].toUpperCase()}${text.slice(1)}. Stuck on something unclear — look there first.`;
}
