// @ts-check

/**
 * 会话资产化（localStorage v1）
 *
 * 目标：
 * - 把“对话消息 + 运行快照”保存到浏览器 localStorage（不保存 API Key）
 * - 提供可复用的 CRUD、导入/导出、基础校验与自愈能力
 *
 * 说明：
 * - 本模块不依赖 DOM（便于 node --test 单元测试）；下载文件/读文件由页面层处理。
 * - localStorage 容量有限（通常 5~10MB）；导入会做大小限制，避免一次把存储打满。
 */

/**
 * @typedef {'openai' | 'anthropic'} Provider
 * @typedef {'user' | 'assistant'} Role
 *
 * @typedef {{
 *   id: string;
 *   role: Role;
 *   content: string;
 *   thinking?: string;
 *   at: number;
 * }} ChatMessage
 *
 * @typedef {{
 *   provider: Provider;
 *   baseUrl: string;
 *   model: string;
 *   systemPrompt: string;
 *   temperature: number;
 *   maxTokens: number;
 *   anthropicVersion: string;
 * }} ConversationRunSnapshot
 *
 * @typedef {{
 *   id: string;
 *   title: string;
 *   createdAt: number;
 *   updatedAt: number;
 *   lastSnippet: string;
 *   pinned: boolean;
 * }} ConversationListItem
 *
 * @typedef {{
 *   v: 1;
 *   currentId: string | null;
 *   items: ConversationListItem[];
 * }} ConversationsIndexV1
 *
 * @typedef {{
 *   v: 1;
 *   id: string;
 *   messages: ChatMessage[];
 *   run?: ConversationRunSnapshot;
 * }} StoredConversationDetailV1
 *
 * @typedef {{
 *   kind: 'edgeai-playground:conversation-export';
 *   v: 1;
 *   title: string;
 *   createdAt: number;
 *   updatedAt: number;
 *   lastSnippet: string;
 *   messages: ChatMessage[];
 *   run?: ConversationRunSnapshot;
 * }} ConversationExportV1
 *
 * @typedef {{
 *   getItem: (key: string) => string | null;
 *   setItem: (key: string, value: string) => void;
 *   removeItem: (key: string) => void;
 * }} StorageLike
 */

export const CONVERSATIONS_INDEX_KEY = 'edgeai-playground:conversations:v1';
export const CONVERSATION_DETAIL_KEY_PREFIX = 'edgeai-playground:conversation:v1:';

export const DEFAULT_CONVERSATION_TITLE = '新会话';

export const LIMITS = {
	maxImportMessages: 2000,
	maxImportMessageChars: 200_000,
	maxImportTotalChars: 2_000_000
};

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
 * @param {number} n
 * @param {number} min
 * @param {number} max
 */
function clamp(n, min, max) {
	return Math.min(max, Math.max(min, n));
}

/**
 * @param {string} s
 */
