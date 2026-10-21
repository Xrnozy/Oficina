// Stopping one agent: its work is cancelled, it and its CLI session are freed, its task goes on hold so the engine does
// not hand it straight back, and the other agents carry on. Work with no task (the planner) pauses the run instead.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stopagent-'));
const { q1, run } = await import('../src/db.ts');
const { stopAgent } = await import('../src/engine/engine.ts');

const status = (table, id) => q1(`SELECT status FROM ${table} WHERE id = ?`, id).status;

function seed() {
  run(`INSERT INTO runs (id, workspace_id, goal, status) VALUES ('run-a','ws','g','running')`);
  run(`INSERT INTO agents (id, name, status) VALUES ('ag-dev','Dev','coding'), ('ag-rev','Rey','reviewing'), ('ag-pm','Ada','planning')`);
  run(`INSERT INTO tasks (id, run_id, title, status) VALUES ('t-dev','run-a','Build it','in-progress'), ('t-rev','run-a','Check it','in-review')`);
  run(`INSERT INTO work_items (id, task_id, run_id, agent_id, kind, status) VALUES ('w-dev','t-dev','run-a','ag-dev','implement','running'), ('w-rev','t-rev','run-a','ag-rev','review','running'), ('w-plan',NULL,'run-a','ag-pm','plan','running')`);
  run(`INSERT INTO cli_sessions (id, preset, agent_id, cwd, busy_item) VALUES ('cs-dev','claude','ag-dev','.','w-dev')`);
}

test('stopping the developer cancels its work, frees it and puts its task on hold; others are untouched', () => {
  seed();
  const r = stopAgent('ag-dev');
  assert.deepEqual(r, { stopped: 1, heldTasks: ['t-dev'], pausedRuns: [] });
  assert.equal(status('work_items', 'w-dev'), 'cancelled');
  assert.equal(status('tasks', 't-dev'), 'held');
  assert.equal(q1(`SELECT status FROM agents WHERE id = 'ag-dev'`).status, 'idle');
  assert.equal(q1(`SELECT busy_item FROM cli_sessions WHERE id = 'cs-dev'`).busy_item, null);
  assert.equal(status('work_items', 'w-rev'), 'running');
  assert.equal(status('tasks', 't-rev'), 'in-review');
  assert.equal(status('runs', 'run-a'), 'running');
});

test('stopping an agent that has nothing running does nothing', () => {
  assert.deepEqual(stopAgent('ag-dev'), { stopped: 0, heldTasks: [], pausedRuns: [] });
});

test('stopping the planner (work with no task) pauses the run', () => {
  const r = stopAgent('ag-pm');
  assert.deepEqual(r, { stopped: 1, heldTasks: [], pausedRuns: ['run-a'] });
  assert.equal(status('work_items', 'w-plan'), 'cancelled');
  assert.equal(status('runs', 'run-a'), 'paused');
  assert.equal(status('work_items', 'w-rev'), 'running');
});
