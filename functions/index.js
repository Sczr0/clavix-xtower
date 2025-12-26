import { buildUpstreamUrl } from './lib/url.js';
import { corsHeaders } from './lib/cors.js';

function json(body, init = {}) {
	const headers = new Headers(init.headers);
	headers.set('content-type', 'application/json; charset=utf-8');
	return new Response(JSON.stringify(body), { ...init, headers });
}

function sseHeaders(request) {
	const headers = corsHeaders(request);
	headers.set('content-type', 'text/event-stream; charset=utf-8');
	headers.set('cache-control', 'no-store');
	headers.set('x-content-type-options', 'nosniff');
	return headers;
}

function sseError(controller, message, status) {
	const payload = JSON.stringify({ message, status });
	controller.enqueue(new TextEncoder().encode(`event: error\ndata: ${payload}\n\n`));
}

function requireString(obj, key) {
	const value = obj?.[key];
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 不能为空`);
	return value.trim();
}

function requireObject(obj, key) {
	const value = obj?.[key];
	if (!value || typeof value !== 'object') throw new Error(`${key} 必须是对象`);
	return value;
}

function sanitizeProvider(raw) {
	if (raw === 'openai' || raw === 'anthropic') return raw;
	throw new Error('provider 必须是 openai 或 anthropic');
}

function normalizeAnthropicVersion(v) {
	if (!v) return '2023-06-01';
	if (typeof v !== 'string') throw new Error('anthropicVersion 必须是字符串');
	const s = v.trim();
	if (!s) return '2023-06-01';
	return s;
}

export async function handleRequest(request, { fetchFn = fetch } = {}) {
	const url = new URL(request.url);

	if (url.pathname === '/api/health') return json({ ok: true, ts: Date.now() }, { headers: corsHeaders(request) });

	if (!url.pathname.startsWith('/api/')) return new Response('Not Found', { status: 404 });

	if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
	if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: corsHeaders(request) });

	if (url.pathname !== '/api/chat') return new Response('Not Found', { status: 404, headers: corsHeaders(request) });

	let payload;
	try {
		payload = await request.json();
	} catch {
		return json({ error: '请求体必须是 JSON' }, { status: 400, headers: corsHeaders(request) });
	}

	try {
		const provider = sanitizeProvider(payload.provider);
		const baseUrl = requireString(payload, 'baseUrl');
		const apiKey = requireString(payload, 'apiKey');
		const upstreamRequest = requireObject(payload, 'request');

		const upstreamUrl = buildUpstreamUrl({ provider, baseUrl });
		const upstreamHeaders = new Headers();

		upstreamHeaders.set('content-type', 'application/json');
		upstreamHeaders.set('accept', 'text/event-stream');

		if (provider === 'openai') upstreamHeaders.set('authorization', `Bearer ${apiKey}`);
		else {
			upstreamHeaders.set('x-api-key', apiKey);
			upstreamHeaders.set('anthropic-version', normalizeAnthropicVersion(payload.anthropicVersion));
		}

		const aborter = new AbortController();

		const stream = new ReadableStream({
			start(controller) {
				const encoder = new TextEncoder();
				let closed = false;
				let lastSentAt = Date.now();

				const keepAliveTimer = setInterval(() => {
					if (closed) return;
					if (Date.now() - lastSentAt < 8_000) return;
					controller.enqueue(encoder.encode(':\n\n'));
					lastSentAt = Date.now();
				}, 1_000);

				// 立即发一个注释帧，尽量避免“等待首包”超时
				controller.enqueue(encoder.encode(':\n\n'));
				lastSentAt = Date.now();

				(async () => {
					try {
						const upstreamBody =
							typeof upstreamRequest === 'object' && upstreamRequest
								? JSON.stringify({ ...upstreamRequest, stream: true })
								: '{}';

						const upstreamRes = await fetchFn(upstreamUrl.toString(), {
							method: 'POST',
							headers: upstreamHeaders,
							body: upstreamBody,
							signal: aborter.signal
						});

						if (!upstreamRes.ok || !upstreamRes.body) {
							const text = await upstreamRes.text().catch(() => '');
							sseError(controller, text || `上游请求失败（HTTP ${upstreamRes.status}）`, upstreamRes.status);
							return;
						}

						const reader = upstreamRes.body.getReader();
						try {
							while (true) {
								const { value, done } = await reader.read();
								if (done) break;
								if (!value) continue;
								controller.enqueue(value);
								lastSentAt = Date.now();
							}
						} finally {
							reader.releaseLock();
						}
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						sseError(controller, msg);
					} finally {
						closed = true;
						clearInterval(keepAliveTimer);
						controller.close();
					}
				})().catch(() => {
					closed = true;
					clearInterval(keepAliveTimer);
					controller.close();
				});
			},
			cancel() {
				aborter.abort();
			}
		});

		return new Response(stream, { status: 200, headers: sseHeaders(request) });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return json({ error: message }, { status: 400, headers: corsHeaders(request) });
	}
}

if (typeof addEventListener === 'function') {
	addEventListener('fetch', (event) => {
		event.respondWith(handleRequest(event.request));
	});
}

export default {
	fetch(request, env, ctx) {
		return handleRequest(request);
	}
};