function normalizeWhitespace(s) {
	return s.replaceAll('\r', '').replaceAll('\t', ' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} s
 * @param {number} maxLen
 */
function truncate(s, maxLen) {
	if (s.length <= maxLen) return s;
	return s.slice(0, Math.max(0, maxLen - 1)).trimEnd() + '…';
}

export function createId() {
	const c = globalThis.crypto;
	if (c && typeof c.randomUUID === 'function') return c.randomUUID();
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * @param {string} raw
 */
export function normalizeConversationTitle(raw) {
	const t = normalizeWhitespace(safeString(raw, ''));
	return t ? truncate(t, 64) : DEFAULT_CONVERSATION_TITLE;
}

/**
 * @param {ChatMessage[]} messages
 */
export function deriveTitleFromFirstUserMessage(messages) {
	const first = messages.find((m) => m?.role === 'user' && typeof m?.content === 'string' && m.content.trim());
	if (!first) return null;
	const oneLine = normalizeWhitespace(first.content);
	if (!oneLine) return null;
	return truncate(oneLine, 24);
}

/**
 * @param {ChatMessage[]} messages
 */
export function calcLastSnippet(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		const text = typeof m?.content === 'string' ? normalizeWhitespace(m.content) : '';
		if (text) return truncate(text, 80);
	}
	return '';
}

/**
 * @param {string} raw
 * @returns {unknown}
 */
function safeJsonParse(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/**
 * @param {unknown} v
 * @returns {Provider | null}
 */
function normalizeProvider(v) {
	return v === 'openai' || v === 'anthropic' ? v : null;
}

/**
 * @param {unknown} v
 * @returns {Role | null}
 */
function normalizeRole(v) {
	return v === 'user' || v === 'assistant' ? v : null;
}

/**
 * @param {unknown} raw
 * @returns {ConversationRunSnapshot | undefined}
 */
function normalizeRunSnapshot(raw) {
	if (!raw || typeof raw !== 'object') return undefined;
	const r = /** @type {any} */ (raw);
	const provider = normalizeProvider(r.provider);
	if (!provider) return undefined;

	const baseUrl = normalizeWhitespace(safeString(r.baseUrl, ''));
	const model = normalizeWhitespace(safeString(r.model, ''));
	const systemPrompt = safeString(r.systemPrompt, '');
	const temperature = clamp(safeNumber(r.temperature, 0.7), 0, 2);
	const maxTokens = Math.max(1, Math.floor(safeNumber(r.maxTokens, 1024)));
	const anthropicVersion = normalizeWhitespace(safeString(r.anthropicVersion, '2023-06-01')) || '2023-06-01';

	// baseUrl/model 允许为空（例如仅导出历史，不保证可复现）；但仍保留字段便于 UI 展示
	return { provider, baseUrl, model, systemPrompt, temperature, maxTokens, anthropicVersion };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true; messages: ChatMessage[] } | { ok: false; error: string }}
 */
function normalizeMessages(raw) {
	if (!Array.isArray(raw)) return { ok: false, error: 'messages 必须是数组' };
	if (raw.length > LIMITS.maxImportMessages) return { ok: false, error: `messages 条数过多（> ${LIMITS.maxImportMessages}）` };

	/** @type {ChatMessage[]} */
	const out = [];
	let totalChars = 0;

	for (let i = 0; i < raw.length; i++) {
		const item = raw[i];
		if (!item || typeof item !== 'object') return { ok: false, error: `messages[${i}] 必须是对象` };
		const m = /** @type {any} */ (item);

		const role = normalizeRole(m.role);
		if (!role) return { ok: false, error: `messages[${i}].role 必须是 user 或 assistant` };

		if (typeof m.content !== 'string') return { ok: false, error: `messages[${i}].content 必须是字符串` };
		const content = m.content;

		const thinking = typeof m.thinking === 'string' ? m.thinking : undefined;
		const at = safeNumber(m.at, Date.now());
		const id = typeof m.id === 'string' && m.id.trim() ? m.id : createId();

		if (content.length > LIMITS.maxImportMessageChars) return { ok: false, error: `messages[${i}].content 过长` };
		if (thinking && thinking.length > LIMITS.maxImportMessageChars) return { ok: false, error: `messages[${i}].thinking 过长` };

		totalChars += content.length + (thinking?.length ?? 0);
		if (totalChars > LIMITS.maxImportTotalChars) return { ok: false, error: '导入内容过大（总字符数超限）' };

		out.push({ id, role, content, thinking, at: Math.floor(at) });
	}

	return { ok: true, messages: out };
}

/**
 * @param {StorageLike} storage
 * @returns {ConversationsIndexV1 | null}
 */
export function readConversationsIndex(storage) {
	const raw = storage.getItem(CONVERSATIONS_INDEX_KEY);
	if (!raw) return null;
	const parsed = /** @type {any} */ (safeJsonParse(raw));
	if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.items)) return null;

	/** @type {ConversationListItem[]} */
	const items = [];
	for (const it of /** @type {any[]} */ (parsed.items)) {
		if (!it || typeof it !== 'object') continue;
		const id = safeString(it.id, '').trim();
		if (!id) continue;

		const title = normalizeConversationTitle(safeString(it.title, DEFAULT_CONVERSATION_TITLE));
		const createdAt = Math.floor(safeNumber(it.createdAt, Date.now()));
		const updatedAt = Math.floor(safeNumber(it.updatedAt, createdAt));
		const lastSnippet = safeString(it.lastSnippet, '');
		const pinned = safeBoolean(it.pinned, false);

		items.push({ id, title, createdAt, updatedAt, lastSnippet, pinned });
	}

	const currentId = typeof parsed.currentId === 'string' && parsed.currentId.trim() ? parsed.currentId : null;
	return { v: 1, currentId, items };
}

