import assert from 'node:assert/strict';
import test from 'node:test';

import { buildUpstreamUrl, validateBaseUrl } from '../functions/lib/url.js';
import { handleRequest } from '../functions/index.js';

test('validateBaseUrl: accepts https origin', () => {
	const url = validateBaseUrl('https://api.openai.com');
	assert.equal(url.origin, 'https://api.openai.com');
});

test('validateBaseUrl: rejects http', () => {
	assert.throws(() => validateBaseUrl('http://api.openai.com'), /https/i);
});

test('validateBaseUrl: rejects non-/v1 path', () => {
	assert.throws(() => validateBaseUrl('https://api.openai.com/v1/chat'), /\/v1/);
});

test('validateBaseUrl: rejects ip', () => {
	assert.throws(() => validateBaseUrl('https://127.0.0.1'), /IP/);
});

test('buildUpstreamUrl: openai chat completions', () => {
	const url = buildUpstreamUrl({ provider: 'openai', baseUrl: 'https://api.openai.com' });
	assert.equal(url.toString(), 'https://api.openai.com/v1/chat/completions');
});

test('handleRequest: 405 for GET /api/chat', async () => {
	const res = await handleRequest(new Request('https://example.com/api/chat', { method: 'GET' }));
	assert.equal(res.status, 405);
});

test('handleRequest: 400 for non-json body', async () => {
	const res = await handleRequest(
		new Request('https://example.com/api/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: 'not-json'
		})
	);
	assert.equal(res.status, 400);
});

test('handleRequest: proxies upstream stream (openai)', async () => {
	const seen = { url: null, auth: null };

	const fetchFn = async (url, init) => {
		seen.url = url;
		seen.auth = init?.headers?.get?.('authorization') ?? null;

		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('data: {"ok":true}\\n\\n'));
				controller.close();
			}
		});

		return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
	};

	const res = await handleRequest(
		new Request('https://example.com/api/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: 'https://example.com' },
			body: JSON.stringify({
				provider: 'openai',
				baseUrl: 'https://api.openai.com',
				apiKey: 'test-key',
				request: { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], stream: true }
			})
		}),
		{ fetchFn }
	);

	assert.equal(res.status, 200);
	assert.equal(seen.url, 'https://api.openai.com/v1/chat/completions');
	assert.equal(seen.auth, 'Bearer test-key');

	const text = await res.text();
	assert.match(text, /:\n\n/);
	assert.match(text, /data: \{\"ok\":true\}/);
});
