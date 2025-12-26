function sameOrigin(requestOrigin, requestUrl) {
	try {
		const reqOrigin = new URL(requestOrigin).origin;
		return reqOrigin === new URL(requestUrl).origin;
	} catch {
		return false;
	}
}

export function corsHeaders(request) {
	const origin = request.headers.get('origin');
	const headers = new Headers();

	// 默认仅允许同源调用，避免第三方站点把它当成浏览器侧开放代理使用
	if (origin && sameOrigin(origin, request.url)) headers.set('access-control-allow-origin', origin);

	headers.set('vary', 'Origin');
	headers.set('access-control-allow-methods', 'POST, OPTIONS');
	headers.set('access-control-allow-headers', 'content-type');
	headers.set('access-control-max-age', '86400');

	return headers;
}

