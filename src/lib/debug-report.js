// @ts-check

/**
 * 调试报告（v1）：把前端运行时的 debugSession 变成“可复制/可分享/可导入”的结构化资产。
 *
 * 设计目标：
 * - 默认脱敏：不包含明文 API Key（分享/导出内容可能包含提示词与模型输出，请谨慎分享）
 * - 版本化：kind + v，便于未来迭代格式
 * - 可测试：纯函数，配合 `node --test`（不要依赖 DOM/浏览器 API）
 * - 分享链接：用 URL hash（#debug=...）承载 base64url 编码的 JSON；提供长度阈值与“摘要模式”降级
 */

export const DEBUG_REPORT_KIND = 'edgeai-playground:debug-report';
export const DEBUG_REPORT_VERSION = 1;
export const DEBUG_REPORT_HASH_PREFIX = '#debug=';

const DEFAULT_MAX_SHARE_URL_LEN = 8000;
const DEFAULT_SHARE_MAX_TEXT_LEN = 4000;
const DEFAULT_SHARE_MAX_EVENT_SNIPPET_LEN = 400;
const DEFAULT_SHARE_MAX_EVENTS = 20;

/**
 * @typedef {'openai' | 'anthropic'} Provider
 *
 * @typedef {{
 *   n: number;
 *   at: number;
 *   event: string | null;
 *   id: string | null;
 *   dataLen: number;
 *   dataSnippet: string;
 * }} DebugEvent
 *
 * @typedef {{
 *   startedAt: number;
 *   endedAt: number | null;
 *   aborted: boolean;
 *   provider: Provider;
 *   baseUrl: string;
 *   model: string;
 *   anthropicVersion?: string;
 *   upstreamUrl: string;
 *   proxyStatus: number | null;
 *   proxyOk: boolean | null;
 *   proxyErrorText: string | null;
 *   firstEventAt: number | null;
 *   eventCount: number;
 *   bytesApprox: number;
 *   events: DebugEvent[];
 *   origin: string;
 *   proxyPayloadBase: { provider: Provider; baseUrl: string; anthropicVersion?: string; request: any };
 *   proxyPayloadMaskedJson: string;
 *   upstreamRequestJson: string;
 *   proxyCurl: string;
 *   upstreamCurl: string;
 * }} DebugSession
 *
 * @typedef {{
 *   kind: typeof DEBUG_REPORT_KIND;
 *   v: typeof DEBUG_REPORT_VERSION;
 *   createdAt: number;
 *   mode: 'full' | 'share';
 *   note?: string;
 *   session: DebugSession;
 * }} DebugReportV1
 */

/**
 * @param {unknown} v
 * @param {string} fallback
 */
function safeString(v, fallback) {
	return typeof v === 'string' ? v : fallback;
}

/**
 * @param {unknown} v
 * @param {number} fallback
 */
