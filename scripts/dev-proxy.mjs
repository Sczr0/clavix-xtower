import { createServer } from 'node:http';
import { Readable } from 'node:stream';

import { handleRequest } from '../functions/index.js';

const port = Number(process.env.PORT ?? 8787);

function nodeHeadersToWebHeaders(nodeHeaders) {
	const headers = new Headers();
	for (const [key, value] of Object.entries(nodeHeaders)) {
		if (typeof value === 'undefined') continue;
		if (Array.isArray(value)) headers.set(key, value.join(','));
		else headers.set(key, value);
	}
	return headers;
}

async function readBody(req) {
	if (req.method === 'GET' || req.method === 'HEAD') return undefined;
	const chunks = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

createServer(async (req, res) => {
	try {
		const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
		const body = await readBody(req);

		const request = new Request(url, {
			method: req.method,
			headers: nodeHeadersToWebHeaders(req.headers),
			body
		});

		const response = await handleRequest(request);

		res.statusCode = response.status;
		for (const [k, v] of response.headers.entries()) res.setHeader(k, v);

		if (!response.body) {
			res.end();
			return;
		}

		Readable.fromWeb(response.body).pipe(res);
	} catch (e) {
		res.statusCode = 500;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
	}
}).listen(port, () => {
	console.log(`dev-proxy listening on http://127.0.0.1:${port}`);
});
