// @ts-check

/**
 * best-effort 限流（固定窗口计数）。
 *
 * 说明：
 * - 该实现基于“单实例内存 Map”，在边缘/函数环境下可能随实例回收而丢失；
 * - 多实例之间不共享状态，因此不保证全局一致的配额；
 * - 适合做基础防滥用护栏（与 allowlist/同源 CORS 组合使用）。
 */

/** @typedef {{ windowStart: number; count: number }} Bucket */

/** @type {Map<string, Bucket>} */
const buckets = new Map();

let lastCleanupAt = 0;

const DEFAULT_WINDOW_MS = 60_000;
const CLEANUP_INTERVAL_MS = 30_000;
const MAX_BUCKETS = 10_000;

/**
 * @param {string} xff
 */
function firstIpFromXff(xff) {
	const raw = typeof xff === 'string' ? xff : '';
	const first = raw.split(',')[0]?.trim() ?? '';
	return first || null;
}

/**
 * 尝试从常见反代/边缘网关头中提取客户端 IP。
 *
 * @param {Request} request
 * @returns {string | null}
 */
export function getClientIp(request) {
	const h = request?.headers;
	if (!h) return null;

	const cf = h.get('cf-connecting-ip');
	if (cf && cf.trim()) return cf.trim();

	const real = h.get('x-real-ip');
	if (real && real.trim()) return real.trim();

	const client = h.get('x-client-ip');
	if (client && client.trim()) return client.trim();

	const xff = h.get('x-forwarded-for');
	const first = xff ? firstIpFromXff(xff) : null;
	if (first) return first;

	const forwarded = h.get('forwarded');
	if (forwarded && forwarded.includes('for=')) {
		// Forwarded: for=1.2.3.4;proto=https;by=...
		const hit = forwarded.match(/for=([^;,\s]+)/i)?.[1] ?? '';
		const cleaned = hit.replaceAll('"', '').replace(/^\[|\]$/g, '').trim();
		if (cleaned) return cleaned;
	}

	return null;
}

/**
 * @param {Request} request
 * @returns {string}
 */
export function getClientId(request) {
	const ip = getClientIp(request);
	if (ip) return `ip:${ip}`;

	const ua = request?.headers?.get('user-agent') ?? '';
	if (ua) return `ua:${ua.slice(0, 160)}`;

	return 'unknown';
}

/**
 * @param {number} now
 */
function cleanup(now) {
	if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
	lastCleanupAt = now;

	// 简单策略：当桶过多时，丢弃所有（避免内存风险）。该策略在 best-effort 前提下可接受。
	if (buckets.size > MAX_BUCKETS) buckets.clear();
}

/**
 * 固定窗口限流：窗口内 count++，超限返回 notAllowed。
 *
 * @param {{ key: string; limit: number; windowMs?: number; now?: number }} args
 * @returns {{ allowed: boolean; remaining: number; resetAt: number; limit: number }}
 */
export function checkFixedWindowRateLimit({ key, limit, windowMs = DEFAULT_WINDOW_MS, now = Date.now() }) {
	const safeLimit = Math.max(0, Math.floor(limit));
	const safeWindowMs = Math.max(1, Math.floor(windowMs));
	const t = Math.max(0, Math.floor(now));

	cleanup(t);

	const windowStart = Math.floor(t / safeWindowMs) * safeWindowMs;
	const resetAt = windowStart + safeWindowMs;

	if (!key || safeLimit <= 0) {
		return { allowed: true, remaining: 0, resetAt, limit: safeLimit };
	}

	const prev = buckets.get(key);
	const bucket = !prev || prev.windowStart !== windowStart ? { windowStart, count: 0 } : prev;
	bucket.count += 1;
	buckets.set(key, bucket);

	const remaining = Math.max(0, safeLimit - bucket.count);
	const allowed = bucket.count <= safeLimit;

	return { allowed, remaining, resetAt, limit: safeLimit };
}