function safeNumber(v, fallback) {
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {unknown} v
 * @param {boolean} fallback
 */
function safeBoolean(v, fallback) {
	return typeof v === 'boolean' ? v : fallback;
}

/**
 * @param {unknown} v
 * @returns {Provider}
 */
function safeProvider(v) {
	return v === 'anthropic' || v === 'openai' ? v : 'openai';
}

/**
 * @param {string} text
 * @param {number} maxLen
 */
function truncate(text, maxLen) {
	const s = safeString(text, '');
	if (maxLen <= 0) return '';
	if (s.length <= maxLen) return s;
	return s.slice(0, Math.max(0, maxLen - 1)) + '…';
}

/**
 * 分享链接应尽量短：为避免把完整 messages/events 塞进 hash，摘要模式会移除/截断大字段。
 *
 * @param {DebugSession} session
 * @param {{
 *   maxTextLen?: number;
 *   maxEvents?: number;
 *   maxEventSnippetLen?: number;
 * }} [options]
 * @returns {DebugSession}
 */
function shrinkSessionForShare(session, options = {}) {
	const maxTextLen = Math.max(200, Math.floor(options.maxTextLen ?? DEFAULT_SHARE_MAX_TEXT_LEN));
	const maxEvents = Math.max(0, Math.floor(options.maxEvents ?? DEFAULT_SHARE_MAX_EVENTS));
	const maxEventSnippetLen = Math.max(80, Math.floor(options.maxEventSnippetLen ?? DEFAULT_SHARE_MAX_EVENT_SNIPPET_LEN));

	const base = session?.proxyPayloadBase ?? /** @type {any} */ ({});
	const baseRequest = base?.request && typeof base.request === 'object' ? base.request : {};

	/** @type {any} */
	const minimalRequest = {};
	if (typeof baseRequest?.model === 'string') minimalRequest.model = baseRequest.model;
	if (typeof baseRequest?.max_tokens === 'number') minimalRequest.max_tokens = baseRequest.max_tokens;
	if (typeof baseRequest?.max_tokens === 'string') minimalRequest.max_tokens = baseRequest.max_tokens;
	if (Array.isArray(baseRequest?.messages)) minimalRequest._messagesCount = baseRequest.messages.length;
	if (baseRequest?.stream === true) minimalRequest.stream = true;

	/** @type {DebugSession['proxyPayloadBase']} */
	const proxyPayloadBase = {
		provider: safeProvider(base?.provider),
		baseUrl: safeString(base?.baseUrl, ''),
		anthropicVersion: typeof base?.anthropicVersion === 'string' ? base.anthropicVersion : undefined,
		request: minimalRequest
	};

	/** @type {DebugEvent[]} */
	const events = Array.isArray(session?.events)
		? session.events.slice(0, maxEvents).map((ev, idx) => ({
				n: safeNumber(ev?.n, idx + 1),
				at: safeNumber(ev?.at, 0),
				event: typeof ev?.event === 'string' ? ev.event : null,
				id: typeof ev?.id === 'string' ? ev.id : null,
				dataLen: safeNumber(ev?.dataLen, 0),
				dataSnippet: truncate(safeString(ev?.dataSnippet, ''), maxEventSnippetLen)
			}))
		: [];

	return {
		startedAt: safeNumber(session?.startedAt, 0),
		endedAt: session?.endedAt == null ? null : safeNumber(session?.endedAt, 0),
		aborted: safeBoolean(session?.aborted, false),
		provider: safeProvider(session?.provider),
		baseUrl: safeString(session?.baseUrl, ''),
		model: safeString(session?.model, ''),
		anthropicVersion: typeof session?.anthropicVersion === 'string' ? session.anthropicVersion : undefined,
		upstreamUrl: safeString(session?.upstreamUrl, ''),
		proxyStatus: session?.proxyStatus == null ? null : safeNumber(session?.proxyStatus, 0),
		proxyOk: session?.proxyOk == null ? null : safeBoolean(session?.proxyOk, false),
		proxyErrorText: session?.proxyErrorText ? truncate(session.proxyErrorText, maxTextLen) : null,
		firstEventAt: session?.firstEventAt == null ? null : safeNumber(session?.firstEventAt, 0),
		eventCount: safeNumber(session?.eventCount, 0),
		bytesApprox: safeNumber(session?.bytesApprox, 0),
		events,
		origin: safeString(session?.origin, ''),
		proxyPayloadBase,
		proxyPayloadMaskedJson: truncate(session?.proxyPayloadMaskedJson ?? '', maxTextLen),
		upstreamRequestJson: truncate(session?.upstreamRequestJson ?? '', maxTextLen),
		proxyCurl: truncate(session?.proxyCurl ?? '', maxTextLen),
		upstreamCurl: truncate(session?.upstreamCurl ?? '', maxTextLen)
	};
}

/**
 * @param {DebugSession} session
 * @param {{ mode?: 'full' | 'share'; now?: number }} [options]
 * @returns {DebugReportV1}
 */
export function createDebugReport(session, options = {}) {
	const mode = options.mode === 'share' ? 'share' : 'full';
	const createdAt = Math.max(0, Math.floor(options.now ?? Date.now()));

	/** @type {any} */
	const sanitized = session && typeof session === 'object' ? { ...session } : session;
	if (sanitized && typeof sanitized === 'object') {
		// 防御式脱敏：正常路径下 debugSession 不包含 apiKey，但仍避免“外部注入/未来改动”导致泄漏。
		if ('apiKey' in sanitized) delete sanitized.apiKey;
		const base = sanitized.proxyPayloadBase;
		if (base && typeof base === 'object') {
			const nextBase = { ...base };
			if ('apiKey' in nextBase) delete nextBase.apiKey;
			sanitized.proxyPayloadBase = nextBase;
		}
	}

	const nextSession = mode === 'share' ? shrinkSessionForShare(session) : sanitized;
	const note =
		mode === 'share'
			? '本报告为“分享摘要版”，为避免 URL 过长已对部分字段做截断/省略；如需完整信息请使用 JSON 导出。'
			: undefined;

	return {
		kind: DEBUG_REPORT_KIND,
		v: DEBUG_REPORT_VERSION,
		createdAt,
		mode,
		note,
		session: /** @type {DebugSession} */ (nextSession)
	};
}

/**
 * @param {DebugReportV1} report
 */
export function toDebugReportJson(report) {
	return JSON.stringify(report, null, 2);
}

/**
 * @param {number} ms
 */
function fmtMs(ms) {
	if (!Number.isFinite(ms)) return '—';
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

/**
 * @param {number} bytes
 */
function fmtBytes(bytes) {
	const b = safeNumber(bytes, 0);
	if (b < 1024) return `${b} B`;
	const kb = b / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	const mb = kb / 1024;
	return `${mb.toFixed(2)} MB`;
}

/**
 * @param {DebugReportV1} report
 */
export function toDebugReportMarkdown(report) {
	const r = report && typeof report === 'object' ? report : /** @type {any} */ ({});
	const session = r.session && typeof r.session === 'object' ? r.session : /** @type {any} */ ({});

	const startedAt = safeNumber(session.startedAt, 0);
	const endedAt = session.endedAt == null ? null : safeNumber(session.endedAt, 0);
	const firstEventAt = session.firstEventAt == null ? null : safeNumber(session.firstEventAt, 0);

	const durationMs = endedAt != null && startedAt ? Math.max(0, endedAt - startedAt) : null;
	const ttfbMs = firstEventAt != null && startedAt ? Math.max(0, firstEventAt - startedAt) : null;

	const lines = [];
	lines.push('# EdgeAI Playground 调试报告');
	lines.push('');
	lines.push(`- 生成时间：${new Date(safeNumber(r.createdAt, Date.now())).toISOString()}`);
	lines.push(`- 模式：${r.mode === 'share' ? '分享摘要版（可能截断）' : '完整导出版'}`);
	if (typeof r.note === 'string' && r.note.trim()) lines.push(`- 说明：${r.note.trim()}`);
	lines.push('');

	lines.push('## 基本信息');
	lines.push('');
	lines.push(`- Provider：${safeProvider(session.provider)}`);
	lines.push(`- Base URL：${safeString(session.baseUrl, '') || '—'}`);
	lines.push(`- Model：${safeString(session.model, '') || '—'}`);
	if (typeof session.anthropicVersion === 'string' && session.anthropicVersion.trim()) {
		lines.push(`- Anthropic Version：${session.anthropicVersion.trim()}`);
	}
	lines.push(`- Upstream：${safeString(session.upstreamUrl, '') || '—'}`);
	lines.push('');

	lines.push('## 指标');
	lines.push('');
	lines.push(`- HTTP：${session.proxyStatus ?? '—'}（ok=${session.proxyOk ?? '—'}）`);
	lines.push(`- 首事件：${ttfbMs == null ? '—' : fmtMs(ttfbMs)}`);
	lines.push(`- 总耗时：${durationMs == null ? '—' : fmtMs(durationMs)}`);
	lines.push(`- 事件数：${safeNumber(session.eventCount, 0)}`);
	lines.push(`- 字节(估算)：${fmtBytes(safeNumber(session.bytesApprox, 0))}`);
	lines.push(`- Abort：${safeBoolean(session.aborted, false) ? '是' : '否'}`);
	lines.push('');

	if (typeof session.proxyErrorText === 'string' && session.proxyErrorText.trim()) {
		lines.push('## 错误');
		lines.push('');
		lines.push('```text');
		lines.push(session.proxyErrorText.trim());
		lines.push('```');
		lines.push('');
	}

	lines.push('## /api/chat 请求（脱敏）');
	lines.push('');
	lines.push('```json');
	lines.push(safeString(session.proxyPayloadMaskedJson, '') || '{}');
	lines.push('```');
	lines.push('');

	lines.push('## curl 复现（占位 KEY）');
	lines.push('');
	lines.push('### Proxy');
	lines.push('');
	lines.push('```bash');
	lines.push(safeString(session.proxyCurl, '') || '');
	lines.push('```');
	lines.push('');
	lines.push('### Upstream');
	lines.push('');
	lines.push('```bash');
	lines.push(safeString(session.upstreamCurl, '') || '');
	lines.push('```');
	lines.push('');

	if (typeof session.upstreamRequestJson === 'string' && session.upstreamRequestJson.trim()) {
		lines.push('## 上游 request（JSON）');
		lines.push('');
		lines.push('```json');
		lines.push(session.upstreamRequestJson.trim());
		lines.push('```');
		lines.push('');
	}

	if (Array.isArray(session.events) && session.events.length) {
		const max = 20;
		lines.push(`## SSE 事件（最近 ${Math.min(session.events.length, max)} 条）`);
		lines.push('');

		for (const ev of session.events.slice(0, max)) {
			const eventName = typeof ev?.event === 'string' && ev.event ? ev.event : 'message';
			lines.push(`- ${eventName} @ ${new Date(safeNumber(ev?.at, 0)).toISOString()} (${safeNumber(ev?.dataLen, 0)} chars)`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

/**
 * @param {Uint8Array} bytes
 */
function bytesToBase64(bytes) {
	// Node.js
	const NodeBuffer = /** @type {any} */ (globalThis)?.Buffer;
	if (NodeBuffer && typeof NodeBuffer.from === 'function') return NodeBuffer.from(bytes).toString('base64');
	// Browser
	const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
	return btoa(bin);
}

/**
 * @param {string} base64
 */
function base64ToBytes(base64) {
	// Node.js
	const NodeBuffer = /** @type {any} */ (globalThis)?.Buffer;
	if (NodeBuffer && typeof NodeBuffer.from === 'function') return new Uint8Array(NodeBuffer.from(base64, 'base64'));
	// Browser
	const bin = atob(base64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

/**
 * @param {string} text
 */
function base64urlEncodeUtf8(text) {
	const bytes = new TextEncoder().encode(safeString(text, ''));
	return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

/**
 * @param {string} base64url
 */
function base64urlDecodeUtf8(base64url) {
	const raw = safeString(base64url, '').replaceAll('-', '+').replaceAll('_', '/');
	const padLen = (4 - (raw.length % 4)) % 4;
	const padded = raw + '='.repeat(padLen);
	const bytes = base64ToBytes(padded);
	return new TextDecoder().decode(bytes);
}

/**
 * @param {DebugReportV1} report
 * @returns {string}
 */
export function encodeDebugReportToHash(report) {
	const json = toDebugReportJson(report);
	return `${DEBUG_REPORT_HASH_PREFIX}${base64urlEncodeUtf8(json)}`;
}

/**
 * @param {string} hash
 * @returns {DebugReportV1 | null}
 */
export function decodeDebugReportFromHash(hash) {
	const h = safeString(hash, '');
	const raw = h.startsWith(DEBUG_REPORT_HASH_PREFIX) ? h.slice(DEBUG_REPORT_HASH_PREFIX.length) : '';
	if (!raw) return null;

	try {
		const json = base64urlDecodeUtf8(raw);
		const parsed = JSON.parse(json);

		if (!parsed || typeof parsed !== 'object') return null;
		if (parsed.kind !== DEBUG_REPORT_KIND) return null;
		if (parsed.v !== DEBUG_REPORT_VERSION) return null;
		if (typeof parsed.createdAt !== 'number') return null;
		if (!parsed.session || typeof parsed.session !== 'object') return null;

		return /** @type {DebugReportV1} */ (parsed);
	} catch {
		return null;
	}
}

/**
 * 生成可分享 URL（默认使用“分享摘要版”），并做 URL 长度阈值校验。
 *
 * @param {{ baseUrl: string; session: DebugSession; maxUrlLength?: number }} args
 * @returns {{ ok: true; url: string; mode: 'share'; length: number } | { ok: false; reason: string; length: number }}
 */
export function buildDebugReportShareUrl({ baseUrl, session, maxUrlLength = DEFAULT_MAX_SHARE_URL_LEN }) {
	const report = createDebugReport(session, { mode: 'share' });
	const hash = encodeDebugReportToHash(report);
	const url = `${safeString(baseUrl, '')}${hash}`;
	const length = url.length;

	if (length > Math.max(500, Math.floor(maxUrlLength))) {
		return {
			ok: false,
			reason: `分享链接过长（${length} chars），建议改用“导出 JSON”分享完整报告。`,
			length
		};
	}

	return { ok: true, url, mode: 'share', length };
}
