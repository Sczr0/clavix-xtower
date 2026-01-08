// @ts-check

/**
 * Profiles 资产化（localStorage v1）
 *
 * 目标：
 * - 把“运行设置快照”保存为命名 Profile，便于一键切换
 * - 支持导入/导出/分享（URL hash），并默认脱敏：不包含明文 API Key
 * - 纯函数：不依赖 DOM，便于 node --test
 *
 * 约束：
 * - Profile 持久化存储永远不落盘 apiKey（防御式剥离，即使外部注入也不会写入 localStorage）
 */

export const PROFILES_STORAGE_KEY = 'edgeai-playground:profiles:v1';

export const PROFILES_EXPORT_KIND = 'edgeai-playground:profiles-export';
export const PROFILES_EXPORT_VERSION = 1;

export const PROFILE_HASH_PREFIX = '#profile=';
export const PROFILES_HASH_PREFIX = '#profiles=';

const DEFAULT_MAX_SHARE_URL_LEN = 8000;

/**
 * @typedef {'openai' | 'anthropic'} Provider
 *
 * @typedef {{
 *   id: string;
 *   name: string;
 *   provider: Provider;
 *   baseUrl: string;
 *   model: string;
 *   systemPrompt: string;
 *   temperature: number;
 *   topP: number;
 *   presencePenalty: number;
 *   frequencyPenalty: number;
 *   maxTokens: number;
 *   anthropicVersion: string;
 *   createdAt: number;
 *   updatedAt: number;
 *   apiKey?: string;
 * }} ProfileV1
 *
 * @typedef {{
 *   v: 1;
 *   currentId: string | null;
 *   items: ProfileV1[];
 * }} StoredProfilesV1
 *
 * @typedef {{
 *   kind: typeof PROFILES_EXPORT_KIND;
 *   v: typeof PROFILES_EXPORT_VERSION;
 *   exportedAt: number;
 *   profiles: ProfileV1[];
 * }} ProfilesExportV1
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
 * @param {unknown} v
 * @returns {Provider}
 */
function safeProvider(v) {
	return v === 'anthropic' || v === 'openai' ? v : 'openai';
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
	if (maxLen <= 0) return '';
	if (s.length <= maxLen) return s;
	return s.slice(0, Math.max(0, maxLen - 1)).trimEnd() + '…';
}

/**
 * @param {string} raw
 */
export function normalizeProfileName(raw) {
	const t = normalizeWhitespace(safeString(raw, ''));
	return t ? truncate(t, 64) : '未命名';
}

