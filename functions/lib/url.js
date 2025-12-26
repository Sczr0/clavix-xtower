function isProbablyIp(hostname) {
	// IPv4
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
	// IPv6（含方括号或不含）
	if (/^\[?[0-9a-fA-F:]+\]?$/.test(hostname) && hostname.includes(':')) return true;
	return false;
}

function isBlockedHostname(hostname) {
	const h = hostname.toLowerCase();
	if (h === 'localhost' || h.endsWith('.localhost')) return true;
	if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal')) return true;
	return false;
}

export function validateBaseUrl(baseUrl) {
	if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw new Error('baseUrl 不能为空');

	let url;
	try {
		url = new URL(baseUrl.trim());
	} catch {
		throw new Error('baseUrl 必须是合法 URL');
	}

	if (url.username || url.password) throw new Error('baseUrl 不允许包含用户名或密码');
	if (url.protocol !== 'https:') throw new Error('baseUrl 必须使用 https');
	if (url.port) throw new Error('baseUrl 不允许显式指定端口');
	if (url.search || url.hash) throw new Error('baseUrl 不允许包含 query/hash');
	const basePath = url.pathname.replace(/\/+$/, '');
	if (basePath && basePath !== '' && basePath !== '/' && !basePath.endsWith('/v1')) {
		throw new Error('baseUrl 仅允许无路径或以 /v1 结尾，例如：https://api.openai.com 或 https://openrouter.ai/api/v1');
	}

	const hostname = url.hostname;
	if (isProbablyIp(hostname)) {
		throw new Error('baseUrl 不能是 IP 地址（ESA Fetch API 不支持 IP），请使用域名或通过隧道映射域名');
	}
	if (isBlockedHostname(hostname)) throw new Error('baseUrl 不允许指向本地/内网保留域名（例如 localhost/.local）');

	return url;
}

export function buildUpstreamUrl({ provider, baseUrl }) {
	const base = validateBaseUrl(baseUrl);
	const basePath = base.pathname.replace(/\/+$/, '');
	const apiPrefix = basePath.endsWith('/v1') ? basePath : `${basePath}/v1`;

	if (provider === 'openai') return new URL(`${apiPrefix}/chat/completions`, base.origin);
	if (provider === 'anthropic') return new URL(`${apiPrefix}/messages`, base.origin);

	throw new Error('不支持的 provider');
}
