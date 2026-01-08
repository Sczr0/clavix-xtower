import assert from 'node:assert/strict';
import test from 'node:test';

import {
	DEFAULT_PROMPT_TEMPLATES,
	PROMPT_TEMPLATES_STORAGE_KEY,
	deleteUserPromptTemplate,
	markPromptTemplateUsed,
	parseTemplateVariables,
	readPromptTemplates,
	renderTemplate,
	togglePromptTemplateFavorite,
	upsertUserPromptTemplate,
	writePromptTemplates
} from '../src/lib/prompt-templates.js';

class MemoryStorage {
	constructor() {
		this.map = new Map();
	}
	/** @param {string} key */
	getItem(key) {
		return this.map.has(key) ? this.map.get(key) : null;
	}
	/** @param {string} key @param {string} value */
	setItem(key, value) {
		this.map.set(key, value);
	}
	/** @param {string} key */
	removeItem(key) {
		this.map.delete(key);
	}
}

test('parseTemplateVariables: should return unique vars in order', () => {
	const vars = parseTemplateVariables('Hello {topic}, {topic} and {a_b-1}. Ignore {1bad}.');
	assert.deepEqual(vars, ['topic', 'a_b-1']);
});

test('renderTemplate: keepUnfilled=true should keep placeholders', () => {
	const out = renderTemplate('A {topic} B {x}', { topic: 'AI' }, { keepUnfilled: true });
	assert.equal(out, 'A AI B {x}');
});

test('renderTemplate: keepUnfilled=false should replace missing with empty', () => {
	const out = renderTemplate('A {topic} B {x}', { topic: 'AI' }, { keepUnfilled: false });
	assert.equal(out, 'A AI B ');
});

test('togglePromptTemplateFavorite: should toggle and keep valid ids only', () => {
	const builtinId = DEFAULT_PROMPT_TEMPLATES[0].id;
	let state = { v: 1, items: [], favorites: [], recent: [] };

	state = togglePromptTemplateFavorite(state, builtinId);
	assert.deepEqual(state.favorites, [builtinId]);

	state = togglePromptTemplateFavorite(state, builtinId);
	assert.deepEqual(state.favorites, []);

	// invalid id: no-op
	state = togglePromptTemplateFavorite(state, 'missing');
	assert.deepEqual(state.favorites, []);
});

test('markPromptTemplateUsed: should move to front, dedupe and cap length', () => {
	const a = DEFAULT_PROMPT_TEMPLATES[0].id;
	const b = DEFAULT_PROMPT_TEMPLATES[1].id;
	let state = { v: 1, items: [], favorites: [], recent: [a, b] };

	state = markPromptTemplateUsed(state, b, { maxRecent: 2 });
	assert.deepEqual(state.recent, [b, a]);

	state = markPromptTemplateUsed(state, b, { maxRecent: 2 });
	assert.deepEqual(state.recent, [b, a]);
});

test('readPromptTemplates/writePromptTemplates: should normalize and filter dangling ids', () => {
	const storage = new MemoryStorage();

	writePromptTemplates(storage, {
		v: 1,
		items: [
			{
				id: 'u1',
				title: '  My  Template  ',
				content: 'Hello',
				createdAt: 100,
				updatedAt: 50 // should be clamped to >= createdAt
			}
		],
		favorites: ['missing', DEFAULT_PROMPT_TEMPLATES[0].id, 'u1', 'u1'],
		recent: ['missing', 'u1', DEFAULT_PROMPT_TEMPLATES[0].id]
	});

	const raw = storage.getItem(PROMPT_TEMPLATES_STORAGE_KEY);
	assert.ok(raw);
	assert.ok(raw.includes('missing') === false);

	const read = readPromptTemplates(storage);
	assert.equal(read.v, 1);
	assert.equal(read.items.length, 1);
	assert.equal(read.items[0].title, 'My Template');
	assert.equal(read.items[0].updatedAt >= read.items[0].createdAt, true);
	assert.deepEqual(read.favorites, [DEFAULT_PROMPT_TEMPLATES[0].id, 'u1']);
	assert.deepEqual(read.recent, ['u1', DEFAULT_PROMPT_TEMPLATES[0].id]);
});

test('upsert/delete user template: should add/update and cleanup favorites/recent', () => {
	let state = { v: 1, items: [], favorites: [], recent: [] };
	state = upsertUserPromptTemplate(state, { title: 'T', content: 'C' }, { now: 1 });
	assert.equal(state.items.length, 1);
	const id = state.items[0].id;

	state = togglePromptTemplateFavorite(state, id);
	state = markPromptTemplateUsed(state, id, { maxRecent: 20 });
	assert.deepEqual(state.favorites, [id]);
	assert.deepEqual(state.recent, [id]);

	state = deleteUserPromptTemplate(state, id);
	assert.equal(state.items.length, 0);
	assert.deepEqual(state.favorites, []);
	assert.deepEqual(state.recent, []);
});

