import { buildUpstreamUrl } from './lib/url.js';
import { corsHeaders } from './lib/cors.js';
import { checkFixedWindowRateLimit, getClientId } from './lib/rate-limit.js';

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

function readEnvString(env, key) {
	const fromEnv = env && typeof env === 'object' ? env[key] : undefined;
	if (typeof fromEnv === 'string') return fromEnv;
	if (fromEnv != null) return String(fromEnv);

	// 本地 dev-proxy：回退到 process.env
	if (typeof process !== 'undefined' && process?.env) {
		const v = process.env[key];
		return typeof v === 'string' ? v : '';
	}

	return '';
}

function readEnvInt(env, key, fallback) {
	const raw = readEnvString(env, key).trim();
	if (!raw) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.floor(n);
}

function normalizeAllowedHostPattern(raw) {
	const p = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
	if (!p) return null;
	if (p.includes('/') || p.includes(':')) return null;

	const host = p.startsWith('*.') ? p.slice(2) : p.startsWith('.') ? p.slice(1) : p;
	if (!host || !host.includes('.')) return null;
	if (!/^[a-z0-9.-]+$/.test(host)) return null;

	return p;
}

function parseAllowedHosts(raw) {
	const s = typeof raw === 'string' ? raw.trim() : '';
	if (!s) return [];

	const out = [];
	for (const part of s.split(',')) {
		const p = normalizeAllowedHostPattern(part);
		if (!p) continue;
		if (!out.includes(p)) out.push(p);
	}

	// 若显式配置了白名单但解析结果为空：直接报错，避免“误以为已加白名单但其实放开”。
	if (s && out.length === 0) throw new Error('上游域名白名单配置无效：EDGEAI_ALLOWED_UPSTREAM_HOSTS 为空或格式不正确');
	return out;
}

function utf8ByteLength(text) {
	const s = typeof text === 'string' ? text : String(text ?? '');
	if (typeof Buffer !== 'undefined') return Buffer.byteLength(s, 'utf8');
	return new TextEncoder().encode(s).length;
}

async function readJsonBody(request, maxBytes) {
	const headers = corsHeaders(request);

	const max = Math.max(0, Math.floor(maxBytes));
	if (max > 0) {
		const lenHeader = request.headers.get('content-length');
		const n = lenHeader ? Number(lenHeader) : NaN;
		if (Number.isFinite(n) && n > max) {
			return { ok: false, response: json({ error: `请求体过大（>${max} bytes）` }, { status: 413, headers }) };
		}
	}

	let text = '';
	try {
		text = await request.text();
	} catch {
		return { ok: false, response: json({ error: '请求体读取失败' }, { status: 400, headers }) };
	}

	if (max > 0) {
		const bytes = utf8ByteLength(text);
		if (bytes > max) return { ok: false, response: json({ error: `请求体过大（>${max} bytes）` }, { status: 413, headers }) };
	}

	try {
		const parsed = JSON.parse(text);
		return { ok: true, payload: parsed };
	} catch {
		return { ok: false, response: json({ error: '请求体必须是 JSON' }, { status: 400, headers }) };
	}
}

export async function handleRequest(request, { fetchFn = fetch, env } = {}) {
	const url = new URL(request.url);

	if (url.pathname === '/api/health') return json({ ok: true, ts: Date.now() }, { headers: corsHeaders(request) });

	if (!url.pathname.startsWith('/api/')) return new Response('Not Found', { status: 404 });

	if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
	if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: corsHeaders(request) });

	if (url.pathname !== '/api/chat') return new Response('Not Found', { status: 404, headers: corsHeaders(request) });

	// 可选：限流（默认关闭）
	const rateLimitPerMinute = readEnvInt(env, 'EDGEAI_RATE_LIMIT_PER_MINUTE', 0);
	if (rateLimitPerMinute > 0) {
		const now = Date.now();
		const key = getClientId(request);
		const out = checkFixedWindowRateLimit({ key, limit: rateLimitPerMinute, windowMs: 60_000, now });
		if (!out.allowed) {
			const retryAfterSeconds = Math.max(1, Math.ceil((out.resetAt - now) / 1000));
			const headers = corsHeaders(request);
			headers.set('retry-after', String(retryAfterSeconds));
			headers.set('x-rate-limit-limit', String(out.limit));
			headers.set('x-rate-limit-remaining', String(out.remaining));
			headers.set('x-rate-limit-reset', String(out.resetAt));

			return json(
				{ error: `请求过于频繁，请在 ${retryAfterSeconds}s 后重试。`, retryAfterSeconds },
				{ status: 429, headers }
			);
		}
	}

	// 可选：请求体大小限制（默认关闭）
	const maxRequestBytes = readEnvInt(env, 'EDGEAI_MAX_REQUEST_BYTES', 0);
	const bodyRes = await readJsonBody(request, maxRequestBytes);
	if (!bodyRes.ok) return bodyRes.response;

	const payload = bodyRes.payload;

	try {
		const allowedHosts = parseAllowedHosts(readEnvString(env, 'EDGEAI_ALLOWED_UPSTREAM_HOSTS'));
		const upstreamTimeoutMs = readEnvInt(env, 'EDGEAI_UPSTREAM_TIMEOUT_MS', 0);

		const provider = sanitizeProvider(payload.provider);
		const baseUrl = requireString(payload, 'baseUrl');
		const apiKey = requireString(payload, 'apiKey');
		const upstreamRequest = requireObject(payload, 'request');

		const upstreamUrl = buildUpstreamUrl({ provider, baseUrl, allowedHosts });
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
				let timeoutTimer = null;
				let timedOut = false;

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

						const timeoutMs = Math.max(0, Math.floor(upstreamTimeoutMs));
						if (timeoutMs > 0) {
							timeoutTimer = setTimeout(() => {
								timedOut = true;
								aborter.abort();
							}, timeoutMs);
						}

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
						const msg = timedOut
							? `上游请求超时（${Math.max(0, Math.floor(upstreamTimeoutMs))}ms）`
							: e instanceof Error
								? e.message
								: String(e);
						sseError(controller, msg, timedOut ? 504 : undefined);
					} finally {
						closed = true;
						if (timeoutTimer) clearTimeout(timeoutTimer);
						clearInterval(keepAliveTimer);
						controller.close();
					}
				})().catch(() => {
					closed = true;
					if (timeoutTimer) clearTimeout(timeoutTimer);
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
		return handleRequest(request, { env });
	}
};
