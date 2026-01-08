// @ts-check

/**
 * Prompt 模板库（localStorage v1）
 *
 * 目标：
 * - 提供常用提示词模板（内置 + 用户自定义）
 * - 支持 {topic} 等变量占位符（插入前按表单渲染）
 * - 支持收藏与最近使用（仅存 templateId，不复制内容）
 * - 纯函数：不依赖 DOM，便于 node --test
 */

export const PROMPT_TEMPLATES_STORAGE_KEY = 'edgeai-playground:prompt-templates:v1';

/**
 * 内置模板：只读（不写入 localStorage），使用稳定 id 便于收藏/最近引用。
 * 注意：占位符变量名规则为：字母开头，后续允许字母/数字/下划线/短横线。
 */
/** @type {ReadonlyArray<{ id: string; title: string; content: string }>} */
export const DEFAULT_PROMPT_TEMPLATES = Object.freeze([
	{
		id: 'builtin:summarize',
		title: '总结要点',
		content: '请用项目符号总结下面内容的关键要点，并给出 3 条可执行建议：\n\n{content}\n\n要求：\n- 使用中文\n- 不要编造未出现的信息'
	},
	{
		id: 'builtin:rewrite',
		title: '改写更清晰',
		content:
			'请将下面内容改写得更清晰、更结构化，保留原意：\n\n{content}\n\n要求：\n- 语气：{tone}\n- 目标读者：{audience}\n- 输出为 Markdown'
	},
	{
		id: 'builtin:translate',
		title: '翻译',
		content:
			'请将下面内容翻译成 {language}，保留术语一致性与格式：\n\n{content}\n\n要求：\n- 如遇专有名词请保留原文并括号解释（如有必要）'
	},
	{
		id: 'builtin:brainstorm',
		title: '头脑风暴',
		content:
			'围绕主题“{topic}”做头脑风暴：\n- 给出 10 个不同方向的想法\n- 每个想法写一句解释\n- 额外给出 3 个可落地的下一步行动'
	},
	{
		id: 'builtin:plan',
		title: '制定计划',
		content:
			'请为目标“{goal}”制定一份可执行计划：\n- 分阶段（里程碑）\n- 每阶段输出物\n- 风险与应对\n- 预计时间与优先级\n\n背景：\n{context}'
	},
	{
		id: 'builtin:code-review',
		title: '代码审查',
		content:
			'请对下面代码做一次审查，重点关注：正确性、可读性、边界条件、性能与安全性，并给出可操作的修改建议：\n\n```{language}\n{code}\n```'
	}
]);

/**
 * @typedef {{
 *   id: string;
 *   title: string;
 *   content: string;
 *   createdAt: number;
 *   updatedAt: number;
 * }} UserPromptTemplateV1
 *
 * @typedef {{
 *   v: 1;
 *   items: UserPromptTemplateV1[];
 *   favorites: string[];
 *   recent: string[];
 * }} StoredPromptTemplatesV1
 *
 * @typedef {{
 *   getItem: (key: string) => string | null;
 *   setItem: (key: string, value: string) => void;
 *   removeItem: (key: string) => void;
 * }} StorageLike
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
	if (maxLen <= 0) return '';
	if (s.length <= maxLen) return s;
	return s.slice(0, Math.max(0, maxLen - 1)).trimEnd() + '…';
}

export function createPromptTemplateId() {
	const c = globalThis.crypto;
	if (c && typeof c.randomUUID === 'function') return c.randomUUID();
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * @param {string} raw
 */
export function normalizePromptTemplateTitle(raw) {
	const t = normalizeWhitespace(safeString(raw, ''));
	return t ? truncate(t, 80) : '未命名';
}

/**
 * @param {string} raw
 */
