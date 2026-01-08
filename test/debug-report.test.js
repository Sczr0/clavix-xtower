import assert from 'node:assert/strict';
import test from 'node:test';

import {
	DEBUG_REPORT_KIND,
	DEBUG_REPORT_HASH_PREFIX,
	DEBUG_REPORT_VERSION,
	buildDebugReportShareUrl,
	createDebugReport,
	decodeDebugReportFromHash,
	encodeDebugReportToHash,
	toDebugReportJson,
	toDebugReportMarkdown
} from '../src/lib/debug-report.js';

function createSampleSession(overrides = {}) {
	return {
		startedAt: 1_700_000_000_000,
		endedAt: 1_700_000_000_123,
		aborted: false,
		provider: 'openai',
		baseUrl: 'https://api.openai.com',
		model: 'gpt-test',
		upstreamUrl: 'https://api.openai.com/v1/chat/completions',
		proxyStatus: 200,
		proxyOk: true,
		proxyErrorText: null,
		firstEventAt: 1_700_000_000_010,
		eventCount: 3,
		bytesApprox: 1024,
		events: [
			{ n: 1, at: 1_700_000_000_011, event: null, id: null, dataLen: 12, dataSnippet: '{"ok":true}' }
		],
		origin: 'https://example.com',
		proxyPayloadBase: {
			provider: 'openai',
			baseUrl: 'https://api.openai.com',
			request: {
				model: 'gpt-test',
				messages: [
					{ role: 'user', content: 'hello' },
					{ role: 'assistant', content: 'world' }
				],
				stream: true
			}
		},
		// 注意：这里故意放一个“看起来像 key”的字符串，验证导出不会引入明文 key
		proxyPayloadMaskedJson: '{"apiKey":"sk…7890","request":{"model":"gpt-test"}}',
		upstreamRequestJson: '{"model":"gpt-test","messages":[{"role":"user","content":"hello"}]}',
		proxyCurl: "curl -N '/api/chat' \\\n+  -H 'content-type: application/json' \\\n+  --data '{\"apiKey\":\"YOUR_API_KEY\"}'".replaceAll('\n+ ', '\n  '),
		upstreamCurl: "curl -N 'https://api.openai.com/v1/chat/completions' \\\n+  -H 'authorization: Bearer YOUR_API_KEY'".replaceAll('\n+ ', '\n  '),
		...overrides
	};
}

test('createDebugReport: v1 envelope', () => {
	const session = createSampleSession();
	const report = createDebugReport(session, { now: 123, mode: 'full' });

	assert.equal(report.kind, DEBUG_REPORT_KIND);
	assert.equal(report.v, DEBUG_REPORT_VERSION);
	assert.equal(report.createdAt, 123);
	assert.equal(report.mode, 'full');
	assert.ok(report.session);
});

test('encode/decode debug report hash: roundtrip', () => {
	const session = createSampleSession();
	const report = createDebugReport(session, { now: 123, mode: 'full' });

	const hash = encodeDebugReportToHash(report);
	assert.ok(hash.startsWith(DEBUG_REPORT_HASH_PREFIX));

	const decoded = decodeDebugReportFromHash(hash);
	assert.ok(decoded);
	if (!decoded) return;

	assert.equal(decoded.kind, DEBUG_REPORT_KIND);
	assert.equal(decoded.v, DEBUG_REPORT_VERSION);
	assert.equal(decoded.createdAt, 123);
	assert.equal(decoded.session.provider, 'openai');
	assert.equal(decoded.session.model, 'gpt-test');
});

test('share url: too long should fail with reason', () => {
	const session = createSampleSession({
		upstreamRequestJson: 'x'.repeat(50_000),
		proxyPayloadMaskedJson: 'y'.repeat(50_000)
	});

	const out = buildDebugReportShareUrl({ baseUrl: 'https://site.example', session, maxUrlLength: 500 });
	assert.equal(out.ok, false);
	if (out.ok) return;
	assert.match(out.reason, /过长/);
});

test('share url: ok for small payload', () => {
	const session = createSampleSession();
	const out = buildDebugReportShareUrl({ baseUrl: 'https://site.example', session, maxUrlLength: 10_000 });
	assert.equal(out.ok, true);
	if (!out.ok) return;
	assert.ok(out.url.startsWith('https://site.example#debug='));
});

test('exports: json and markdown should not include apiKey secret even if injected', () => {
	const session = createSampleSession({
		apiKey: 'sk-secret',
		proxyPayloadBase: {
			provider: 'openai',
			baseUrl: 'https://api.openai.com',
			apiKey: 'sk-secret',
			request: { model: 'gpt-test', messages: [] }
		}
	});
	const report = createDebugReport(session, { now: 123, mode: 'full' });

	const json = toDebugReportJson(report);
	const md = toDebugReportMarkdown(report);

	assert.equal(json.includes('sk-secret'), false);
	assert.equal(md.includes('sk-secret'), false);
});
