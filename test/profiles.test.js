import assert from 'node:assert/strict';
import test from 'node:test';

import {
	PROFILE_HASH_PREFIX,
	PROFILES_EXPORT_KIND,
	PROFILES_EXPORT_VERSION,
	PROFILES_HASH_PREFIX,
	PROFILES_STORAGE_KEY,
	buildProfilesExport,
	buildProfilesShareUrl,
	decodeProfilesFromHash,
	encodeProfilesToHash,
	parseProfilesImport,
	readProfiles,
	serializeProfilesExport,
	writeProfiles
} from '../src/lib/profiles.js';

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

function sampleProfile(overrides = {}) {
	return {
		id: 'fixed-id',
		name: 'My Profile',
		provider: 'openai',
		baseUrl: 'https://api.openai.com',
		model: 'gpt-test',
		systemPrompt: 'You are helpful.',
		temperature: 0.7,
		topP: 1,
		presencePenalty: 0,
		frequencyPenalty: 0,
		maxTokens: 1024,
		anthropicVersion: '2023-06-01',
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_123,
		...overrides
	};
}

test('writeProfiles/readProfiles: should never persist apiKey', () => {
	const storage = new MemoryStorage();
	writeProfiles(storage, {
		v: 1,
		currentId: 'fixed-id',
		items: [sampleProfile({ apiKey: 'sk-secret' })]
	});

	const raw = storage.getItem(PROFILES_STORAGE_KEY);
	assert.ok(raw);
	assert.equal(raw.includes('sk-secret'), false);

	const read = readProfiles(storage);
	assert.equal(read.items.length, 1);
	assert.equal('apiKey' in read.items[0], false);
});

test('serializeProfilesExport: default should not include apiKey even if injected', () => {
	const json = serializeProfilesExport([sampleProfile({ apiKey: 'sk-secret' })]);
	assert.equal(json.includes('sk-secret'), false);
});

test('buildProfilesExport: envelope metadata', () => {
	const exp = buildProfilesExport([sampleProfile()], { now: 123 });
	assert.equal(exp.kind, PROFILES_EXPORT_KIND);
	assert.equal(exp.v, PROFILES_EXPORT_VERSION);
	assert.equal(exp.exportedAt, 123);
	assert.equal(exp.profiles.length, 1);
});

test('encode/decode profiles hash: roundtrip (single uses #profile=)', () => {
	const exp = buildProfilesExport([sampleProfile()], { now: 123 });
	const hash = encodeProfilesToHash(exp);
	assert.ok(hash.startsWith(PROFILE_HASH_PREFIX));

	const decoded = decodeProfilesFromHash(hash);
	assert.ok(decoded);
	if (!decoded) return;

	assert.equal(decoded.kind, PROFILES_EXPORT_KIND);
	assert.equal(decoded.v, PROFILES_EXPORT_VERSION);
	assert.equal(decoded.profiles.length, 1);
	assert.equal(decoded.profiles[0].name, 'My Profile');
});

test('encode profiles hash: multiple uses #profiles=', () => {
	const exp = buildProfilesExport([sampleProfile({ id: 'a' }), sampleProfile({ id: 'b', name: 'B' })], { now: 123 });
	const hash = encodeProfilesToHash(exp);
	assert.ok(hash.startsWith(PROFILES_HASH_PREFIX));
});

test('buildProfilesShareUrl: too long should fail with reason', () => {
	const profile = sampleProfile({ systemPrompt: 'x'.repeat(50_000) });
	const out = buildProfilesShareUrl({ baseUrl: 'https://site.example', profiles: [profile], maxUrlLength: 500 });
	assert.equal(out.ok, false);
	if (out.ok) return;
	assert.match(out.reason, /过长/);
});

test('parseProfilesImport: clamp and provider fallback + forceNewId', () => {
	const exp = buildProfilesExport([
		sampleProfile({
			id: 'fixed-id',
			provider: 'bad',
			temperature: 99,
			topP: -1,
			presencePenalty: -99,
			frequencyPenalty: 99,
			maxTokens: 0
		})
	]);

	const res = parseProfilesImport(JSON.stringify(exp), { now: 999, keepApiKey: true });
	assert.equal(res.ok, true);
	if (!res.ok) return;

	assert.equal(res.profiles.length, 1);
	const p = res.profiles[0];
	assert.notEqual(p.id, 'fixed-id');
	assert.equal(p.provider, 'openai');
	assert.equal(p.temperature, 2);
	assert.equal(p.topP, 0);
	assert.equal(p.presencePenalty, -2);
	assert.equal(p.frequencyPenalty, 2);
	assert.equal(p.maxTokens, 1);
});

test('parseProfilesImport: kind mismatch should fail', () => {
	const res = parseProfilesImport(JSON.stringify({ kind: 'x', v: 1, profiles: [] }));
	assert.equal(res.ok, false);
	if (res.ok) return;
	assert.match(res.error, /kind/);
});

