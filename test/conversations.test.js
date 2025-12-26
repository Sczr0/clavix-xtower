import assert from 'node:assert/strict';
import test from 'node:test';

import {
	CONVERSATIONS_INDEX_KEY,
	DEFAULT_CONVERSATION_TITLE,
	LIMITS,
	ensureConversations,
	parseConversationImport,
	readConversationDetail,
	serializeConversationExport,
	updateConversationMetaFromMessages
} from '../src/lib/conversations.js';

class MemoryStorage {
	/** @type {Map<string, string>} */
	#map = new Map();

	/** @param {string} key */
	getItem(key) {
		return this.#map.get(key) ?? null;
	}

	/** @param {string} key @param {string} value */
	setItem(key, value) {
		this.#map.set(key, String(value));
	}

	/** @param {string} key */
	removeItem(key) {
		this.#map.delete(key);
	}
}

test('ensureConversations: initializes empty storage', () => {
	const storage = new MemoryStorage();
	const now = 1_700_000_000_000;

	const { index, currentId } = ensureConversations(storage, now);
	assert.equal(index.v, 1);
	assert.equal(index.items.length, 1);
	assert.equal(index.currentId, currentId);
	assert.equal(typeof currentId, 'string');
	assert.ok(storage.getItem(CONVERSATIONS_INDEX_KEY));

	const detail = readConversationDetail(storage, currentId);
	assert.ok(detail);
	assert.deepEqual(detail.messages, []);
});

test('updateConversationMetaFromMessages: auto titles from first user message', () => {
	const meta = {
		id: 'c1',
		title: DEFAULT_CONVERSATION_TITLE,
		createdAt: 1000,
		updatedAt: 1000,
		lastSnippet: '',
		pinned: false
	};

	const messages = [
		{ id: 'm1', role: 'user', content: 'Hello world', at: 1100 },
		{ id: 'm2', role: 'assistant', content: 'OK', at: 1200 }
	];

	const next = updateConversationMetaFromMessages(meta, messages, 1300);
	assert.equal(next.title, 'Hello world');
	assert.equal(next.updatedAt, 1300);
	assert.equal(next.lastSnippet, 'OK');
});

test('serializeConversationExport: does not include apiKey', () => {
	const meta = {
		id: 'c1',
		title: 'Demo',
		createdAt: 1000,
		updatedAt: 2000,
		lastSnippet: 'hi',
		pinned: false
	};

	const detail = {
		v: 1,
		id: 'c1',
		messages: [{ id: 'm1', role: 'user', content: 'hi', at: 1500 }],
		run: {
			provider: 'openai',
			baseUrl: 'https://api.openai.com',
			model: 'gpt-4o-mini',
			systemPrompt: '',
			temperature: 0.7,
			maxTokens: 1024,
			anthropicVersion: '2023-06-01'
		}
	};

	const text = serializeConversationExport(meta, detail);
	assert.equal(text.includes('apiKey'), false);
});

test('parseConversationImport: rejects unsupported kind', () => {
	const bad = JSON.stringify({ kind: 'other', v: 1, messages: [] });
	const res = parseConversationImport(bad, 123);
	assert.equal(res.ok, false);
});

test('parseConversationImport: rejects too many messages', () => {
	const messages = Array.from({ length: LIMITS.maxImportMessages + 1 }, (_, i) => ({
		id: `m${i}`,
		role: 'user',
		content: 'x',
		at: 1
	}));
	const raw = JSON.stringify({ v: 1, messages });
	const res = parseConversationImport(raw, 123);
	assert.equal(res.ok, false);
});

