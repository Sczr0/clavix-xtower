import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCompareTargetIds, toggleCompareTargetId } from '../src/lib/compare.js';

test('normalizeCompareTargetIds: trims, de-dupes, allows empty', () => {
	assert.deepEqual(normalizeCompareTargetIds(['  a  ', 'a', '', '  ', 'b'], { maxTargets: 10 }), ['a', 'b']);
	assert.deepEqual(normalizeCompareTargetIds([], { maxTargets: 10 }), []);
	assert.deepEqual(normalizeCompareTargetIds(null, { maxTargets: 10 }), []);
});

test('normalizeCompareTargetIds: caps by maxTargets', () => {
	assert.deepEqual(normalizeCompareTargetIds(['a', 'b', 'c'], { maxTargets: 2 }), ['a', 'b']);
	assert.deepEqual(normalizeCompareTargetIds(['a', 'b', 'c'], { maxTargets: 1 }), ['a']);
});

test('toggleCompareTargetId: can remove last item (no forced fallback)', () => {
	assert.deepEqual(toggleCompareTargetId(['__current'], '__current', false, { maxTargets: 6 }), []);
});

test('toggleCompareTargetId: adds/removes and respects maxTargets', () => {
	assert.deepEqual(toggleCompareTargetId(['a'], 'b', true, { maxTargets: 2 }), ['a', 'b']);
	assert.deepEqual(toggleCompareTargetId(['a', 'b'], 'c', true, { maxTargets: 2 }), ['a', 'b']);
	assert.deepEqual(toggleCompareTargetId(['a', 'b'], 'a', false, { maxTargets: 2 }), ['b']);
});

test('toggleCompareTargetId: ignores blank id', () => {
	assert.deepEqual(toggleCompareTargetId(['a'], '   ', true, { maxTargets: 2 }), ['a']);
});