/**
 * @param {StorageLike} storage
 * @param {ConversationsIndexV1} index
 */
export function writeConversationsIndex(storage, index) {
	storage.setItem(CONVERSATIONS_INDEX_KEY, JSON.stringify(index));
}

/**
 * @param {string} id
 */
export function conversationDetailKey(id) {
	return `${CONVERSATION_DETAIL_KEY_PREFIX}${id}`;
}

/**
 * @param {StorageLike} storage
 * @param {string} id
 * @returns {StoredConversationDetailV1 | null}
 */
export function readConversationDetail(storage, id) {
	const raw = storage.getItem(conversationDetailKey(id));
	if (!raw) return null;
	const parsed = /** @type {any} */ (safeJsonParse(raw));
	if (!parsed || parsed.v !== 1 || parsed.id !== id) return null;

	const messagesRes = normalizeMessages(parsed.messages);
	if (!messagesRes.ok) return null;

	const run = normalizeRunSnapshot(parsed.run);
	return { v: 1, id, messages: messagesRes.messages, run };
}

/**
 * @param {StorageLike} storage
 * @param {StoredConversationDetailV1} detail
 */
export function writeConversationDetail(storage, detail) {
	storage.setItem(conversationDetailKey(detail.id), JSON.stringify(detail));
}

/**
 * @param {StorageLike} storage
 * @param {string} id
 */
export function deleteConversationDetail(storage, id) {
	storage.removeItem(conversationDetailKey(id));
}

/**
 * @param {ConversationListItem[]} items
 */
function sortConversations(items) {
	return [...items].sort((a, b) => {
		if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
		return b.updatedAt - a.updatedAt;
	});
}

/**
 * @param {StorageLike} storage
 * @param {number} [now]
 * @returns {{ index: ConversationsIndexV1; currentId: string }}
 */
export function ensureConversations(storage, now = Date.now()) {
	/** @type {ConversationsIndexV1} */
	let index = readConversationsIndex(storage) ?? { v: 1, currentId: null, items: [] };

	// 去重（以最新 updatedAt 为准）
	const map = new Map();
	for (const item of index.items) {
		const prev = map.get(item.id);
		if (!prev || item.updatedAt >= prev.updatedAt) map.set(item.id, item);
	}
	index.items = sortConversations([...map.values()]);

	if (index.items.length === 0) {
		const id = createId();
		const meta = {
			id,
			title: DEFAULT_CONVERSATION_TITLE,
			createdAt: Math.floor(now),
			updatedAt: Math.floor(now),
			lastSnippet: '',
			pinned: false
		};

		index.currentId = id;
		index.items = [meta];
		writeConversationsIndex(storage, index);
		writeConversationDetail(storage, { v: 1, id, messages: [] });
		return { index, currentId: id };
	}

	const currentId = index.currentId && index.items.some((i) => i.id === index.currentId) ? index.currentId : index.items[0].id;
	index.currentId = currentId;
	writeConversationsIndex(storage, index);

	// 当前会话 detail 丢失则自愈创建
	if (!readConversationDetail(storage, currentId)) writeConversationDetail(storage, { v: 1, id: currentId, messages: [] });

	return { index, currentId };
}

/**
 * @param {ConversationListItem} meta
 * @param {ChatMessage[]} messages
 * @param {number} [now]
 * @returns {ConversationListItem}
 */
