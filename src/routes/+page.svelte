<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { streamSse, type SseEvent } from '$lib/sse';
	import { renderMarkdownToHtml } from '$lib/markdown';
	import {
		createAnthropicSseContext,
		createThoughtChainSplitter,
		parseAnthropicSseEvent,
		parseOpenAiSseData
	} from '$lib/thought-chain';

	type Provider = 'openai' | 'anthropic';
	type Role = 'user' | 'assistant';

	type ChatMessage = {
		id: string;
		role: Role;
		content: string;
		thinking?: string;
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

	type ProviderCache = {
		openai: { baseUrl: string; model: string; temperature: number };
		anthropic: { baseUrl: string; model: string; anthropicVersion: string };
	};

	type StoredSettingsV1 = {
		v: 1;
		provider: Provider;
		openai: ProviderCache['openai'];
		anthropic: ProviderCache['anthropic'];
		common: {
			systemPrompt: string;
			maxTokens: number;
			showThinking: boolean;
			thinkingAutoExpand: boolean;
		};
	};

	const SETTINGS_STORAGE_KEY = 'edgeai-playground:settings:v1';

	function safeString(v: unknown, fallback: string) {
		return typeof v === 'string' ? v : fallback;
	}

	function safeBoolean(v: unknown, fallback: boolean) {
		return typeof v === 'boolean' ? v : fallback;
	}

	function safeNumber(v: unknown, fallback: number) {
		const n = typeof v === 'number' ? v : Number(v);
		return Number.isFinite(n) ? n : fallback;
	}

	function clamp(n: number, min: number, max: number) {
		return Math.min(max, Math.max(min, n));
	}

	function safeProvider(v: unknown): Provider {
		return v === 'anthropic' || v === 'openai' ? v : 'openai';
	}

	function readSettings(): StoredSettingsV1 | null {
		try {
			const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
			if (!raw) return null;
			const parsed = JSON.parse(raw) as any;
			if (!parsed || parsed.v !== 1) return null;

			const openai = parsed.openai ?? {};
			const anthropic = parsed.anthropic ?? {};
			const common = parsed.common ?? {};

			return {
				v: 1,
				provider: safeProvider(parsed.provider),
				openai: {
					baseUrl: safeString(openai.baseUrl, DEFAULTS.openai.baseUrl),
					model: safeString(openai.model, ''),
					temperature: clamp(safeNumber(openai.temperature, 0.7), 0, 2)
				},
				anthropic: {
					baseUrl: safeString(anthropic.baseUrl, DEFAULTS.anthropic.baseUrl),
					model: safeString(anthropic.model, ''),
					anthropicVersion: safeString(anthropic.anthropicVersion, DEFAULTS.anthropic.version ?? '2023-06-01')
				},
				common: {
					systemPrompt: safeString(common.systemPrompt, ''),
					maxTokens: Math.max(1, Math.floor(safeNumber(common.maxTokens, 1024))),
					showThinking: safeBoolean(common.showThinking, false),
					thinkingAutoExpand: safeBoolean(common.thinkingAutoExpand, false)
				}
			};
		} catch {
			return null;
		}
	}

	function writeSettings(settings: StoredSettingsV1) {
		try {
			localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
		} catch {
			// localStorage 可能被禁用（隐私模式/策略）
		}
	}

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
	let assistantThinkingDraft = $state('');
	let streaming = $state(false);
	let lastEvent = $state<string | null>(null);
	let error = $state<string | null>(null);

	let settingsHydrated = $state(false);

	let providerCache: ProviderCache = {
		openai: { baseUrl: DEFAULTS.openai.baseUrl, model: '', temperature: 0.7 },
		anthropic: {
			baseUrl: DEFAULTS.anthropic.baseUrl,
			model: '',
			anthropicVersion: DEFAULTS.anthropic.version ?? '2023-06-01'
		}
	};
	let lastProvider: Provider = 'openai';
	let saveTimer: number | null = null;

	let settingsOpen = $state(false);

	let showThinking = $state(false);
	let thinkingAutoExpand = $state(false);
	let thinkingVisibleById = $state<Record<string, boolean>>({});
	let thinkingOpenById = $state<Record<string, boolean>>({});
	let streamingThinkingVisible = $state(false);
	let streamingThinkingOpen = $state(false);

	let messagesEl: HTMLDivElement | null = null;
	let stickToBottom = $state(true);
	const MAX_RENDER_MESSAGES = 200;
	let renderAllMessages = $state(false);

	let abortController: AbortController | null = null;

	let thoughtSplitter = createThoughtChainSplitter();
	let anthropicCtx = createAnthropicSseContext();

	function handleGlobalKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		settingsOpen = false;
	}

	async function copyToClipboard(text: string) {
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			return;
		} catch {
			// 兼容：Safari/部分 WebView 可能不支持 clipboard API
		}

		const el = document.createElement('textarea');
		el.value = text;
		el.style.position = 'fixed';
		el.style.left = '-9999px';
		el.style.top = '0';
		document.body.appendChild(el);
		el.select();
		document.execCommand('copy');
		document.body.removeChild(el);
	}

	function handleMessagesClick(e: MouseEvent) {
		const target = e.target as HTMLElement | null;
		const btn = target?.closest?.('button[data-copy-code]') as HTMLButtonElement | null;
		if (!btn) return;

		const root = btn.closest?.('.md-code') as HTMLElement | null;
		const codeEl = root?.querySelector?.('pre code') as HTMLElement | null;
		const text = codeEl?.textContent ?? '';
		if (!text) return;

		btn.disabled = true;
		const oldText = btn.textContent ?? '复制';

		void copyToClipboard(text)
			.then(() => {
				btn.textContent = '已复制';
				setTimeout(() => {
					btn.textContent = oldText;
					btn.disabled = false;
				}, 1200);
			})
			.catch(() => {
				btn.textContent = '复制失败';
				setTimeout(() => {
					btn.textContent = oldText;
					btn.disabled = false;
				}, 1200);
			});
	}

	function delegateCopy(el: HTMLElement) {
		const onClick = (e: MouseEvent) => handleMessagesClick(e);
		el.addEventListener('click', onClick);
		return {
			destroy() {
				el.removeEventListener('click', onClick);
			}
		};
	}

	function getMessageThinkingOpen(id: string) {
		const v = thinkingOpenById[id];
		return typeof v === 'boolean' ? v : thinkingAutoExpand;
	}

	function toggleMessageThinking(id: string) {
		if (showThinking) {
			thinkingOpenById[id] = !getMessageThinkingOpen(id);
			return;
		}

		const nextVisible = !thinkingVisibleById[id];
		thinkingVisibleById[id] = nextVisible;
		thinkingOpenById[id] = nextVisible ? true : false;
	}

	function handleMessageThinkingToggle(id: string, e: Event) {
		const details = e.currentTarget as HTMLDetailsElement;
		thinkingOpenById[id] = details.open;
		if (!showThinking) thinkingVisibleById[id] = true;
	}

	function getStreamingThinkingOpen() {
		return streamingThinkingOpen || thinkingAutoExpand;
	}

	function toggleStreamingThinking() {
		if (showThinking) {
			streamingThinkingOpen = !getStreamingThinkingOpen();
			return;
		}

		streamingThinkingVisible = !streamingThinkingVisible;
		if (streamingThinkingVisible) streamingThinkingOpen = true;
	}

	function handleStreamingThinkingToggle(e: Event) {
		const details = e.currentTarget as HTMLDetailsElement;
		streamingThinkingOpen = details.open;
		if (!showThinking) streamingThinkingVisible = true;
	}

	function syncStickToBottom() {
		if (!messagesEl) return;
		const thresholdPx = 80;
		const remaining = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
		stickToBottom = remaining < thresholdPx;
	}

	async function scrollMessagesToBottom() {
		await tick();
		if (!messagesEl) return;
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	$effect(() => {
		// 依赖：消息/草稿/流式状态变化时，若用户在底部附近则自动跟随滚动
		messages.length;
		assistantDraft;
		assistantThinkingDraft;
		streaming;

		if (!stickToBottom) return;
		void scrollMessagesToBottom();
	});

	function snapshotProviderToCache(p: Provider) {
		if (p === 'openai') {
			providerCache.openai.baseUrl = baseUrl;
			providerCache.openai.model = model;
			providerCache.openai.temperature = clamp(Number.isFinite(temperature) ? temperature : 0.7, 0, 2);
		} else {
			providerCache.anthropic.baseUrl = baseUrl;
			providerCache.anthropic.model = model;
			providerCache.anthropic.anthropicVersion = anthropicVersion;
		}
	}

	function applyCacheToFields(p: Provider) {
		if (p === 'openai') {
			baseUrl = providerCache.openai.baseUrl || DEFAULTS.openai.baseUrl;
			model = providerCache.openai.model || '';
			temperature = clamp(Number.isFinite(providerCache.openai.temperature) ? providerCache.openai.temperature : 0.7, 0, 2);
			return;
		}

		baseUrl = providerCache.anthropic.baseUrl || DEFAULTS.anthropic.baseUrl;
		model = providerCache.anthropic.model || '';
		anthropicVersion = providerCache.anthropic.anthropicVersion || (DEFAULTS.anthropic.version ?? '2023-06-01');
	}

	function switchProvider(next: Provider) {
		// 保存“上一个 provider”的编辑结果，再切换到新 provider 的缓存值
		snapshotProviderToCache(lastProvider);
		lastProvider = next;
		applyCacheToFields(next);
		lastEvent = null;
		error = null;
	}

	onMount(() => {
		const saved = readSettings();
		if (saved) {
			providerCache.openai.baseUrl = saved.openai.baseUrl;
			providerCache.openai.model = saved.openai.model;
			providerCache.openai.temperature = saved.openai.temperature;

			providerCache.anthropic.baseUrl = saved.anthropic.baseUrl;
			providerCache.anthropic.model = saved.anthropic.model;
			providerCache.anthropic.anthropicVersion = saved.anthropic.anthropicVersion;

			systemPrompt = saved.common.systemPrompt;
			maxTokens = saved.common.maxTokens;
			showThinking = saved.common.showThinking;
			thinkingAutoExpand = saved.common.thinkingAutoExpand;

			provider = saved.provider;
			lastProvider = provider;
			applyCacheToFields(provider);
		} else {
			lastProvider = provider;
			snapshotProviderToCache(provider);
		}

		settingsHydrated = true;
	});

	$effect(() => {
		if (!settingsHydrated) return;

		// 依赖：仅保存“非敏感设置”，API Key 明确不落盘
		provider;
		baseUrl;
		model;
		systemPrompt;
		temperature;
		maxTokens;
		anthropicVersion;
		showThinking;
		thinkingAutoExpand;

		if (saveTimer) window.clearTimeout(saveTimer);
		saveTimer = window.setTimeout(() => {
			snapshotProviderToCache(provider);
			writeSettings({
				v: 1,
				provider,
				openai: providerCache.openai,
				anthropic: providerCache.anthropic,
				common: {
					systemPrompt,
					maxTokens: Math.max(1, Math.floor(Number.isFinite(maxTokens) ? maxTokens : 1024)),
					showThinking,
					thinkingAutoExpand
				}
			});
		}, 250);
	});

	function fmtTime(ts: number) {
		return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	function push(role: Role, content: string, thinking?: string) {
		const id = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
		messages.push({ id, role, content, thinking, at: Date.now() });
	}

	function stop() {
		abortController?.abort();
	}

	function clearChat() {
		stop();
		messages = [];
		assistantDraft = '';
		assistantThinkingDraft = '';
		thinkingVisibleById = {};
		thinkingOpenById = {};
		streamingThinkingVisible = false;
		streamingThinkingOpen = false;
		error = null;
		lastEvent = null;
		stickToBottom = true;
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
		const { done, contentDelta, thinkingDelta } = parseOpenAiSseData(event.data);
		if (done) return false;

		if (typeof thinkingDelta === 'string' && thinkingDelta) assistantThinkingDraft += thinkingDelta;

		if (typeof contentDelta === 'string' && contentDelta) {
			const out = thoughtSplitter.push(contentDelta);
			if (out.contentDelta) assistantDraft += out.contentDelta;
			if (out.thinkingDelta) assistantThinkingDraft += out.thinkingDelta;
		}

		return true;
	}

	function applyAnthropicDelta(event: SseEvent) {
		const { contentDelta, thinkingDelta } = parseAnthropicSseEvent(event, anthropicCtx);

		if (typeof thinkingDelta === 'string' && thinkingDelta) assistantThinkingDraft += thinkingDelta;

		if (typeof contentDelta === 'string' && contentDelta) {
			const out = thoughtSplitter.push(contentDelta);
			if (out.contentDelta) assistantDraft += out.contentDelta;
			if (out.thinkingDelta) assistantThinkingDraft += out.thinkingDelta;
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

		stickToBottom = true;
		push('user', prompt.trim());
		prompt = '';
		assistantDraft = '';
		assistantThinkingDraft = '';
		streamingThinkingVisible = false;
		streamingThinkingOpen = false;
		thoughtSplitter.reset();
		anthropicCtx = createAnthropicSseContext();

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

			const flushed = thoughtSplitter.flush();
			if (flushed.contentDelta) assistantDraft += flushed.contentDelta;
			if (flushed.thinkingDelta) assistantThinkingDraft += flushed.thinkingDelta;

			const finalText = assistantDraft.trim();
			const finalThinking = assistantThinkingDraft.trim();
			if (finalText || finalThinking) {
				push('assistant', finalText, finalThinking || undefined);
			}

			assistantDraft = '';
			assistantThinkingDraft = '';
			streamingThinkingVisible = false;
			streamingThinkingOpen = false;
		}
	}
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="container">
	<div class="grid">
		<section class="chat-area">
			<div class="chat-header">
				<div class="chat-title">
					<h1>EdgeAI Playground</h1>
					<p>
						同域 `/api/chat` 由 ESA Edge Function 代理转发并流式回传（SSE）。<span class="nowrap"
							>最后事件：{lastEvent ?? '—'}</span
						>
					</p>
				</div>
				<div class="chat-actions">
					<button class="btn btn-sm settings-toggle" type="button" onclick={() => (settingsOpen = true)}>
						设置
					</button>
				</div>
			</div>

			<div class="messages" bind:this={messagesEl} onscroll={syncStickToBottom} use:delegateCopy>
				{#if error}
					<div class="error">{error}</div>
				{/if}

				{#if messages.length === 0}
					<div class="msg system-intro">
						<div class="logo">EdgeAI</div>
						<p>
							1) 在右侧面板填写 Base URL / Key / Model（手机请点右上角“设置”）<br />
							2) 在下方输入问题，点击发送<br />
							3) 如出现 504，多数是上游首包太慢或被阻断；请检查网络、模型与 Base URL
						</p>
					</div>
				{/if}

				{#if messages.length > MAX_RENDER_MESSAGES}
					<div class="history-notice">
						<span>历史消息：</span>
						{#if renderAllMessages}
							<span class="muted">当前显示全部（可能影响性能）。</span>
							<button class="link" type="button" onclick={() => (renderAllMessages = false)}>仅显示最后 {MAX_RENDER_MESSAGES} 条</button>
						{:else}
							<span class="muted">已折叠前 {messages.length - MAX_RENDER_MESSAGES} 条（仍会发送给上游）。</span>
							<button class="link" type="button" onclick={() => (renderAllMessages = true)}>显示全部</button>
						{/if}
					</div>
				{/if}

				{#each (renderAllMessages ? messages : messages.slice(-MAX_RENDER_MESSAGES)) as m (m.id)}
					<div class="msg {m.role}">
						<div class="msg-content">
							<div class="meta">
								<strong>{m.role === 'user' ? '用户' : '助手'}</strong>
								<span>{fmtTime(m.at)}</span>
								{#if m.role === 'assistant' && m.thinking?.trim()}
									<button class="meta-pill" type="button" onclick={() => toggleMessageThinking(m.id)}>
										{showThinking
											? getMessageThinkingOpen(m.id)
												? '收起思维链'
												: '展开思维链'
											: thinkingVisibleById[m.id]
												? '隐藏思维链'
												: '思维链'}
									</button>
								{/if}
							</div>
							{#if m.content.trim()}
								<div class="md">{@html renderMarkdownToHtml(m.content)}</div>
							{:else}
								<div class="empty-content muted">（正文为空）</div>
							{/if}
							{#if m.role === 'assistant' && m.thinking?.trim() && (showThinking || thinkingVisibleById[m.id])}
								<details
									class="thinking"
									open={getMessageThinkingOpen(m.id)}
									ontoggle={(e) => handleMessageThinkingToggle(m.id, e)}
								>
									<summary>思维链</summary>
									<pre>{m.thinking}</pre>
								</details>
							{/if}
						</div>
					</div>
				{/each}

				{#if streaming}
					<div class="msg assistant">
						<div class="msg-content">
							<div class="meta">
								<strong>助手</strong>
								<span class="ok">生成中...</span>
								{#if assistantThinkingDraft.trim()}
									<button class="meta-pill" type="button" onclick={toggleStreamingThinking}>
										{showThinking
											? getStreamingThinkingOpen()
												? '收起思维链'
												: '展开思维链'
											: streamingThinkingVisible
												? '隐藏思维链'
												: '思维链'}
									</button>
								{/if}
							</div>
							<pre>{assistantDraft}</pre>
							{#if assistantThinkingDraft.trim() && (showThinking || streamingThinkingVisible)}
								<details class="thinking" open={getStreamingThinkingOpen()} ontoggle={handleStreamingThinkingToggle}>
									<summary>思维链</summary>
									<pre>{assistantThinkingDraft}</pre>
								</details>
							{/if}
						</div>
					</div>
				{/if}
			</div>

			{#if !stickToBottom && messages.length > 0}
				<button
					class="jump-to-latest"
					type="button"
					onclick={() => {
						stickToBottom = true;
						void scrollMessagesToBottom();
					}}
				>
					跳到最新
				</button>
			{/if}

			<div class="composer-wrapper">
				<div class="composer">
					<textarea
						id="prompt"
						bind:value={prompt}
						placeholder="输入提示词..."
						disabled={streaming}
						onkeydown={(e) => {
							if (e.key !== 'Enter' || e.shiftKey) return;
							e.preventDefault();
							void send();
						}}
					></textarea>
					<div class="composer-actions">
						<button class="btn-icon" type="button" onclick={send} disabled={streaming || !prompt.trim()} aria-label="发送">
							<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
						</button>
					</div>
				</div>
				<div class="composer-footer">
					<a href="https://www.alibabacloud.com/help/zh/esa" target="_blank" rel="noreferrer">ESA 文档</a>
				</div>
			</div>
		</section>

		{#if settingsOpen}
			<button
				class="settings-overlay"
				type="button"
				aria-label="关闭设置"
				onclick={() => (settingsOpen = false)}
			></button>
		{/if}

			<aside class="settings-panel" class:open={settingsOpen}>
				<div class="panel-header">
					<h2>运行设置</h2>
					<div class="panel-header-actions">
						<span class="pill">{streaming ? '生成中' : '空闲'}</span>
						<button class="btn btn-sm panel-close" type="button" onclick={() => (settingsOpen = false)}>
							关闭
						</button>
					</div>
				</div>
				<div class="panel-body">
					<div class="field-group">
						<div class="field">
							<label for="provider">提供方</label>
							<select
								id="provider"
								bind:value={provider}
								onchange={() => switchProvider(provider)}
								disabled={streaming}
							>
								<option value="openai">OpenAI Compatible（兼容）</option>
								<option value="anthropic">Anthropic</option>
							</select>
						</div>

						<div class="field">
							<label for="baseUrl">Base URL（上游地址）</label>
							<input
								id="baseUrl"
								bind:value={baseUrl}
								placeholder="https://api.openai.com"
							disabled={streaming}
							autocapitalize="off"
							autocomplete="off"
							spellcheck="false"
						/>
					</div>

						<div class="field">
							<label for="apiKey">API Key</label>
							<input
								id="apiKey"
								type="password"
								bind:value={apiKey}
							placeholder="sk-..."
							disabled={streaming}
							autocapitalize="off"
							autocomplete="off"
							spellcheck="false"
						/>
					</div>

						<div class="field">
							<label for="model">模型</label>
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
				</div>

					<div class="field-group">
						<div class="field">
							<label for="system">系统提示词</label>
							<textarea
								id="system"
								bind:value={systemPrompt}
								placeholder="可选：控制语气、格式、输出偏好等"
								disabled={streaming}
								rows="3"
							></textarea>
						</div>
					</div>

					<div class="field-group">
						<div class="field">
							<label for="showThinking">调试</label>
							<label class="checkbox">
								<input id="showThinking" type="checkbox" bind:checked={showThinking} />
								<span>默认显示思维链（也可在单条消息里点“思维链”查看）</span>
							</label>
							<label class="checkbox">
								<input
									id="thinkingAutoExpand"
									type="checkbox"
									bind:checked={thinkingAutoExpand}
									disabled={!showThinking}
								/>
								<span>默认展开</span>
							</label>
						</div>
					</div>

				<div class="field-group">
					<div class="field">
						<div class="label-row">
							<label for="temperature">Temperature（温度）</label>
							<span class="val">{temperature}</span>
						</div>
						<input
							id="temperature"
							type="range"
							min="0"
							max="2"
							step="0.1"
							bind:value={temperature}
							disabled={streaming || provider !== 'openai'}
						/>
					</div>

					<div class="field">
						<label for="maxTokens">最大输出 tokens</label>
						<input id="maxTokens" type="number" min="1" step="1" bind:value={maxTokens} disabled={streaming} />
					</div>

					{#if provider === 'anthropic'}
						<div class="field">
							<label for="anthropicVersion">版本</label>
							<input
								id="anthropicVersion"
								bind:value={anthropicVersion}
								placeholder="2023-06-01"
								disabled={streaming}
								autocapitalize="off"
								autocomplete="off"
								spellcheck="false"
							/>
						</div>
					{/if}
				</div>

				<div class="actions">
					<button class="btn danger full" type="button" onclick={stop} disabled={!streaming}>停止</button>
					<button class="btn full" type="button" onclick={clearChat} disabled={streaming || messages.length === 0}>
						清空对话
					</button>
				</div>
			</div>
		</aside>
	</div>
</div>
