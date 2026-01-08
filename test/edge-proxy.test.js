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

test('validateBaseUrl: allowlist blocks non-matching host', () => {
	assert.throws(() => validateBaseUrl('https://api.openai.com', { allowedHosts: ['example.com'] }), /白名单/);
});

test('validateBaseUrl: allowlist supports wildcard subdomain', () => {
	const url = validateBaseUrl('https://api.openai.com', { allowedHosts: ['*.openai.com'] });
	assert.equal(url.hostname, 'api.openai.com');
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

test('handleRequest: allowlist blocks non-allowed baseUrl', async () => {
	const res = await handleRequest(
		new Request('https://example.com/api/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: 'https://example.com' },
			body: JSON.stringify({
				provider: 'openai',
				baseUrl: 'https://api.openai.com',
				apiKey: 'test-key',
				request: { model: 'gpt-test', messages: [] }
			})
		}),
		{
			env: { EDGEAI_ALLOWED_UPSTREAM_HOSTS: 'example.com' }
		}
	);

	assert.equal(res.status, 400);
	const text = await res.text();
	assert.match(text, /白名单/);
});

test('handleRequest: rate limit returns 429', async () => {
	const fetchFn = async () => {
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('data: {"ok":true}\\n\\n'));
				controller.close();
			}
		});
		return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
	};

	const req = () =>
		new Request('https://example.com/api/chat', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'https://example.com',
				'x-forwarded-for': '1.2.3.4'
			},
			body: JSON.stringify({
				provider: 'openai',
				baseUrl: 'https://api.openai.com',
				apiKey: 'test-key',
				request: { model: 'gpt-test', messages: [] }
			})
		});

	const env = { EDGEAI_RATE_LIMIT_PER_MINUTE: '1' };
	const r1 = await handleRequest(req(), { env, fetchFn });
	assert.equal(r1.status, 200);

	const r2 = await handleRequest(req(), { env, fetchFn });
	assert.equal(r2.status, 429);
});

test('handleRequest: max request bytes returns 413', async () => {
	const big = JSON.stringify({
		provider: 'openai',
		baseUrl: 'https://api.openai.com',
		apiKey: 'test-key',
		request: { model: 'gpt-test', messages: [{ role: 'user', content: 'x'.repeat(200) }] }
	});

	const res = await handleRequest(
		new Request('https://example.com/api/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: 'https://example.com' },
			body: big
		}),
		{ env: { EDGEAI_MAX_REQUEST_BYTES: '100' } }
	);

	assert.equal(res.status, 413);
});

test('handleRequest: upstream timeout emits sse error', async () => {
	const fetchFn = async (url, init) => {
		await new Promise((_, reject) => {
			init.signal.addEventListener('abort', () => reject(new Error('aborted')));
		});
		return new Response(null, { status: 500 });
	};

	const res = await handleRequest(
		new Request('https://example.com/api/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: 'https://example.com' },
			body: JSON.stringify({
				provider: 'openai',
				baseUrl: 'https://api.openai.com',
				apiKey: 'test-key',
				request: { model: 'gpt-test', messages: [] }
			})
		}),
		{ env: { EDGEAI_UPSTREAM_TIMEOUT_MS: '10' }, fetchFn }
	);

	assert.equal(res.status, 200);
	const text = await res.text();
	assert.match(text, /event: error/);
	assert.match(text, /超时/);
});
