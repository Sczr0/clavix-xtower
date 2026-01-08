import assert from 'node:assert/strict';
import test from 'node:test';

import {
	UI_ATTR_COLOR_SCHEME,
	UI_ATTR_DENSITY,
	UI_ATTR_FONT,
	UI_PREFS_STORAGE_KEY,
	applyUiPrefsToRoot,
	createDefaultUiPrefs,
	parseUiPrefs,
	readUiPrefs,
	toDomAttributes,
	writeUiPrefs
} from '../src/lib/ui-prefs.js';

function createStorage(initial = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem(key) {
			return map.has(key) ? map.get(key) : null;
		},
		setItem(key, value) {
			map.set(key, value);
		},
		removeItem(key) {
			map.delete(key);
		},
		_map: map
	};
}

function createRoot() {
	const attrs = new Map();
	return {
		setAttribute(name, value) {
			attrs.set(String(name), String(value));
		},
		removeAttribute(name) {
			attrs.delete(String(name));
		},
		getAttribute(name) {
			return attrs.has(String(name)) ? attrs.get(String(name)) : null;
		}
	};
}

test('parseUiPrefs: returns null for empty/invalid', () => {
	assert.equal(parseUiPrefs(null), null);
	assert.equal(parseUiPrefs(''), null);
	assert.equal(parseUiPrefs('{'), null);
	assert.equal(parseUiPrefs(JSON.stringify({ v: 2 })), null);
});

test('parseUiPrefs: normalizes invalid fields when v=1', () => {
	const parsed = parseUiPrefs(JSON.stringify({ v: 1, colorScheme: 'nope', fontSize: 123, density: '' }));
	assert.deepEqual(parsed, { v: 1, colorScheme: 'system', fontSize: 'md', density: 'comfortable' });
});

test('read/writeUiPrefs: roundtrip', () => {
	const storage = createStorage();
	const prefs = { v: 1, colorScheme: 'dark', fontSize: 'lg', density: 'compact' };
	writeUiPrefs(storage, prefs);
	assert.equal(typeof storage._map.get(UI_PREFS_STORAGE_KEY), 'string');
	assert.deepEqual(readUiPrefs(storage), prefs);
});

test('toDomAttributes: system removes data-color-scheme', () => {
	const attrs = toDomAttributes({ v: 1, colorScheme: 'system', fontSize: 'sm', density: 'spacious' });
	assert.deepEqual(attrs, { colorScheme: null, font: 'sm', density: 'spacious' });
});

test('applyUiPrefsToRoot: sets/removes attributes correctly', () => {
	const root = createRoot();

	applyUiPrefsToRoot(root, createDefaultUiPrefs());
	assert.equal(root.getAttribute(UI_ATTR_COLOR_SCHEME), null);
	assert.equal(root.getAttribute(UI_ATTR_FONT), 'md');
	assert.equal(root.getAttribute(UI_ATTR_DENSITY), 'comfortable');

	applyUiPrefsToRoot(root, { v: 1, colorScheme: 'dark', fontSize: 'lg', density: 'compact' });
	assert.equal(root.getAttribute(UI_ATTR_COLOR_SCHEME), 'dark');
	assert.equal(root.getAttribute(UI_ATTR_FONT), 'lg');
	assert.equal(root.getAttribute(UI_ATTR_DENSITY), 'compact');
});

