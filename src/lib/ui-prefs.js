// @ts-check

/**
 * UI 偏好（主题/字号/密度）持久化（localStorage v1）
 *
 * 设计目标：
 * - 纯函数 + StorageLike：便于 node --test
 * - 与现有 readSettings/writeSettings 同风格：v 校验 + 字段容错
 * - UI 层只负责绑定与调用：首屏由 app.html 内联脚本抢先应用，避免 FOUC
 */

export const UI_PREFS_STORAGE_KEY = 'edgeai-playground:ui-prefs:v1';

export const UI_ATTR_COLOR_SCHEME = 'data-color-scheme';
export const UI_ATTR_FONT = 'data-font';
export const UI_ATTR_DENSITY = 'data-density';

/**
 * @typedef {'system' | 'light' | 'dark'} UiColorScheme
 * @typedef {'sm' | 'md' | 'lg'} UiFontSize
 * @typedef {'compact' | 'comfortable' | 'spacious'} UiDensity
 *
 * @typedef {{
 *   v: 1;
 *   colorScheme: UiColorScheme;
 *   fontSize: UiFontSize;
 *   density: UiDensity;
 * }} StoredUiPrefsV1
 *
 * @typedef {{
 *   getItem: (key: string) => string | null;
 *   setItem: (key: string, value: string) => void;
 *   removeItem: (key: string) => void;
 * }} StorageLike
 *
 * @typedef {{
 *   setAttribute: (name: string, value: string) => void;
 *   removeAttribute: (name: string) => void;
 * }} RootLike
 */

/**
 * @param {unknown} v
 * @param {UiColorScheme} fallback
 * @returns {UiColorScheme}
 */
function safeColorScheme(v, fallback) {
	return v === 'system' || v === 'light' || v === 'dark' ? v : fallback;
}

/**
 * @param {unknown} v
 * @param {UiFontSize} fallback
 * @returns {UiFontSize}
 */
function safeFontSize(v, fallback) {
	return v === 'sm' || v === 'md' || v === 'lg' ? v : fallback;
}

/**
 * @param {unknown} v
 * @param {UiDensity} fallback
 * @returns {UiDensity}
 */
function safeDensity(v, fallback) {
	return v === 'compact' || v === 'comfortable' || v === 'spacious' ? v : fallback;
}

/**
 * @returns {StoredUiPrefsV1}
 */
export function createDefaultUiPrefs() {
	return { v: 1, colorScheme: 'system', fontSize: 'md', density: 'comfortable' };
}

/**
 * @param {string | null | undefined} raw
 * @returns {StoredUiPrefsV1 | null}
 */
export function parseUiPrefs(raw) {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) return null;

		const d = createDefaultUiPrefs();
		return {
			v: 1,
			colorScheme: safeColorScheme(parsed.colorScheme, d.colorScheme),
			fontSize: safeFontSize(parsed.fontSize, d.fontSize),
			density: safeDensity(parsed.density, d.density)
		};
	} catch {
		return null;
	}
}

/**
 * @param {StorageLike} storage
 * @returns {StoredUiPrefsV1 | null}
 */
export function readUiPrefs(storage) {
	try {
		return parseUiPrefs(storage.getItem(UI_PREFS_STORAGE_KEY));
	} catch {
		return null;
	}
}

/**
 * @param {StorageLike} storage
 * @param {StoredUiPrefsV1} prefs
 */
export function writeUiPrefs(storage, prefs) {
	try {
		storage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		// localStorage 可能被禁用（隐私模式/策略）
	}
}

/**
 * 主题跟随系统时，为了让 CSS 使用 `:root:not([data-color-scheme])` 的分支，
 * 这里返回 `null` 表示移除属性。
 *
 * @param {StoredUiPrefsV1} prefs
 * @returns {{ colorScheme: 'light' | 'dark' | null; font: UiFontSize; density: UiDensity }}
 */
export function toDomAttributes(prefs) {
	const d = createDefaultUiPrefs();
	const colorScheme = safeColorScheme(prefs?.colorScheme, d.colorScheme);
	return {
		colorScheme: colorScheme === 'system' ? null : colorScheme,
		font: safeFontSize(prefs?.fontSize, d.fontSize),
		density: safeDensity(prefs?.density, d.density)
	};
}

/**
 * @param {RootLike} root
 * @param {StoredUiPrefsV1} prefs
 */
export function applyUiPrefsToRoot(root, prefs) {
	const attrs = toDomAttributes(prefs);
	if (attrs.colorScheme) root.setAttribute(UI_ATTR_COLOR_SCHEME, attrs.colorScheme);
	else root.removeAttribute(UI_ATTR_COLOR_SCHEME);
	root.setAttribute(UI_ATTR_FONT, attrs.font);
	root.setAttribute(UI_ATTR_DENSITY, attrs.density);
}