export function updateConversationMetaFromMessages(meta, messages, now = Date.now()) {
	const next = {
		...meta,
		updatedAt: Math.floor(now),
		lastSnippet: calcLastSnippet(messages)
	};

	// 默认标题时，用第一条用户消息自动命名
	if (normalizeWhitespace(meta.title) === normalizeWhitespace(DEFAULT_CONVERSATION_TITLE)) {
		const derived = deriveTitleFromFirstUserMessage(messages);
		if (derived) next.title = derived;
	}

	return next;
}

/**
 * @param {ConversationListItem} meta
 * @param {StoredConversationDetailV1} detail
 * @returns {ConversationExportV1}
 */
export function buildConversationExport(meta, detail) {
	return {
		kind: 'edgeai-playground:conversation-export',
		v: 1,
		title: meta.title,
		createdAt: meta.createdAt,
		updatedAt: meta.updatedAt,
		lastSnippet: meta.lastSnippet,
		messages: detail.messages,
		run: detail.run
	};
}

/**
 * @param {ConversationListItem} meta
 * @param {StoredConversationDetailV1} detail
 */
export function serializeConversationExport(meta, detail) {
	return JSON.stringify(buildConversationExport(meta, detail), null, 2);
}

/**
 * @param {string} text
 * @param {number} [now]
 * @returns {{ ok: true; meta: ConversationListItem; detail: StoredConversationDetailV1 } | { ok: false; error: string }}
 */
export function parseConversationImport(text, now = Date.now()) {
	if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '导入内容为空' };
	const parsed = /** @type {any} */ (safeJsonParse(text));
	if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'JSON 解析失败' };

	// 允许两种形态：
	// 1) 标准导出：kind + v + messages
	// 2) 宽松导入：仅包含 messages（便于兼容用户自制文件）
	if (parsed.kind && parsed.kind !== 'edgeai-playground:conversation-export') {
		return { ok: false, error: '不支持的导入格式（kind 不匹配）' };
	}

	const messagesRes = normalizeMessages(parsed.messages);
	if (!messagesRes.ok) return { ok: false, error: messagesRes.error };

	const id = createId();
	const createdAt = Math.floor(safeNumber(parsed.createdAt, now));
	const updatedAt = Math.floor(safeNumber(parsed.updatedAt, Math.max(createdAt, now)));
	const title = normalizeConversationTitle(safeString(parsed.title, DEFAULT_CONVERSATION_TITLE));

	const meta = {
		id,
		title,
		createdAt,
		updatedAt,
		lastSnippet: typeof parsed.lastSnippet === 'string' ? parsed.lastSnippet : calcLastSnippet(messagesRes.messages),
		pinned: false
	};

	const run = normalizeRunSnapshot(parsed.run);
	/** @type {StoredConversationDetailV1} */
	const detail = { v: 1, id, messages: messagesRes.messages, run };

	return { ok: true, meta, detail };
}

/**
 * @param {ConversationListItem} meta
 * @param {StoredConversationDetailV1} detail
 */
export function renderConversationMarkdown(meta, detail) {
	const lines = [];

	lines.push(`# ${meta.title}`);
	lines.push('');
	lines.push(`- createdAt: ${new Date(meta.createdAt).toISOString()}`);
	lines.push(`- updatedAt: ${new Date(meta.updatedAt).toISOString()}`);
	if (detail.run) {
		lines.push(`- provider: ${detail.run.provider}`);
		if (detail.run.baseUrl) lines.push(`- baseUrl: ${detail.run.baseUrl}`);
		if (detail.run.model) lines.push(`- model: ${detail.run.model}`);
	}
	lines.push('');

	for (const m of detail.messages) {
		const roleLabel = m.role === 'user' ? 'User' : 'Assistant';
		lines.push(`## ${roleLabel} (${new Date(m.at).toISOString()})`);
		lines.push('');
		lines.push(m.content || '');
		lines.push('');
	}

	return lines.join('\n');
}
