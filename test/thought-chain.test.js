import assert from 'node:assert/strict';
import test from 'node:test';

import {
	createAnthropicSseContext,
	createThoughtChainSplitter,
	parseAnthropicSseEvent,
	parseOpenAiSseData
} from '../src/lib/thought-chain.js';

test('parseOpenAiSseData: handles [DONE]', () => {
	assert.deepEqual(parseOpenAiSseData('[DONE]'), { done: true, contentDelta: '', thinkingDelta: '' });
});

test('parseOpenAiSseData: extracts content delta', () => {
	const out = parseOpenAiSseData(JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }));
	assert.equal(out.done, false);
	assert.equal(out.contentDelta, 'hi');
	assert.equal(out.thinkingDelta, '');
});

test('parseOpenAiSseData: extracts thinking delta', () => {
	const out = parseOpenAiSseData(JSON.stringify({ choices: [{ delta: { reasoning: 'because' } }] }));
	assert.equal(out.done, false);
	assert.equal(out.contentDelta, '');
	assert.equal(out.thinkingDelta, 'because');
});

test('parseOpenAiSseData: extracts old completions text', () => {
	const out = parseOpenAiSseData(JSON.stringify({ choices: [{ text: 'legacy' }] }));
	assert.equal(out.done, false);
	assert.equal(out.contentDelta, 'legacy');
	assert.equal(out.thinkingDelta, '');
});

test('parseOpenAiSseData: extracts usage', () => {
	const out = parseOpenAiSseData(
		JSON.stringify({
			choices: [{ delta: {} }],
			usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 }
		})
	);
	assert.deepEqual(out.usage, { inputTokens: 12, outputTokens: 34, totalTokens: 46 });
});

test('createThoughtChainSplitter: splits <think> across chunks', () => {
	const splitter = createThoughtChainSplitter();

	let out = splitter.push('Hello <thi');
	assert.equal(out.contentDelta, 'Hello ');
	assert.equal(out.thinkingDelta, '');

	out = splitter.push('nk>reasoning');
	assert.equal(out.contentDelta, '');
	assert.equal(out.thinkingDelta, 'reasoning');

	out = splitter.push('</think> world');
	assert.equal(out.contentDelta, ' world');
	assert.equal(out.thinkingDelta, '');
});

test('createThoughtChainSplitter: keeps partial tag tail only', () => {
	const splitter = createThoughtChainSplitter();

	let out = splitter.push('a<');
	assert.equal(out.contentDelta, 'a');
	assert.equal(out.thinkingDelta, '');

	out = splitter.push('b');
	assert.equal(out.contentDelta, '<b');
	assert.equal(out.thinkingDelta, '');
});

test('parseAnthropicSseEvent: routes deltas by block type', () => {
	const ctx = createAnthropicSseContext();

	parseAnthropicSseEvent(
		{ event: 'content_block_start', id: null, data: JSON.stringify({ index: 0, content_block: { type: 'thinking' } }) },
		ctx
	);
	let out = parseAnthropicSseEvent({ event: 'content_block_delta', id: null, data: JSON.stringify({ index: 0, delta: { thinking: 't' } }) }, ctx);
	assert.equal(out.contentDelta, '');
	assert.equal(out.thinkingDelta, 't');

	parseAnthropicSseEvent(
		{ event: 'content_block_start', id: null, data: JSON.stringify({ index: 1, content_block: { type: 'text' } }) },
		ctx
	);
	out = parseAnthropicSseEvent({ event: 'content_block_delta', id: null, data: JSON.stringify({ index: 1, delta: { text: 'hi' } }) }, ctx);
	assert.equal(out.contentDelta, 'hi');
	assert.equal(out.thinkingDelta, '');
});

test('parseAnthropicSseEvent: extracts usage from message_start', () => {
	const ctx = createAnthropicSseContext();
	const out = parseAnthropicSseEvent(
		{ event: 'message_start', id: null, data: JSON.stringify({ message: { usage: { input_tokens: 9, output_tokens: 0 } } }) },
		ctx
	);
	assert.deepEqual(out.usage, { inputTokens: 9, outputTokens: 0, totalTokens: 9 });
});
