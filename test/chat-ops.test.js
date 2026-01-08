import assert from 'node:assert/strict';
import test from 'node:test';

import { buildForkForRerun, buildForkForRetry } from '../src/lib/chat-ops.js';

function sampleMessages() {
	return [
		{ id: 'u1', role: 'user', content: 'hi', at: 1 },
		{ id: 'a1', role: 'assistant', content: 'hello', at: 2 },
		{ id: 'u2', role: 'user', content: 'question', at: 3 },
		{ id: 'a2', role: 'assistant', content: 'answer', at: 4 }
	];
}

test('buildForkForRerun: returns error when messageId missing', () => {
	const out = buildForkForRerun(sampleMessages(), 'missing', 'x');
	assert.equal(out.ok, false);
});

test('buildForkForRerun: edits target content and auto-runs when last is user', () => {
	const messages = sampleMessages();
	const out = buildForkForRerun(messages, 'u2', 'edited question');
	assert.deepEqual(out, {
		ok: true,
		forkMessages: [
			{ id: 'u1', role: 'user', content: 'hi', at: 1 },
			{ id: 'a1', role: 'assistant', content: 'hello', at: 2 },
			{ id: 'u2', role: 'user', content: 'edited question', at: 3 }
		],
		shouldAutoRun: true
	});
});

test('buildForkForRerun: does not auto-run when last is assistant', () => {
	const out = buildForkForRerun(sampleMessages(), 'a1', 'edited assistant');
	assert.equal(out.ok, true);
	assert.equal(out.shouldAutoRun, false);
	assert.equal(out.forkMessages.length, 2);
	assert.equal(out.forkMessages[1].content, 'edited assistant');
});

test('buildForkForRetry: slices to nearest user before assistant and auto-runs', () => {
	const out = buildForkForRetry(sampleMessages(), 'a2');
	assert.deepEqual(out, {
		ok: true,
		forkMessages: [
			{ id: 'u1', role: 'user', content: 'hi', at: 1 },
			{ id: 'a1', role: 'assistant', content: 'hello', at: 2 },
			{ id: 'u2', role: 'user', content: 'question', at: 3 }
		],
		shouldAutoRun: true
	});
});

test('buildForkForRetry: errors when assistant has no previous user', () => {
	const messages = [
		{ id: 'a1', role: 'assistant', content: 'hello', at: 1 },
		{ id: 'a2', role: 'assistant', content: 'more', at: 2 }
	];
	const out = buildForkForRetry(messages, 'a2');
	assert.equal(out.ok, false);
});

test('chat-ops: does not mutate input messages/objects', () => {
	const messages = sampleMessages();
	const snapshot = structuredClone(messages);

	buildForkForRerun(messages, 'u2', 'edited');
	buildForkForRetry(messages, 'a2');

	assert.deepEqual(messages, snapshot);
});