export function normalizePromptTemplateContent(raw) {
	return safeString(raw, '').replaceAll('\r', '').trim();
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
 * @returns {StoredPromptTemplatesV1}
 */
function emptyStore() {
	return { v: 1, items: [], favorites: [], recent: [] };
}

/**
 * @param {unknown} raw
 * @param {{ now?: number }} [options]
 * @returns {UserPromptTemplateV1 | null}
 */
function normalizeUserTemplate(raw, options = {}) {
	if (!raw || typeof raw !== 'object') return null;
	const r = /** @type {any} */ (raw);

	const now = Math.max(0, Math.floor(options.now ?? Date.now()));

	const idRaw = safeString(r.id, '').trim();
	const id = idRaw ? idRaw : createPromptTemplateId();

	const createdAt = Math.floor(safeNumber(r.createdAt, now));
	const updatedAt = Math.floor(safeNumber(r.updatedAt, Math.max(createdAt, now)));

	const title = normalizePromptTemplateTitle(r.title);
	const content = normalizePromptTemplateContent(r.content);

	return {
		id,
		title,
		content,
		createdAt: Math.max(0, createdAt),
		updatedAt: Math.max(0, Math.max(updatedAt, createdAt))
	};
}

/**
 * @param {unknown} raw
 * @param {{ now?: number }} [options]
 * @returns {UserPromptTemplateV1[]}
 */
function normalizeUserTemplates(raw, options = {}) {
	if (!Array.isArray(raw)) return [];
	/** @type {UserPromptTemplateV1[]} */
	const out = [];
	for (const it of raw) {
		const t = normalizeUserTemplate(it, options);
		if (t) out.push(t);
	}
	return out;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeIdList(raw) {
	if (!Array.isArray(raw)) return [];
	/** @type {string[]} */
	const out = [];
	const seen = new Set();
	for (const it of raw) {
		const id = typeof it === 'string' ? it.trim() : '';
		if (!id) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

/**
 * 生成“当前所有有效模板 id”集合（内置 + 用户自定义）
 * @param {UserPromptTemplateV1[]} userItems
 */
function buildValidIdSet(userItems) {
	const set = new Set(DEFAULT_PROMPT_TEMPLATES.map((t) => t.id));
	for (const it of userItems) set.add(it.id);
	return set;
}

/**
 * @param {string[]} ids
 * @param {Set<string>} valid
 */
function filterValidIds(ids, valid) {
	return ids.filter((id) => valid.has(id));
}

/**
 * @param {StorageLike} storage
 * @returns {StoredPromptTemplatesV1}
 */
export function readPromptTemplates(storage) {
	const raw = storage.getItem(PROMPT_TEMPLATES_STORAGE_KEY);
	if (!raw) return emptyStore();
	const parsed = safeJsonParse(raw);
	if (!parsed || typeof parsed !== 'object') return emptyStore();

	const v = /** @type {any} */ (parsed).v;
	if (v !== 1) return emptyStore();

	const items = normalizeUserTemplates(/** @type {any} */ (parsed).items, { now: Date.now() });
	const valid = buildValidIdSet(items);

	const favorites = filterValidIds(normalizeIdList(/** @type {any} */ (parsed).favorites), valid);
	const recent = filterValidIds(normalizeIdList(/** @type {any} */ (parsed).recent), valid);

	return { v: 1, items, favorites, recent };
}

/**
 * @param {StorageLike} storage
 * @param {StoredPromptTemplatesV1} state
 */
export function writePromptTemplates(storage, state) {
	const base = state && typeof state === 'object' ? state : emptyStore();
	const items = normalizeUserTemplates(/** @type {any} */ (base).items, { now: Date.now() });
	const valid = buildValidIdSet(items);

	const favorites = filterValidIds(normalizeIdList(/** @type {any} */ (base).favorites), valid);
	const recent = filterValidIds(normalizeIdList(/** @type {any} */ (base).recent), valid);

	storage.setItem(PROMPT_TEMPLATES_STORAGE_KEY, JSON.stringify({ v: 1, items, favorites, recent }));
}

/**
 * @param {StoredPromptTemplatesV1} state
 * @param {string} templateId
 * @returns {StoredPromptTemplatesV1}
 */
export function togglePromptTemplateFavorite(state, templateId) {
	const id = safeString(templateId, '').trim();
	if (!id) return state;

	const valid = buildValidIdSet(state.items);
	if (!valid.has(id)) return state;

	const exists = state.favorites.includes(id);
	const favorites = exists ? state.favorites.filter((x) => x !== id) : [id, ...state.favorites.filter((x) => x !== id)];
	return { ...state, favorites };
}

/**
 * 标记模板被使用：recent 置顶、去重、限长
 * @param {StoredPromptTemplatesV1} state
 * @param {string} templateId
 * @param {{ maxRecent?: number }} [options]
 * @returns {StoredPromptTemplatesV1}
 */
export function markPromptTemplateUsed(state, templateId, options = {}) {
	const id = safeString(templateId, '').trim();
	if (!id) return state;

	const valid = buildValidIdSet(state.items);
	if (!valid.has(id)) return state;

	const maxRecent = Math.max(1, Math.floor(safeNumber(options.maxRecent, 20)));
	const recent = [id, ...state.recent.filter((x) => x !== id)].slice(0, maxRecent);
	return { ...state, recent };
}

/**
 * 新建或更新用户模板（upsert）
 * @param {StoredPromptTemplatesV1} state
 * @param {{ id?: string; title?: string; content?: string }} patch
 * @param {{ now?: number }} [options]
 * @returns {StoredPromptTemplatesV1}
 */
export function upsertUserPromptTemplate(state, patch, options = {}) {
	const now = Math.max(0, Math.floor(options.now ?? Date.now()));
	const id = typeof patch?.id === 'string' && patch.id.trim() ? patch.id.trim() : createPromptTemplateId();

	const title = normalizePromptTemplateTitle(patch?.title ?? '');
	const content = normalizePromptTemplateContent(patch?.content ?? '');

	const idx = state.items.findIndex((t) => t.id === id);
	const nextItem =
		idx === -1
			? { id, title, content, createdAt: now, updatedAt: now }
			: { ...state.items[idx], title, content, updatedAt: now };

	const items = idx === -1 ? [nextItem, ...state.items] : state.items.map((t, i) => (i === idx ? nextItem : t));
	return { ...state, items };
}

/**
 * 删除用户模板，并同步清理 favorites/recent
 * @param {StoredPromptTemplatesV1} state
 * @param {string} id
 * @returns {StoredPromptTemplatesV1}
 */
export function deleteUserPromptTemplate(state, id) {
	const templateId = safeString(id, '').trim();
	if (!templateId) return state;
	const items = state.items.filter((t) => t.id !== templateId);
	const favorites = state.favorites.filter((x) => x !== templateId);
	const recent = state.recent.filter((x) => x !== templateId);
	return { ...state, items, favorites, recent };
}

/**
 * 解析模板中的占位符变量：{topic}
 * @param {string} content
 * @returns {string[]}
 */
export function parseTemplateVariables(content) {
	const s = safeString(content, '');
	/** @type {string[]} */
	const out = [];
	const seen = new Set();
	const re = /\{([a-zA-Z][a-zA-Z0-9_-]{0,63})\}/g;
	let m;
	while ((m = re.exec(s))) {
		const name = m[1];
		if (!name || seen.has(name)) continue;
		seen.add(name);
		out.push(name);
	}
	return out;
}

/**
 * 按变量表渲染模板；未提供值时可选择保留占位符或替换为空串。
 * @param {string} content
 * @param {Record<string, string | undefined> | null | undefined} values
 * @param {{ keepUnfilled?: boolean }} [options]
 */
export function renderTemplate(content, values, options = {}) {
	const keepUnfilled = options.keepUnfilled !== false;
	const map = values && typeof values === 'object' ? values : {};

	return safeString(content, '').replace(/\{([a-zA-Z][a-zA-Z0-9_-]{0,63})\}/g, (full, name) => {
		const raw = map[name];
		const v = typeof raw === 'string' ? raw : '';
		if (v.trim()) return v;
		return keepUnfilled ? full : '';
	});
}
