import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateUsdCost, formatUsd } from '../src/lib/cost.js';

test('estimateUsdCost: returns null when missing inputs', () => {
	assert.equal(estimateUsdCost(null, { inputUsdPer1M: 1, outputUsdPer1M: 1 }), null);
	assert.equal(estimateUsdCost({ inputTokens: 1 }, null), null);
});

test('estimateUsdCost: returns null when prices are 0', () => {
	assert.equal(estimateUsdCost({ inputTokens: 100, outputTokens: 200 }, { inputUsdPer1M: 0, outputUsdPer1M: 0 }), null);
});

test('estimateUsdCost: estimates by input/output tokens', () => {
	const cost = estimateUsdCost({ inputTokens: 2_000_000, outputTokens: 500_000 }, { inputUsdPer1M: 1, outputUsdPer1M: 2 });
	assert.equal(cost, 2 * 1 + 0.5 * 2);
});

test('estimateUsdCost: clamps negative values', () => {
	const cost = estimateUsdCost(
		{ inputTokens: -100, outputTokens: 1_000_000 },
		{ inputUsdPer1M: -10, outputUsdPer1M: 3 }
	);
	assert.equal(cost, 3);
});

test('formatUsd: formats by magnitude', () => {
	assert.equal(formatUsd(null), '—');
	assert.equal(formatUsd(0), '$0');
	assert.equal(formatUsd(0.000009), '$0.000009');
	assert.equal(formatUsd(0.5), '$0.5000');
	assert.equal(formatUsd(12.3456), '$12.35');
});

