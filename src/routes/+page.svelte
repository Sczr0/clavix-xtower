<script lang="ts">
	import { streamSse, type SseEvent } from '$lib/sse';

	type Provider = 'openai' | 'anthropic';
	type Role = 'user' | 'assistant';

	type ChatMessage = {
		id: string;
		role: Role;
		content: string;
		at: number;
	};

	type UpstreamError = {
		status?: number;
		message: string;
	};

	const DEFAULTS: Record<Provider, { baseUrl: string; modelPlaceholder: string; version?: string }> = {
		openai: { baseUrl: 'https://api.openai.com', modelPlaceholder: '例如：gpt-4o-mini（或你的 OpenAI 兼容模型）' },
		anthropic: {
			baseUrl: 'https://api.anthropic.com',
			modelPlaceholder: '例如：claude-3-5-sonnet-20241022',
			version: '2023-06-01'
		}
	};

	let provider = $state<Provider>('openai');
	let baseUrl = $state(DEFAULTS.openai.baseUrl);
	let apiKey = $state('');
	let model = $state('');
	let systemPrompt = $state('');
	let temperature = $state(0.7);
	let maxTokens = $state(1024);
	let anthropicVersion = $state(DEFAULTS.anthropic.version ?? '2023-06-01');

	let prompt = $state('');
	let messages = $state<ChatMessage[]>([]);
	let assistantDraft = $state('');
	let streaming = $state(false);
	let lastEvent = $state<string | null>(null);
	let error = $state<string | null>(null);

	let abortController: AbortController | null = null;

	function resetForProvider(next: Provider) {
		baseUrl = DEFAULTS[next].baseUrl;
		model = '';
		lastEvent = null;
		error = null;
	}

	function fmtTime(ts: number) {
		return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	function push(role: Role, content: string) {
		const id = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
		messages.push({ id, role, content, at: Date.now() });
	}

	function stop() {
		abortController?.abort();
	}

	function clearChat() {
		stop();
		messages = [];
		assistantDraft = '';
		error = null;
		lastEvent = null;
	}

	function parseProxyErrorEvent(event: SseEvent): UpstreamError | null {
		if (event.event !== 'error') return null;
		try {
			const parsed = JSON.parse(event.data) as UpstreamError;
			if (!parsed?.message) return { message: event.data };
			return parsed;
		} catch {
			return { message: event.data };
		}
	}

	function applyOpenAiDelta(event: SseEvent) {
		if (event.data === '[DONE]') return false;
		try {
			const parsed = JSON.parse(event.data) as any;
			const delta = parsed?.choices?.[0]?.delta;
			if (typeof delta?.content === 'string') assistantDraft += delta.content;
			const text = parsed?.choices?.[0]?.text;
			if (typeof text === 'string') assistantDraft += text;
		} catch {
			// 忽略无法解析的碎片
		}
		return true;
	}

	function applyAnthropicDelta(event: SseEvent) {
		try {
			const parsed = JSON.parse(event.data) as any;
			const type = (event.event ?? parsed?.type ?? '') as string;
			if (type === 'content_block_delta') {
				const delta = parsed?.delta ?? {};
				if (typeof delta?.text === 'string') assistantDraft += delta.text;
				else if (typeof delta?.text_delta?.text === 'string') assistantDraft += delta.text_delta.text;
			}
		} catch {
			// 忽略无法解析的碎片
		}
		return true;
	}

	async function send() {
		error = null;
		lastEvent = null;

		if (streaming) return;
		if (!prompt.trim()) return;
		if (!baseUrl.trim()) {
			error = '请填写上游 Base URL（必须是 https 域名，可选以 /v1 结尾；不允许 IP/端口/query）。';
			return;
		}
		if (!apiKey.trim()) {
			error = '请填写 API Key（仅保存在浏览器内存，不会写入服务端存储）。';
			return;
		}
		if (!model.trim()) {
			error = '请填写模型名。';
			return;
		}

		push('user', prompt.trim());
		prompt = '';
		assistantDraft = '';

		streaming = true;
		abortController = new AbortController();

		try {
			const request =
				provider === 'openai'
					? {
							model: model.trim(),
							messages: [
								...(systemPrompt.trim() ? [{ role: 'system', content: systemPrompt.trim() }] : []),
								...messages.map((m) => ({ role: m.role, content: m.content }))
							],
							temperature: Number.isFinite(temperature) ? temperature : 0.7,
							max_tokens: Number.isFinite(maxTokens) ? maxTokens : 1024,
							stream: true
						}
					: {
							model: model.trim(),
							system: systemPrompt.trim() ? systemPrompt.trim() : undefined,
							messages: messages.map((m) => ({ role: m.role, content: [{ type: 'text', text: m.content }] })),
							max_tokens: Number.isFinite(maxTokens) ? maxTokens : 1024,
							stream: true
						};

			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					provider,
					baseUrl: baseUrl.trim(),
					apiKey: apiKey.trim(),
					anthropicVersion: provider === 'anthropic' ? anthropicVersion.trim() : undefined,
					request
				}),
				signal: abortController.signal
			});

			if (!res.ok) {
				const text = await res.text().catch(() => '');
				error = `代理请求失败（HTTP ${res.status}）${text ? `：${text}` : ''}`;
				return;
			}

			await streamSse(
				res,
				(event) => {
					lastEvent = event.event;

					const proxyErr = parseProxyErrorEvent(event);
					if (proxyErr) {
						error = proxyErr.status ? `上游错误（HTTP ${proxyErr.status}）：${proxyErr.message}` : proxyErr.message;
						return false;
					}

					return provider === 'openai' ? applyOpenAiDelta(event) : applyAnthropicDelta(event);
				},
				{ signal: abortController.signal }
			);
		} catch (e) {
			if (abortController.signal.aborted) error = '已停止。';
			else error = e instanceof Error ? e.message : String(e);
		} finally {
			streaming = false;
			abortController = null;

			const finalText = assistantDraft.trim();
			if (finalText) {
				push('assistant', finalText);
				assistantDraft = '';
			}
		}
	}
