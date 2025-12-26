// @ts-check

/**
 * 调试面板：纯函数工具（不依赖 DOM，便于 node --test）
 *
 * 说明：
 * - 默认输出必须脱敏（不包含明文 API Key）
 * - “含 key”版本由调用方显式传入 includeKey=true，并在 UI 层二次确认
 */

/**
 * @param {string} key
 */
export function maskApiKey(key) {
	const k = typeof key === 'string' ? key.trim() : '';
	if (!k) return '';
	if (k.length <= 8) return '***';
	return `${k.slice(0, 2)}…${k.slice(-4)}`;
}

/**
 * @param {string} baseUrl
 */
export function normalizeBaseUrl(baseUrl) {
	return (typeof baseUrl === 'string' ? baseUrl : '').trim().replace(/\/+$/, '');
}

/**
 * 与服务端 buildUpstreamUrl 规则保持一致：
 * - baseUrl 允许无路径或以 /v1 结尾
 * - 这里仅做字符串拼接（不做 https/IP/query 的安全校验）
 *
 * @param {string} baseUrl
 */
export function buildApiPrefix(baseUrl) {
	const base = normalizeBaseUrl(baseUrl);
	if (!base) return '';
	return base.endsWith('/v1') ? base : `${base}/v1`;
}

/**
 * @param {'openai' | 'anthropic'} provider
 * @param {string} baseUrl
 */
export function buildUpstreamUrl(provider, baseUrl) {
	const apiPrefix = buildApiPrefix(baseUrl);
	if (!apiPrefix) return '';
	if (provider === 'openai') return `${apiPrefix}/chat/completions`;
	if (provider === 'anthropic') return `${apiPrefix}/messages`;
	return '';
}

/**
 * @param {string} text
 * @param {number} maxLen
 */
export function truncateText(text, maxLen) {
	const s = typeof text === 'string' ? text : String(text ?? '');
	if (s.length <= maxLen) return s;
	return s.slice(0, Math.max(0, maxLen - 1)) + '…';
}

/**
 * @param {any} obj
 */
export function prettyJson(obj) {
	try {
		return JSON.stringify(obj, null, 2);
	} catch {
		return '';
	}
}

/**
 * @param {string} json
 */
function escapeSingleQuotesForBash(json) {
	// bash: 通过关闭单引号，转义，再打开单引号实现嵌入
	return json.replaceAll("'", `'\"'\"'`);
}

/**
 * @param {any} payload
 * @param {boolean} includeKey
 */
export function buildProxyPayload(payload, includeKey) {
	const p = payload && typeof payload === 'object' ? payload : {};
	const apiKey = typeof p.apiKey === 'string' ? p.apiKey : '';
	return {
		...p,
		apiKey: includeKey ? apiKey : apiKey ? 'YOUR_API_KEY' : ''
	};
}

/**
 * @param {{ origin: string; payload: any; includeKey?: boolean }} args
 */
export function buildProxyCurl({ origin, payload, includeKey = false }) {
	const url = `${normalizeBaseUrl(origin)}/api/chat`;
	const body = prettyJson(buildProxyPayload(payload, includeKey)) || '{}';
	const bodyQuoted = `'${escapeSingleQuotesForBash(body)}'`;

	return [
		`curl -N ${url ? `'${url}'` : "'/api/chat'"} \\`,
		`  -H 'content-type: application/json' \\`,
		`  --data ${bodyQuoted}`
	].join('\n');
}

/**
 * @param {{ provider: 'openai' | 'anthropic'; baseUrl: string; apiKey: string; anthropicVersion?: string; request: any; includeKey?: boolean }} args
 */
export function buildUpstreamCurl({ provider, baseUrl, apiKey, anthropicVersion, request, includeKey = false }) {
	const url = buildUpstreamUrl(provider, baseUrl);
	const key = includeKey ? (typeof apiKey === 'string' ? apiKey.trim() : '') : 'YOUR_API_KEY';

	// 与代理一致：强制 stream=true（仅用于复现流式）
	const bodyObj = request && typeof request === 'object' ? { ...request, stream: true } : { stream: true };
	const body = prettyJson(bodyObj) || '{}';
	const bodyQuoted = `'${escapeSingleQuotesForBash(body)}'`;

	/** @type {string[]} */
	const lines = [];
	lines.push(`curl -N ${url ? `'${url}'` : "'https://YOUR_BASE_URL/v1'"} \\`);
	lines.push(`  -H 'content-type: application/json' \\`);
	lines.push(`  -H 'accept: text/event-stream' \\`);

	if (provider === 'openai') {
		lines.push(`  -H 'authorization: Bearer ${key}' \\`);
	} else {
		const v = typeof anthropicVersion === 'string' && anthropicVersion.trim() ? anthropicVersion.trim() : '2023-06-01';
		lines.push(`  -H 'x-api-key: ${key}' \\`);
		lines.push(`  -H 'anthropic-version: ${v}' \\`);
	}

	lines.push(`  --data ${bodyQuoted}`);
	return lines.join('\n');
}
