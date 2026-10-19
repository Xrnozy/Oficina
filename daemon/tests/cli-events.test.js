// CLI output → readable activity: only what the CLI reports, technical
// records kept apart, lines split across chunks reassembled.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CliStream, parseCliLine } from '../src/adapters/cli-events.ts';

const j = (o) => JSON.stringify(o);

test('Claude Code stream-json: text, tool calls, tool results, todos, result', () => {
  const assistant = j({ type: 'assistant', message: { content: [
    { type: 'text', text: 'I will add the flag.' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/cli.ts' } },
    { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'src/cli.ts', old_string: 'a', new_string: 'b' } },
    { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } },
    { type: 'tool_use', id: 't4', name: 'TodoWrite', input: { todos: [{ content: 'Add flag', status: 'completed' }, { content: 'Docs', status: 'pending' }] } },
  ] } });
  const items = parseCliLine(assistant);
  assert.deepEqual(items.map((i) => i.kind), ['message', 'tool', 'tool', 'tool', 'todo']);
  assert.equal(items[1].op, 'read'); assert.equal(items[1].file, 'src/cli.ts');
  assert.equal(items[2].op, 'edit');
  assert.equal(items[3].op, 'command'); assert.equal(items[3].command, 'npm test'); assert.equal(items[3].text, 'Run the tests');
  assert.deepEqual(items[4].todos, [{ text: 'Add flag', status: 'completed' }, { text: 'Docs', status: 'pending' }]);
  const res = parseCliLine(j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: '1 failing', is_error: true }] } }));
  assert.equal(res[0].kind, 'tool-result'); assert.equal(res[0].ok, false); assert.equal(res[0].callId, 't3'); assert.equal(res[0].detail, '1 failing');
  const done = parseCliLine(j({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0.12, num_turns: 4, usage: { input_tokens: 10, output_tokens: 5 } }));
  assert.equal(done[0].kind, 'result'); assert.equal(done[0].costUsd, 0.12); assert.match(done[0].text, /4 turns/);
});

test('thinking is shown only when the CLI provides its text', () => {
  assert.equal(parseCliLine(j({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Check the parser first.' }] } }))[0].kind, 'reasoning');
  assert.deepEqual(parseCliLine(j({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } })), []);
});

test('technical records stay out of the main view', () => {
  for (const line of [j({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' }), j({ type: 'rate_limit_event', info: {} }), j({ type: 'stream_event' })]) {
    assert.equal(parseCliLine(line)[0].kind, 'technical', line);
  }
  assert.equal(parseCliLine(j({ type: 'system', subtype: 'init', session_id: 's1' }))[0].sessionId, 's1');
});

test('cursor-agent tool_call started/completed', () => {
  const start = parseCliLine(j({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'npm run build' } } } }));
  assert.equal(start[0].kind, 'tool'); assert.equal(start[0].op, 'command'); assert.equal(start[0].command, 'npm run build');
  const end = parseCliLine(j({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'npm run build' }, result: { success: { stdout: 'built' } } } } }));
  assert.equal(end[0].kind, 'tool-result'); assert.equal(end[0].ok, true); assert.equal(end[0].detail, 'built');
  const edit = parseCliLine(j({ type: 'tool_call', subtype: 'started', call_id: 'c2', tool_call: { editToolCall: { args: { path: 'a.ts' } } } }));
  assert.equal(edit[0].op, 'edit'); assert.equal(edit[0].file, 'a.ts');
});

test('plain-text CLIs (e.g. Devin) show their lines as messages; errors are flagged', () => {
  assert.deepEqual(parseCliLine('Editing src/app.ts'), [{ kind: 'message', text: 'Editing src/app.ts' }]);
  assert.equal(parseCliLine(j({ type: 'result', is_error: true, result: 'auth failed' }))[0].kind, 'error');
});

test('lines split across chunks are reassembled', () => {
  const s = new CliStream();
  const line = j({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } });
  assert.deepEqual(s.push(line.slice(0, 20)), []);
  const out = s.push(`${line.slice(20)}\nnext`);
  assert.equal(out.length, 1); assert.equal(out[0].text, 'hello');
  assert.deepEqual(s.flush(), [{ kind: 'message', text: 'next' }]);
});