export function createProfileId() {
	const c = globalThis.crypto;
	if (c && typeof c.randomUUID === 'function') return c.randomUUID();
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
 * @param {unknown} raw
 * @param {{ now?: number; keepApiKey?: boolean; forceNewId?: boolean }} [options]
 * @returns {ProfileV1 | null}
 */
function normalizeProfile(raw, options = {}) {
	if (!raw || typeof raw !== 'object') return null;
	const r = /** @type {any} */ (raw);

	const now = Math.max(0, Math.floor(options.now ?? Date.now()));
	const keepApiKey = options.keepApiKey === true;
	const forceNewId = options.forceNewId === true;

	const idRaw = safeString(r.id, '').trim();
	const id = forceNewId || !idRaw ? createProfileId() : idRaw;

	const createdAt = Math.floor(safeNumber(r.createdAt, now));
	const updatedAt = Math.floor(safeNumber(r.updatedAt, Math.max(createdAt, now)));

	const name = normalizeProfileName(r.name);
	const provider = safeProvider(r.provider);

	const baseUrl = safeString(r.baseUrl, '').trim();
	const model = safeString(r.model, '').trim();
	const systemPrompt = safeString(r.systemPrompt, '');

	const maxTokens = Math.max(1, Math.floor(safeNumber(r.maxTokens, 1024)));

	// OpenAI sampling params（即使 provider=anthropic 也保留，便于后续切换/复用）
	const temperature = clamp(safeNumber(r.temperature, 0.7), 0, 2);
	const topP = clamp(safeNumber(r.topP ?? r.top_p, 1), 0, 1);
	const presencePenalty = clamp(safeNumber(r.presencePenalty ?? r.presence_penalty, 0), -2, 2);
	const frequencyPenalty = clamp(safeNumber(r.frequencyPenalty ?? r.frequency_penalty, 0), -2, 2);

	const anthropicVersion = safeString(r.anthropicVersion, '2023-06-01').trim() || '2023-06-01';

	const apiKey = keepApiKey && typeof r.apiKey === 'string' ? r.apiKey : undefined;

	return {
		id,
		name,
		provider,
		baseUrl,
		model,
		systemPrompt,
		temperature,
		topP,
		presencePenalty,
		frequencyPenalty,
		maxTokens,
		anthropicVersion,
		createdAt: Math.max(0, createdAt),
		updatedAt: Math.max(0, Math.max(updatedAt, createdAt)),
		apiKey
	};
}

/**
 * @param {unknown} raw
 * @param {{ now?: number; keepApiKey?: boolean; forceNewId?: boolean }} [options]
 * @returns {ProfileV1[]}
 */
function normalizeProfiles(raw, options = {}) {
	if (!Array.isArray(raw)) return [];
	/** @type {ProfileV1[]} */
	const out = [];
	for (const it of raw) {
		const p = normalizeProfile(it, options);
		if (p) out.push(p);
	}
	return out;
}

/**
 * @returns {StoredProfilesV1}
 */
function emptyStore() {
	return { v: 1, currentId: null, items: [] };
}

/**
 * @param {StorageLike} storage
 * @returns {StoredProfilesV1}
 */
export function readProfiles(storage) {
	const raw = storage.getItem(PROFILES_STORAGE_KEY);
	if (!raw) return emptyStore();
	const parsed = safeJsonParse(raw);
	if (!parsed || typeof parsed !== 'object') return emptyStore();

	const v = /** @type {any} */ (parsed).v;
	if (v !== 1) return emptyStore();

	const items = normalizeProfiles(/** @type {any} */ (parsed).items, { keepApiKey: false, forceNewId: false });
	const currentIdRaw = safeString(/** @type {any} */ (parsed).currentId, '').trim();
	const currentId = currentIdRaw && items.some((p) => p.id === currentIdRaw) ? currentIdRaw : null;

	// 防御式：确保持久化读取出来的数据不含 apiKey
	return {
		v: 1,
		currentId,
		items: items.map((p) => {
			// eslint-disable-next-line no-unused-vars
			const { apiKey, ...rest } = p;
			return rest;
		})
	};
}

/**
 * 持久化写入：永远不落盘 apiKey（防御式剥离）。
 * @param {StorageLike} storage
 * @param {StoredProfilesV1} state
 */
export function writeProfiles(storage, state) {
	const base = state && typeof state === 'object' ? state : emptyStore();
	const items = normalizeProfiles(/** @type {any} */ (base).items, { keepApiKey: false, forceNewId: false });

	const currentIdRaw = safeString(/** @type {any} */ (base).currentId, '').trim();
	const currentId = currentIdRaw && items.some((p) => p.id === currentIdRaw) ? currentIdRaw : null;

	const payload = {
		v: 1,
		currentId,
		items: items.map((p) => {
			// eslint-disable-next-line no-unused-vars
			const { apiKey, ...rest } = p;
			return rest;
		})
	};

	storage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(payload));
}

/**
 * @param {ProfileV1[]} profiles
 * @param {{ now?: number; includeApiKey?: boolean }} [options]
 * @returns {ProfilesExportV1}
 */
export function buildProfilesExport(profiles, options = {}) {
	const exportedAt = Math.max(0, Math.floor(options.now ?? Date.now()));
	const includeApiKey = options.includeApiKey === true;

	const items = normalizeProfiles(profiles, { keepApiKey: includeApiKey, forceNewId: false }).map((p) => {
		if (includeApiKey) return p;
		// eslint-disable-next-line no-unused-vars
		const { apiKey, ...rest } = p;
		return rest;
	});

	return {
		kind: PROFILES_EXPORT_KIND,
		v: PROFILES_EXPORT_VERSION,
		exportedAt,
		profiles: items
	};
}

/**
 * @param {ProfilesExportV1} exp
 */
export function toProfilesExportJson(exp) {
	return JSON.stringify(exp, null, 2);
}

/**
 * @param {ProfileV1[]} profiles
 * @param {{ now?: number; includeApiKey?: boolean }} [options]
 */
