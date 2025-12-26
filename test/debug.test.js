import assert from 'node:assert/strict';
import test from 'node:test';

import { buildUpstreamCurl, buildUpstreamUrl, buildProxyCurl, maskApiKey } from '../src/lib/debug.js';

test('maskApiKey: empty', () => {
	assert.equal(maskApiKey(''), '');
	assert.equal(maskApiKey('   '), '');
});

test('maskApiKey: short', () => {
	assert.equal(maskApiKey('abcd'), '***');
});

test('maskApiKey: long', () => {
	assert.equal(maskApiKey('sk-1234567890'), 'sk…7890');
});

test('buildUpstreamUrl: openai', () => {
	assert.equal(buildUpstreamUrl('openai', 'https://api.openai.com'), 'https://api.openai.com/v1/chat/completions');
	assert.equal(buildUpstreamUrl('openai', 'https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/chat/completions');
});

test('buildUpstreamUrl: anthropic', () => {
	assert.equal(buildUpstreamUrl('anthropic', 'https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
	assert.equal(buildUpstreamUrl('anthropic', 'https://example.com/v1'), 'https://example.com/v1/messages');
});

test('buildProxyCurl: defaults to placeholder key', () => {
	const curl = buildProxyCurl({
		origin: 'https://site.example',
		payload: { provider: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'sk-secret', request: { model: 'x' } }
	});
	assert.ok(curl.includes('/api/chat'));
	assert.ok(curl.includes('YOUR_API_KEY'));
	assert.equal(curl.includes('sk-secret'), false);
});

test('buildUpstreamCurl: openai includes authorization header', () => {
	const curl = buildUpstreamCurl({
		provider: 'openai',
		baseUrl: 'https://api.openai.com',
		apiKey: 'sk-secret',
		request: { model: 'gpt', messages: [], stream: false }
	});
	assert.ok(curl.includes('authorization: Bearer YOUR_API_KEY'));
	assert.ok(curl.includes('accept: text/event-stream'));
	assert.ok(curl.includes('https://api.openai.com/v1/chat/completions'));
});

test('buildUpstreamCurl: anthropic includes version and x-api-key', () => {
	const curl = buildUpstreamCurl({
		provider: 'anthropic',
		baseUrl: 'https://api.anthropic.com',
		apiKey: 'sk-secret',
		anthropicVersion: '2023-06-01',
		request: { model: 'claude', messages: [], stream: false }
	});
	assert.ok(curl.includes('x-api-key: YOUR_API_KEY'));
	assert.ok(curl.includes('anthropic-version: 2023-06-01'));
	assert.ok(curl.includes('https://api.anthropic.com/v1/messages'));
});
