import assert from 'node:assert/strict';
import test from 'node:test';

import { formatRelativeTime } from '../src/lib/time.js';

function localYmd(tsMs) {
	const d = new Date(tsMs);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

test('formatRelativeTime: returns — for invalid inputs', () => {
	assert.equal(formatRelativeTime(null, 0), '—');
	assert.equal(formatRelativeTime(undefined, 0), '—');
	assert.equal(formatRelativeTime('', 0), '—');
	assert.equal(formatRelativeTime('nope', 0), '—');
	assert.equal(formatRelativeTime(NaN, 0), '—');
});

test('formatRelativeTime: 刚刚 (<60s)', () => {
	const now = 1_700_000_000_000;
	assert.equal(formatRelativeTime(now, now), '刚刚');
	assert.equal(formatRelativeTime(now - 59_999, now), '刚刚');
});

test('formatRelativeTime: 分钟前 (<60min)', () => {
	const now = 1_700_000_000_000;
	assert.equal(formatRelativeTime(now - 60_000, now), '1 分钟前');
	assert.equal(formatRelativeTime(now - 5 * 60_000 - 1, now), '5 分钟前');
});

test('formatRelativeTime: 小时前 (<24h)', () => {
	const now = 1_700_000_000_000;
	assert.equal(formatRelativeTime(now - 60 * 60_000, now), '1 小时前');
	assert.equal(formatRelativeTime(now - 23 * 60 * 60_000 - 1, now), '23 小时前');
});

test('formatRelativeTime: 日期 (>=24h)', () => {
	const ts = new Date(2026, 0, 2, 12, 0, 0, 0).getTime();
	const now = ts + 24 * 60 * 60_000;
	assert.equal(formatRelativeTime(ts, now), localYmd(ts));
});