export function serializeProfilesExport(profiles, options = {}) {
	return toProfilesExportJson(buildProfilesExport(profiles, options));
}

/**
 * @param {string} text
 * @param {{ now?: number; keepApiKey?: boolean }} [options]
 * @returns {{ ok: true; profiles: ProfileV1[] } | { ok: false; error: string }}
 */
export function parseProfilesImport(text, options = {}) {
	const raw = safeString(text, '').trim();
	if (!raw) return { ok: false, error: '导入内容为空' };
	const parsed = /** @type {any} */ (safeJsonParse(raw));
	if (!parsed || typeof parsed !== 'object') return { ok: false, error: '导入失败：不是有效的 JSON' };

	if (parsed.kind !== PROFILES_EXPORT_KIND) return { ok: false, error: '不支持的导入格式（kind 不匹配）' };
	if (parsed.v !== PROFILES_EXPORT_VERSION) return { ok: false, error: '不支持的导入格式（版本不匹配）' };
	if (!Array.isArray(parsed.profiles)) return { ok: false, error: '导入失败：profiles 字段缺失' };

	const now = Math.max(0, Math.floor(options.now ?? Date.now()));
	const keepApiKey = options.keepApiKey === true;

	const profiles = normalizeProfiles(parsed.profiles, { now, keepApiKey, forceNewId: true });
	if (profiles.length === 0) return { ok: false, error: '导入失败：没有可用的 Profile' };

	return { ok: true, profiles };
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
 * @param {ProfilesExportV1} exp
 * @returns {string}
 */
export function encodeProfilesToHash(exp) {
	const profiles = Array.isArray(exp?.profiles) ? exp.profiles : [];
	const prefix = profiles.length <= 1 ? PROFILE_HASH_PREFIX : PROFILES_HASH_PREFIX;
	const json = toProfilesExportJson(exp);
	return `${prefix}${base64urlEncodeUtf8(json)}`;
}

/**
 * @param {string} hash
 * @returns {ProfilesExportV1 | null}
 */
export function decodeProfilesFromHash(hash) {
	const h = safeString(hash, '');
	let raw = '';
	if (h.startsWith(PROFILE_HASH_PREFIX)) raw = h.slice(PROFILE_HASH_PREFIX.length);
	else if (h.startsWith(PROFILES_HASH_PREFIX)) raw = h.slice(PROFILES_HASH_PREFIX.length);
	if (!raw) return null;

	try {
		const json = base64urlDecodeUtf8(raw);
		const parsed = JSON.parse(json);

		if (!parsed || typeof parsed !== 'object') return null;
		if (parsed.kind !== PROFILES_EXPORT_KIND) return null;
		if (parsed.v !== PROFILES_EXPORT_VERSION) return null;
		if (!Array.isArray(parsed.profiles)) return null;

		// 防御式：hash 分享永远按“安全模式”处理（不保留 apiKey）
		const profiles = normalizeProfiles(parsed.profiles, { keepApiKey: false, forceNewId: true });
		if (!profiles.length) return null;

		return {
			kind: PROFILES_EXPORT_KIND,
			v: PROFILES_EXPORT_VERSION,
			exportedAt: typeof parsed.exportedAt === 'number' ? parsed.exportedAt : 0,
			profiles
		};
	} catch {
		return null;
	}
}

/**
 * 生成可分享 URL（hash），默认脱敏（不含 apiKey）并做长度阈值校验。
 * @param {{ baseUrl: string; profiles: ProfileV1[]; maxUrlLength?: number }} args
 * @returns {{ ok: true; url: string; length: number } | { ok: false; reason: string; length: number }}
 */
export function buildProfilesShareUrl({ baseUrl, profiles, maxUrlLength = DEFAULT_MAX_SHARE_URL_LEN }) {
	const exp = buildProfilesExport(profiles, { includeApiKey: false });
	const hash = encodeProfilesToHash(exp);
	const url = `${safeString(baseUrl, '')}${hash}`;
	const length = url.length;

	if (length > Math.max(500, Math.floor(maxUrlLength))) {
		return {
			ok: false,
			reason: `分享链接过长（${length} chars），建议改用“导出 JSON”分享完整内容。`,
			length
		};
	}

	return { ok: true, url, length };
}