</script>

<div class="container">
	<div class="grid">
		<section class="card">
			<div class="card-header">
				<h2 class="card-title">
					<span>连接设置</span>
					<span class="pill">{streaming ? 'Streaming' : 'Idle'}</span>
				</h2>
			</div>
			<div class="card-body">
				<div class="row">
					<div class="field">
						<label for="provider">Provider</label>
						<select
							id="provider"
							bind:value={provider}
							onchange={() => resetForProvider(provider)}
							disabled={streaming}
						>
							<option value="openai">OpenAI Compatible</option>
							<option value="anthropic">Anthropic</option>
						</select>
					</div>

					<div class="field">
						<label for="baseUrl">上游 Base URL</label>
						<input
							id="baseUrl"
							bind:value={baseUrl}
							placeholder="例如：https://api.openai.com 或 https://openrouter.ai/api/v1"
							disabled={streaming}
							autocapitalize="off"
							autocomplete="off"
							spellcheck="false"
						/>
						<div class="help">
							ESA Fetch API 不支持 IP 地址；如需接入 LocalAI，请用隧道/反代暴露为公网域名的 HTTPS。
						</div>
					</div>

					<div class="field">
						<label for="apiKey">API Key</label>
						<input
							id="apiKey"
							type="password"
							bind:value={apiKey}
							placeholder="仅保存在浏览器内存，不会写入持久化存储"
							disabled={streaming}
							autocapitalize="off"
							autocomplete="off"
							spellcheck="false"
						/>
					</div>

					<div class="field">
						<label for="model">Model</label>
						<input
							id="model"
							bind:value={model}
							placeholder={DEFAULTS[provider].modelPlaceholder}
							disabled={streaming}
							autocapitalize="off"
							autocomplete="off"
							spellcheck="false"
						/>
					</div>

					<div class="field">
						<label for="system">System（可选）</label>
						<textarea
							id="system"
							bind:value={systemPrompt}
							placeholder="例如：你是一个严格遵循指令的助手。"
							disabled={streaming}
						></textarea>
					</div>

					<div class="field">
						<label for="temperature">Temperature</label>
						<input
							id="temperature"
							type="number"
							min="0"
							max="2"
							step="0.1"
							bind:value={temperature}
							disabled={streaming || provider !== 'openai'}
						/>
						<div class="help">{provider === 'openai' ? 'OpenAI Compatible 生效。' : 'Anthropic 忽略该参数。'}</div>
					</div>

					<div class="field">
						<label for="maxTokens">Max tokens</label>
						<input id="maxTokens" type="number" min="1" step="1" bind:value={maxTokens} disabled={streaming} />
					</div>

					{#if provider === 'anthropic'}
						<div class="field">
							<label for="anthropicVersion">anthropic-version</label>
							<input
								id="anthropicVersion"
								bind:value={anthropicVersion}
								placeholder="例如：2023-06-01"
								disabled={streaming}
								autocapitalize="off"
								autocomplete="off"
								spellcheck="false"
							/>
						</div>
					{/if}

					<div class="actions">
						<button class="btn danger" type="button" onclick={stop} disabled={!streaming}>停止</button>
						<button class="btn" type="button" onclick={clearChat} disabled={streaming || messages.length === 0}>
							清空对话
						</button>
					</div>

					<div class="help">
						强提醒：允许自定义上游会带来开放代理/滥用风险；建议上线前启用域名白名单、限流与风控。
					</div>
				</div>
			</div>
		</section>

		<section class="card chat">
			<div class="chat-header">
				<h1>EdgeAI Playground</h1>
				<p>
					同域 `/api/chat` 由 ESA Edge Function 代理转发并流式回传（SSE）。<span class="nowrap"
						>最后事件：{lastEvent ?? '—'}</span
					>
				</p>
			</div>

			<div class="messages">
				{#if error}
					<div class="error">{error}</div>
				{/if}

				{#if messages.length === 0}
					<div class="msg">
						<div class="meta"><span class="dim">提示</span></div>
						<pre>
1) 选择 Provider，填写 Base URL / Key / Model
2) 在下方输入问题，点击发送
3) 如出现 504，多数是上游首包太慢或被阻断；请检查网络、模型与 Base URL</pre
						>
					</div>
				{/if}

				{#each messages as m (m.id)}
					<div class="msg {m.role}">
						<div class="meta">
							<span>{m.role === 'user' ? 'User' : 'Assistant'}</span>
							<span>{fmtTime(m.at)}</span>
						</div>
						<pre>{m.content}</pre>
					</div>
				{/each}

				{#if streaming}
					<div class="msg assistant">
						<div class="meta">
							<span>Assistant（生成中）</span>
							<span class="ok">...</span>
						</div>
						<pre>{assistantDraft}</pre>
					</div>
				{/if}
			</div>

			<div class="composer">
				<div class="field">
					<label for="prompt">输入</label>
					<textarea
						id="prompt"
						bind:value={prompt}
						placeholder="Shift+Enter 换行，Enter 发送（可在输入法候选后再按 Enter）"
						disabled={streaming}
						onkeydown={(e) => {
							if (e.key !== 'Enter' || e.shiftKey) return;
							e.preventDefault();
							void send();
						}}
					></textarea>
				</div>

				<div class="actions">
					<button class="btn primary" type="button" onclick={send} disabled={streaming || !prompt.trim()}>
						发送
					</button>
					<a class="btn" href="https://www.alibabacloud.com/help/zh/esa" target="_blank" rel="noreferrer">
						ESA 文档
					</a>
				</div>
			</div>
		</section>
	</div>
</div>
