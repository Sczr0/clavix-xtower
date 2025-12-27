<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { streamSse, type SseEvent } from '$lib/sse';
	import { renderMarkdownToHtml } from '$lib/markdown';
	import {
		DEFAULT_CONVERSATION_TITLE,
		ensureConversations,
		deleteConversationDetail,
		parseConversationImport,
		readConversationDetail,
		renderConversationMarkdown,
		serializeConversationExport,
		updateConversationMetaFromMessages,
		writeConversationDetail,
		writeConversationsIndex,
		normalizeConversationTitle,
		createId
	} from '$lib/conversations';
	import { buildProxyCurl, buildUpstreamCurl, buildUpstreamUrl, maskApiKey, prettyJson, truncateText } from '$lib/debug';
	import {
		createAnthropicSseContext,
		createThoughtChainSplitter,
		parseAnthropicSseEvent,
		parseOpenAiSseData
	} from '$lib/thought-chain';

	type Provider = 'openai' | 'anthropic';
	type Role = 'user' | 'assistant';

	type TokenUsage = {
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
	};

	type ChatMessage = {
		id: string;
		role: Role;
		content: string;
		thinking?: string;
		usage?: TokenUsage;
		at: number;
	};

	type ConversationRunSnapshot = {
		provider: Provider;
		baseUrl: string;
		model: string;
		systemPrompt: string;
		temperature: number;
		topP: number;
		presencePenalty: number;
		frequencyPenalty: number;
		maxTokens: number;
		anthropicVersion: string;
	};

	type ConversationListItem = {
		id: string;
		title: string;
		createdAt: number;
		updatedAt: number;
		lastSnippet: string;
		pinned: boolean;
	};

	type DebugTab = 'settings' | 'debug';

	type DebugEvent = {
		n: number;
		at: number;
		event: string | null;
		id: string | null;
		dataLen: number;
		dataSnippet: string;
	};

	type DebugSession = {
		startedAt: number;
		endedAt: number | null;
		aborted: boolean;
		provider: Provider;
		baseUrl: string;
		model: string;
		anthropicVersion?: string;
		upstreamUrl: string;
		proxyStatus: number | null;
		proxyOk: boolean | null;
		proxyErrorText: string | null;
		firstEventAt: number | null;
		eventCount: number;
		bytesApprox: number;
		events: DebugEvent[];
		origin: string;
		proxyPayloadBase: { provider: Provider; baseUrl: string; anthropicVersion?: string; request: any };
		proxyPayloadMaskedJson: string;
		upstreamRequestJson: string;
		proxyCurl: string;
		upstreamCurl: string;
	};

	const DEBUG_MAX_EVENTS = 300;
	const DEBUG_EVENT_SNIPPET_MAX = 900;
	const DEBUG_ERROR_SNIPPET_MAX = 12_000;

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
		openai: {
			baseUrl: string;
			model: string;
			temperature: number;
			topP: number;
			presencePenalty: number;
			frequencyPenalty: number;
		};
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
			includeUsage: boolean;
		};
	};

	const SETTINGS_STORAGE_KEY = 'edgeai-playground:settings:v1';
	const LAYOUT_STORAGE_KEY = 'edgeai-playground:layout:v1';

	type StoredLayoutV1 = {
		v: 1;
		leftSidebarWidth: number;
		rightSidebarWidth: number;
	};

	const DESKTOP_BREAKPOINT_PX = 980;

	const LEFT_SIDEBAR_MIN_PX = 240;
	const LEFT_SIDEBAR_MAX_PX = 520;
	const RIGHT_SIDEBAR_MIN_PX = 280;
	const RIGHT_SIDEBAR_MAX_PX = 520;
	const CENTER_MIN_PX = 360;

	const DEFAULT_LEFT_SIDEBAR_WIDTH_PX = 320;
	const DEFAULT_RIGHT_SIDEBAR_WIDTH_PX = 320;

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
					temperature: clamp(safeNumber(openai.temperature, 0.7), 0, 2),
					topP: clamp(safeNumber(openai.topP ?? openai.top_p, 1), 0, 1),
					presencePenalty: clamp(safeNumber(openai.presencePenalty ?? openai.presence_penalty, 0), -2, 2),
					frequencyPenalty: clamp(safeNumber(openai.frequencyPenalty ?? openai.frequency_penalty, 0), -2, 2)
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
					thinkingAutoExpand: safeBoolean(common.thinkingAutoExpand, false),
					includeUsage: safeBoolean(common.includeUsage, true)
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

	function readLayout(): StoredLayoutV1 | null {
		try {
			const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
			if (!raw) return null;
			const parsed = JSON.parse(raw) as any;
			if (!parsed || parsed.v !== 1) return null;

			return {
				v: 1,
				leftSidebarWidth: safeNumber(parsed.leftSidebarWidth, DEFAULT_LEFT_SIDEBAR_WIDTH_PX),
				rightSidebarWidth: safeNumber(parsed.rightSidebarWidth, DEFAULT_RIGHT_SIDEBAR_WIDTH_PX)
			};
		} catch {
			return null;
		}
	}

	function writeLayout(layout: StoredLayoutV1) {
		try {
			localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
		} catch {
			// localStorage 可能被禁用（隐私模式/策略）
		}
	}

	function getViewportWidth() {
		if (typeof document !== 'undefined') {
			const w = document.documentElement?.clientWidth;
			if (typeof w === 'number' && Number.isFinite(w) && w > 0) return w;
		}
		return typeof window !== 'undefined' ? window.innerWidth : 0;
	}

	function clampLayoutToViewport(left: number, right: number) {
		let l = Math.round(clamp(safeNumber(left, DEFAULT_LEFT_SIDEBAR_WIDTH_PX), LEFT_SIDEBAR_MIN_PX, LEFT_SIDEBAR_MAX_PX));
		let r = Math.round(clamp(safeNumber(right, DEFAULT_RIGHT_SIDEBAR_WIDTH_PX), RIGHT_SIDEBAR_MIN_PX, RIGHT_SIDEBAR_MAX_PX));

		const vw = getViewportWidth();
		if (vw <= 0) return { left: l, right: r };

		const center = vw - l - r;
		if (center >= CENTER_MIN_PX) return { left: l, right: r };

		// 空间不够时：优先压缩右侧栏，再压缩左侧栏
		let need = CENTER_MIN_PX - center;

		const shrinkRight = Math.min(Math.max(0, r - RIGHT_SIDEBAR_MIN_PX), need);
		r -= shrinkRight;
		need -= shrinkRight;

		const shrinkLeft = Math.min(Math.max(0, l - LEFT_SIDEBAR_MIN_PX), need);
		l -= shrinkLeft;

		return { left: l, right: r };
	}

	function isDesktopViewport() {
		return typeof window !== 'undefined' && window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT_PX + 1}px)`).matches;
	}

	let provider = $state<Provider>('openai');
	let baseUrl = $state(DEFAULTS.openai.baseUrl);
	let apiKey = $state('');
	let model = $state('');
	let systemPrompt = $state('');
	let temperature = $state(0.7);
	let topP = $state(1);
	let presencePenalty = $state(0);
	let frequencyPenalty = $state(0);
	let maxTokens = $state(1024);
	let anthropicVersion = $state(DEFAULTS.anthropic.version ?? '2023-06-01');

	let prompt = $state('');
	let messages = $state<ChatMessage[]>([]);
	let assistantDraft = $state('');
	let assistantThinkingDraft = $state('');
	let streamingUsage = $state<TokenUsage | null>(null);
	let streaming = $state(false);
	let lastEvent = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let error = $state<string | null>(null);

	let settingsHydrated = $state(false);

	let providerCache: ProviderCache = {
		openai: {
			baseUrl: DEFAULTS.openai.baseUrl,
			model: '',
			temperature: 0.7,
			topP: 1,
			presencePenalty: 0,
			frequencyPenalty: 0
		},
		anthropic: {
			baseUrl: DEFAULTS.anthropic.baseUrl,
			model: '',
			anthropicVersion: DEFAULTS.anthropic.version ?? '2023-06-01'
		}
	};
	let lastProvider: Provider = 'openai';
	let saveTimer: number | null = null;
	let noticeTimer: number | null = null;

	let settingsOpen = $state(false);
	let conversationsOpen = $state(false);
	let rightPanelTab = $state<DebugTab>('settings');
	let debugSession = $state<DebugSession | null>(null);
	let leftSidebarWidth = $state(DEFAULT_LEFT_SIDEBAR_WIDTH_PX);
	let rightSidebarWidth = $state(DEFAULT_RIGHT_SIDEBAR_WIDTH_PX);
	let resizingSidebar = $state<null | 'left' | 'right'>(null);

	let showThinking = $state(false);
	let thinkingAutoExpand = $state(false);
	let includeUsage = $state(true);
	let thinkingVisibleById = $state<Record<string, boolean>>({});
	let thinkingOpenById = $state<Record<string, boolean>>({});
	let streamingThinkingVisible = $state(false);
	let streamingThinkingOpen = $state(false);

	let messagesEl: HTMLDivElement | null = null;
	let chatAreaEl: HTMLElement | null = null;
	let composerWrapperEl: HTMLDivElement | null = null;
	let stickToBottom = $state(true);
	const MAX_RENDER_MESSAGES = 200;
	let renderAllMessages = $state(false);

	let abortController: AbortController | null = null;

	let thoughtSplitter = createThoughtChainSplitter();
	let anthropicCtx = createAnthropicSseContext();

	// 会话资产化（当前仅使用 localStorage，不保存 API Key）
	let conversationsHydrated = $state(false);
	let conversations = $state<ConversationListItem[]>([]);
	let currentConversationId = $state('');
	let currentConversationRun = $state<ConversationRunSnapshot | undefined>(undefined);
	let conversationQuery = $state('');
	let editingConversationId = $state<string | null>(null);
	let editingConversationTitle = $state('');
	let conversationSaveTimer: number | null = null;
	let importInputEl: HTMLInputElement | null = null;
	const conversationSearchCache = new Map<string, string>();
	const CONVERSATION_SAVE_DEBOUNCE_MS = 250;

	function handleGlobalKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		settingsOpen = false;
		conversationsOpen = false;
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

	function sortConversationList(items: ConversationListItem[]) {
		return [...items].sort((a, b) => {
			if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
			return b.updatedAt - a.updatedAt;
		});
	}

	function getConversationMeta(id: string): ConversationListItem | null {
		return conversations.find((c) => c.id === id) ?? null;
	}

	function safeReadConversationDetail(id: string) {
		try {
			return readConversationDetail(localStorage, id);
		} catch {
			return null;
		}
	}

	function getCurrentConversationMeta(): ConversationListItem | null {
		return currentConversationId ? getConversationMeta(currentConversationId) : null;
	}

	function downloadText(filename: string, text: string, mime: string) {
		const blob = new Blob([text], { type: mime });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1_000);
	}

	function safeFilenamePart(raw: string) {
		const base = normalizeConversationTitle(raw);
		return base.replace(/[\\\\/:*?\"<>|]/g, '_');
	}

	function persistConversationsIndex() {
		if (!conversationsHydrated) return;
		try {
			writeConversationsIndex(localStorage, {
				v: 1,
				currentId: currentConversationId || null,
				items: conversations.map((c) => ({ ...c }))
			});
		} catch {
			// localStorage 可能被禁用（隐私模式/策略）
		}
	}

	function persistCurrentConversationDetail() {
		if (!conversationsHydrated) return;
		if (!currentConversationId) return;
		try {
			writeConversationDetail(localStorage, {
				v: 1,
				id: currentConversationId,
				messages: messages.map((m) => ({ ...m })),
				run: currentConversationRun
			});
		} catch {
			// localStorage 可能被禁用（隐私模式/策略）
		}
	}

	function schedulePersistCurrentConversation() {
		if (!conversationsHydrated) return;
		if (conversationSaveTimer) window.clearTimeout(conversationSaveTimer);
		conversationSaveTimer = window.setTimeout(() => {
			persistConversationsIndex();
			persistCurrentConversationDetail();
		}, CONVERSATION_SAVE_DEBOUNCE_MS);
	}

	function resetTransientUiAfterConversationChange() {
		assistantDraft = '';
		assistantThinkingDraft = '';
		streamingThinkingVisible = false;
		streamingThinkingOpen = false;
		thinkingVisibleById = {};
		thinkingOpenById = {};
		error = null;
		lastEvent = null;
		stickToBottom = true;
		renderAllMessages = false;
		thoughtSplitter.reset();
		anthropicCtx = createAnthropicSseContext();
	}

	function touchCurrentConversation(now = Date.now()) {
		if (!currentConversationId) return;
		const idx = conversations.findIndex((c) => c.id === currentConversationId);
		if (idx === -1) return;

		conversations[idx] = updateConversationMetaFromMessages(conversations[idx], messages, now);
		conversations = sortConversationList(conversations);
		conversationSearchCache.delete(currentConversationId);
		schedulePersistCurrentConversation();
	}

	function openSettingsPanel() {
		settingsOpen = true;
		conversationsOpen = false;
		rightPanelTab = 'settings';
	}

	function openDebugPanel() {
		settingsOpen = true;
		conversationsOpen = false;
		rightPanelTab = 'debug';
	}

	function openConversationsPanel() {
		conversationsOpen = true;
		settingsOpen = false;
	}

	function startSidebarResize(side: 'left' | 'right', e: PointerEvent) {
		// 仅电脑端启用拖拽（移动端为抽屉式面板）
		if (!isDesktopViewport()) return;
		if (e.button !== 0) return;

		const startX = e.clientX;
		const startLeft = leftSidebarWidth;
		const startRight = rightSidebarWidth;

		resizingSidebar = side;

		const target = e.currentTarget as HTMLElement | null;
		target?.setPointerCapture?.(e.pointerId);

		// 避免拖拽时选中文本
		const body = document.body;
		const prevCursor = body.style.cursor;
		const prevUserSelect = body.style.userSelect;
		body.style.cursor = 'col-resize';
		body.style.userSelect = 'none';

		const onMove = (ev: PointerEvent) => {
			const vw = getViewportWidth();
			if (vw <= 0) return;

			const dx = ev.clientX - startX;
			if (side === 'left') {
				const max = Math.max(LEFT_SIDEBAR_MIN_PX, Math.min(LEFT_SIDEBAR_MAX_PX, vw - startRight - CENTER_MIN_PX));
				leftSidebarWidth = Math.round(clamp(startLeft + dx, LEFT_SIDEBAR_MIN_PX, max));
			} else {
				const max = Math.max(RIGHT_SIDEBAR_MIN_PX, Math.min(RIGHT_SIDEBAR_MAX_PX, vw - startLeft - CENTER_MIN_PX));
				rightSidebarWidth = Math.round(clamp(startRight - dx, RIGHT_SIDEBAR_MIN_PX, max));
			}
		};

		const end = () => {
			document.removeEventListener('pointermove', onMove);
			document.removeEventListener('pointerup', end);
			document.removeEventListener('pointercancel', end);

			body.style.cursor = prevCursor;
			body.style.userSelect = prevUserSelect;

			resizingSidebar = null;

			writeLayout({ v: 1, leftSidebarWidth, rightSidebarWidth });
		};

		document.addEventListener('pointermove', onMove);
		document.addEventListener('pointerup', end);
		document.addEventListener('pointercancel', end);

		e.preventDefault();
		e.stopPropagation();
	}

	function closePanels() {
		settingsOpen = false;
		conversationsOpen = false;
	}

	function createConversation() {
		if (streaming) return;

		const now = Date.now();
		const id = createId();
		const meta: ConversationListItem = {
			id,
			title: DEFAULT_CONVERSATION_TITLE,
			createdAt: now,
			updatedAt: now,
			lastSnippet: '',
			pinned: false
		};

		conversations = sortConversationList([meta, ...conversations]);
		currentConversationId = id;
		currentConversationRun = undefined;
		messages = [];

		try {
			writeConversationDetail(localStorage, { v: 1, id, messages: [] });
			persistConversationsIndex();
		} catch {
			// localStorage 可能被禁用（隐私模式/策略）
		}

		resetTransientUiAfterConversationChange();
		conversationsOpen = false;
	}

	function selectConversation(id: string) {
		if (streaming) return;
		if (!id || id === currentConversationId) {
			conversationsOpen = false;
			return;
		}

		const meta = getConversationMeta(id);
		if (!meta) return;

		let detail = safeReadConversationDetail(id);
		if (!detail) {
			detail = { v: 1, id, messages: [] };
			try {
				writeConversationDetail(localStorage, detail);
			} catch {
				// localStorage 可能被禁用（隐私模式/策略）
			}
		}

		currentConversationId = id;
		currentConversationRun = detail.run;
		messages = detail.messages;
		editingConversationId = null;
		editingConversationTitle = '';
		persistConversationsIndex();

		resetTransientUiAfterConversationChange();
		conversationsOpen = false;
	}

	function startRenameConversation(id: string) {
		if (streaming) return;
		const meta = getConversationMeta(id);
		if (!meta) return;
		editingConversationId = id;
		editingConversationTitle = meta.title;
	}

	function cancelRenameConversation() {
		editingConversationId = null;
		editingConversationTitle = '';
	}

	function commitRenameConversation(id: string) {
		const nextTitle = normalizeConversationTitle(editingConversationTitle);
		const now = Date.now();

		const idx = conversations.findIndex((c) => c.id === id);
		if (idx !== -1) {
			conversations[idx] = { ...conversations[idx], title: nextTitle, updatedAt: now };
			conversations = sortConversationList(conversations);
			conversationSearchCache.delete(id);
			persistConversationsIndex();
		}

		cancelRenameConversation();
	}

	function duplicateConversation(id: string) {
		if (streaming) return;
		const meta = getConversationMeta(id);
		if (!meta) return;

		const srcDetail =
			safeReadConversationDetail(id) ??
			(id === currentConversationId
				? { v: 1, id, messages: messages.map((m) => ({ ...m })), run: currentConversationRun }
				: { v: 1, id, messages: [] });
		const now = Date.now();
		const newId = createId();

		const nextMeta: ConversationListItem = {
			id: newId,
			title: normalizeConversationTitle(`${meta.title} 副本`),
			createdAt: now,
			updatedAt: now,
			lastSnippet: meta.lastSnippet,
			pinned: false
		};

		try {
			writeConversationDetail(localStorage, {
				v: 1,
				id: newId,
				messages: srcDetail.messages.map((m) => ({ ...m })),
				run: srcDetail.run
			});
		} catch {
			// localStorage 可能被禁用（隐私模式/策略）
		}

		conversations = sortConversationList([nextMeta, ...conversations]);
		persistConversationsIndex();
		selectConversation(newId);
	}

	function deleteConversation(id: string) {
		if (streaming) return;
		const meta = getConversationMeta(id);
		if (!meta) return;

		const ok = window.confirm(`确定删除会话「${meta.title}」吗？此操作不可恢复。`);
		if (!ok) return;

		try {
			deleteConversationDetail(localStorage, id);
		} catch {
			// localStorage 可能被禁用（隐私模式/策略）
		}

		conversationSearchCache.delete(id);
		conversations = conversations.filter((c) => c.id !== id);

		if (currentConversationId === id) {
			if (conversations.length === 0) createConversation();
			else selectConversation(sortConversationList(conversations)[0].id);
			return;
		}

		persistConversationsIndex();
	}

	function exportConversationJson(id: string) {
		const meta = getConversationMeta(id);
		if (!meta) return;
		const detail =
			safeReadConversationDetail(id) ??
			(id === currentConversationId
				? { v: 1, id, messages: messages.map((m) => ({ ...m })), run: currentConversationRun }
				: { v: 1, id, messages: [] });

		const date = new Date().toISOString().slice(0, 10);
		const filename = `${safeFilenamePart(meta.title)}-${date}.json`;
		downloadText(filename, serializeConversationExport(meta, detail), 'application/json; charset=utf-8');
	}

	function exportConversationMarkdown(id: string) {
		const meta = getConversationMeta(id);
		if (!meta) return;
		const detail =
			safeReadConversationDetail(id) ??
			(id === currentConversationId
				? { v: 1, id, messages: messages.map((m) => ({ ...m })), run: currentConversationRun }
				: { v: 1, id, messages: [] });

		const date = new Date().toISOString().slice(0, 10);
		const filename = `${safeFilenamePart(meta.title)}-${date}.md`;
		downloadText(filename, renderConversationMarkdown(meta, detail), 'text/markdown; charset=utf-8');
	}

	async function handleImportFileChange() {
		if (streaming) return;
		const file = importInputEl?.files?.[0];
		if (!file) return;

		try {
			const text = await file.text();
			const res = parseConversationImport(text);
			if (!res.ok) {
				error = `导入失败：${res.error}`;
				return;
			}

			try {
				writeConversationDetail(localStorage, res.detail);
			} catch {
				// localStorage 可能被禁用（隐私模式/策略）
			}

			conversations = sortConversationList([res.meta, ...conversations]);
			persistConversationsIndex();
			selectConversation(res.meta.id);
		} finally {
			if (importInputEl) importInputEl.value = '';
		}
	}

	function getConversationSearchText(id: string): string {
		const cached = conversationSearchCache.get(id);
		if (typeof cached === 'string') return cached;

		const detail = safeReadConversationDetail(id) ?? (id === currentConversationId ? { v: 1, id, messages } : null);
		if (!detail) {
			conversationSearchCache.set(id, '');
			return '';
		}

		let text = '';
		for (const m of detail.messages) {
			if (m.content) text += `\n${m.content}`;
			if (m.thinking) text += `\n${m.thinking}`;
		}

		const normalized = text.toLowerCase();
		const trimmed = normalized.length > 200_000 ? normalized.slice(0, 200_000) : normalized;
		conversationSearchCache.set(id, trimmed);
		return trimmed;
	}

	function getVisibleConversations() {
		const q = conversationQuery.trim().toLowerCase();
		const sorted = sortConversationList(conversations);
		if (!q) return sorted;

		return sorted.filter((c) => {
			if (c.title.toLowerCase().includes(q)) return true;
			if (c.lastSnippet.toLowerCase().includes(q)) return true;
			return getConversationSearchText(c.id).includes(q);
		});
	}

	function clearDebugSession() {
		debugSession = null;
	}

	function confirmCopyIncludesApiKey(label: string) {
		if (!apiKey.trim()) {
			window.alert(`${label} 需要 API Key，但当前输入为空。`);
			return false;
		}

		return window.confirm(
			`${label} 将包含 API Key（明文）。\n\n请确认：\n- 只粘贴到可信环境\n- 不要截图/录屏/提交到仓库\n- 不要发到群聊或工单\n\n继续吗？`
		);
	}

	async function copyDebugProxyJson(includeKey: boolean) {
		if (!debugSession) return;
		if (includeKey && !confirmCopyIncludesApiKey('复制 /api/chat 请求 JSON')) return;

		const text = includeKey
			? prettyJson({ ...debugSession.proxyPayloadBase, apiKey: apiKey.trim() })
			: debugSession.proxyPayloadMaskedJson;

		await copyToClipboard(text || '');
	}

	async function copyDebugProxyCurl(includeKey: boolean) {
		if (!debugSession) return;
		if (includeKey && !confirmCopyIncludesApiKey('复制 Proxy curl')) return;

		const payload = { ...debugSession.proxyPayloadBase, apiKey: apiKey.trim() };
		const text = includeKey
			? buildProxyCurl({ origin: debugSession.origin, payload, includeKey: true })
			: debugSession.proxyCurl;

		await copyToClipboard(text || '');
	}

	async function copyDebugUpstreamCurl(includeKey: boolean) {
		if (!debugSession) return;
		if (includeKey && !confirmCopyIncludesApiKey('复制 Upstream curl')) return;

		const text = buildUpstreamCurl({
			provider: debugSession.provider,
			baseUrl: debugSession.baseUrl,
			apiKey: apiKey.trim(),
			anthropicVersion: debugSession.anthropicVersion,
			request: debugSession.proxyPayloadBase.request,
			includeKey
		});

		await copyToClipboard(text || '');
	}

	function recordDebugEvent(e: SseEvent) {
		if (!debugSession) return;

		const at = Date.now();
		if (!debugSession.firstEventAt) debugSession.firstEventAt = at;

		debugSession.eventCount += 1;
		debugSession.bytesApprox += typeof e.data === 'string' ? e.data.length : 0;
		debugSession.events.push({
			n: debugSession.eventCount,
			at,
			event: e.event,
			id: e.id,
			dataLen: typeof e.data === 'string' ? e.data.length : 0,
			dataSnippet: truncateText(typeof e.data === 'string' ? e.data : String(e.data ?? ''), DEBUG_EVENT_SNIPPET_MAX)
		});

		if (debugSession.events.length > DEBUG_MAX_EVENTS) debugSession.events.shift();
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

	let composerOverlapRaf: number | null = null;

	function parsePx(value: string) {
		const n = Number.parseFloat(value);
		return Number.isFinite(n) ? n : 0;
	}

	function updateComposerOverlap() {
		if (!chatAreaEl || !composerWrapperEl) return;

		const chatRect = chatAreaEl.getBoundingClientRect();
		if (!Number.isFinite(chatRect.height) || chatRect.height <= 0) return;

		const composerRect = composerWrapperEl.getBoundingClientRect();
		const overlay = Math.max(0, Math.ceil(chatRect.bottom - composerRect.top));
		const base = parsePx(getComputedStyle(chatAreaEl).getPropertyValue('--composer-overlap-base'));

		// 仅当实际遮挡高度超过 CSS 默认值时才抬高，避免在“正常高度”下产生额外空白
		const next = overlay > base ? overlay + 12 : base;
		chatAreaEl.style.setProperty('--composer-overlap', `${Math.min(next, Math.ceil(chatRect.height))}px`);

		if (stickToBottom) void scrollMessagesToBottom();
	}

	function scheduleComposerOverlapUpdate() {
		if (composerOverlapRaf != null) return;
		composerOverlapRaf = window.requestAnimationFrame(() => {
			composerOverlapRaf = null;
			updateComposerOverlap();
		});
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
			providerCache.openai.topP = clamp(Number.isFinite(topP) ? topP : 1, 0, 1);
			providerCache.openai.presencePenalty = clamp(Number.isFinite(presencePenalty) ? presencePenalty : 0, -2, 2);
			providerCache.openai.frequencyPenalty = clamp(Number.isFinite(frequencyPenalty) ? frequencyPenalty : 0, -2, 2);
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
			topP = clamp(Number.isFinite(providerCache.openai.topP) ? providerCache.openai.topP : 1, 0, 1);
			presencePenalty = clamp(
				Number.isFinite(providerCache.openai.presencePenalty) ? providerCache.openai.presencePenalty : 0,
				-2,
				2
			);
			frequencyPenalty = clamp(
				Number.isFinite(providerCache.openai.frequencyPenalty) ? providerCache.openai.frequencyPenalty : 0,
				-2,
				2
			);
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
				providerCache.openai.topP = saved.openai.topP;
				providerCache.openai.presencePenalty = saved.openai.presencePenalty;
				providerCache.openai.frequencyPenalty = saved.openai.frequencyPenalty;

				providerCache.anthropic.baseUrl = saved.anthropic.baseUrl;
				providerCache.anthropic.model = saved.anthropic.model;
				providerCache.anthropic.anthropicVersion = saved.anthropic.anthropicVersion;

			systemPrompt = saved.common.systemPrompt;
			maxTokens = saved.common.maxTokens;
			showThinking = saved.common.showThinking;
			thinkingAutoExpand = saved.common.thinkingAutoExpand;
			includeUsage = saved.common.includeUsage;

			provider = saved.provider;
			lastProvider = provider;
			applyCacheToFields(provider);
		} else {
			lastProvider = provider;
			snapshotProviderToCache(provider);
		}

		// 初始化会话（localStorage v1）；若 localStorage 不可用则退化为仅内存
		try {
			const { index, currentId } = ensureConversations(localStorage);
			conversations = index.items;
			currentConversationId = currentId;

			const detail = safeReadConversationDetail(currentId);
			if (detail) {
				messages = detail.messages;
				currentConversationRun = detail.run;
			} else {
				messages = [];
				currentConversationRun = undefined;
				try {
					writeConversationDetail(localStorage, { v: 1, id: currentId, messages: [] });
				} catch {
					// localStorage 可能被禁用（隐私模式/策略）
				}
			}
		} catch {
			const now = Date.now();
			const id = createId();
			conversations = [
				{
					id,
					title: DEFAULT_CONVERSATION_TITLE,
					createdAt: now,
					updatedAt: now,
					lastSnippet: '',
					pinned: false
				}
			];
			currentConversationId = id;
			currentConversationRun = undefined;
			messages = [];
		}

		// 桌面端布局：左右侧栏宽度（可拖拽）
		const savedLayout = readLayout();
		const layout = clampLayoutToViewport(
			savedLayout?.leftSidebarWidth ?? leftSidebarWidth,
			savedLayout?.rightSidebarWidth ?? rightSidebarWidth
		);
		leftSidebarWidth = layout.left;
		rightSidebarWidth = layout.right;

		const handleResize = () => {
			if (resizingSidebar) return;
			const next = clampLayoutToViewport(leftSidebarWidth, rightSidebarWidth);
			leftSidebarWidth = next.left;
			rightSidebarWidth = next.right;
		};

		window.addEventListener('resize', handleResize);

		conversationSearchCache.clear();
		conversationsHydrated = true;
		settingsHydrated = true;

		return () => window.removeEventListener('resize', handleResize);
	});

	onMount(() => {
		// 解决“长回答被输入框遮挡”：按实际 composer 位置动态调整 messages 的 bottom padding
		scheduleComposerOverlapUpdate();

		let ro: ResizeObserver | null = null;
		if (typeof ResizeObserver !== 'undefined' && chatAreaEl && composerWrapperEl) {
			ro = new ResizeObserver(() => scheduleComposerOverlapUpdate());
			ro.observe(chatAreaEl);
			ro.observe(composerWrapperEl);
		}

		window.addEventListener('resize', scheduleComposerOverlapUpdate);

		return () => {
			window.removeEventListener('resize', scheduleComposerOverlapUpdate);
			ro?.disconnect();
			if (composerOverlapRaf != null) window.cancelAnimationFrame(composerOverlapRaf);
			composerOverlapRaf = null;
		};
	});

	$effect(() => {
		if (!settingsHydrated) return;

		// 依赖：仅保存“非敏感设置”，API Key 明确不落盘
		provider;
		baseUrl;
		model;
		systemPrompt;
		temperature;
		topP;
		presencePenalty;
		frequencyPenalty;
		maxTokens;
		anthropicVersion;
		showThinking;
		thinkingAutoExpand;
		includeUsage;

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
					thinkingAutoExpand,
					includeUsage
				}
			});
		}, 250);
	});

	function fmtTime(ts: number) {
		return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	function fmtMs(ms: number) {
		if (!Number.isFinite(ms)) return '—';
		if (ms < 1_000) return `${Math.round(ms)} ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
		return `${Math.round(ms / 1000)} s`;
	}

	function fmtBytes(n: number) {
		if (!Number.isFinite(n) || n < 0) return '—';
		if (n < 1024) return `${Math.round(n)} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(2)} MB`;
	}

	function showNotice(message: string) {
		notice = message;
		if (noticeTimer) window.clearTimeout(noticeTimer);
		noticeTimer = window.setTimeout(() => {
			notice = null;
			noticeTimer = null;
		}, 6_000);
	}

	function looksLikeUsageUnsupportedError(err: UpstreamError) {
		const raw = typeof err?.message === 'string' ? err.message : '';
		const msg = raw.toLowerCase();
		return msg.includes('stream_options') || msg.includes('include_usage');
	}

	function mergeTokenUsage(current: TokenUsage | null, patch: TokenUsage | undefined): TokenUsage | null {
		if (!patch) return current;
		const next: TokenUsage = current ? { ...current } : {};

		if (typeof patch.inputTokens === 'number') {
			next.inputTokens = typeof next.inputTokens === 'number' ? Math.max(next.inputTokens, patch.inputTokens) : patch.inputTokens;
		}
		if (typeof patch.outputTokens === 'number') {
			next.outputTokens =
				typeof next.outputTokens === 'number' ? Math.max(next.outputTokens, patch.outputTokens) : patch.outputTokens;
		}
		if (typeof patch.totalTokens === 'number') {
			next.totalTokens = typeof next.totalTokens === 'number' ? Math.max(next.totalTokens, patch.totalTokens) : patch.totalTokens;
		}

		if (typeof next.totalTokens !== 'number' && typeof next.inputTokens === 'number' && typeof next.outputTokens === 'number') {
			next.totalTokens = next.inputTokens + next.outputTokens;
		}

		return Object.keys(next).length ? next : null;
	}

	function formatTokenUsage(usage: TokenUsage | null | undefined): string | null {
		if (!usage) return null;
		const parts: string[] = [];
		if (typeof usage.inputTokens === 'number') parts.push(`输入 ${usage.inputTokens}`);
		if (typeof usage.outputTokens === 'number') parts.push(`输出 ${usage.outputTokens}`);

		const total =
			typeof usage.totalTokens === 'number'
				? usage.totalTokens
				: typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number'
					? usage.inputTokens + usage.outputTokens
					: null;
		if (typeof total === 'number') parts.push(`总计 ${total}`);

		return parts.length ? `Tokens：${parts.join(' · ')}` : null;
	}

	function push(role: Role, content: string, thinking?: string, usage?: TokenUsage) {
		const id = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
		messages.push({ id, role, content, thinking, usage, at: Date.now() });
		touchCurrentConversation();
	}

	function stop() {
		abortController?.abort();
	}

	function clearChat() {
		stop();
		messages = [];
		assistantDraft = '';
		assistantThinkingDraft = '';
		streamingUsage = null;
		thinkingVisibleById = {};
		thinkingOpenById = {};
		streamingThinkingVisible = false;
		streamingThinkingOpen = false;
		notice = null;
		if (noticeTimer) window.clearTimeout(noticeTimer);
		noticeTimer = null;
		error = null;
		lastEvent = null;
		stickToBottom = true;
		renderAllMessages = false;
		touchCurrentConversation();
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
		const { done, contentDelta, thinkingDelta, usage } = parseOpenAiSseData(event.data);
		if (usage) streamingUsage = mergeTokenUsage(streamingUsage, usage);
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
		const { contentDelta, thinkingDelta, usage } = parseAnthropicSseEvent(event, anthropicCtx);
		if (usage) streamingUsage = mergeTokenUsage(streamingUsage, usage);

		if (typeof thinkingDelta === 'string' && thinkingDelta) assistantThinkingDraft += thinkingDelta;

		if (typeof contentDelta === 'string' && contentDelta) {
			const out = thoughtSplitter.push(contentDelta);
			if (out.contentDelta) assistantDraft += out.contentDelta;
			if (out.thinkingDelta) assistantThinkingDraft += out.thinkingDelta;
		}

		return true;
	}

	async function send() {
		notice = null;
		error = null;
		lastEvent = null;

		if (streaming) return;
		if (!prompt.trim()) return;
		if (!baseUrl.trim()) {
			error = '请填写上游 Base URL（必须是 https 域名，可选以 /v1 结尾；不允许 IP/端口/query）。';
			openSettingsPanel();
			return;
		}
		if (!apiKey.trim()) {
			error = '请填写 API Key（仅保存在浏览器内存，不会写入服务端存储）。';
			openSettingsPanel();
			return;
		}
		if (!model.trim()) {
			error = '请填写模型名。';
			openSettingsPanel();
			return;
		}

		// 保存本次“运行快照”（不保存 API Key），用于导出/复现
		currentConversationRun = {
			provider,
			baseUrl: baseUrl.trim(),
			model: model.trim(),
			systemPrompt,
			temperature: clamp(Number.isFinite(temperature) ? temperature : 0.7, 0, 2),
			topP: clamp(Number.isFinite(topP) ? topP : 1, 0, 1),
			presencePenalty: clamp(Number.isFinite(presencePenalty) ? presencePenalty : 0, -2, 2),
			frequencyPenalty: clamp(Number.isFinite(frequencyPenalty) ? frequencyPenalty : 0, -2, 2),
			maxTokens: Math.max(1, Math.floor(Number.isFinite(maxTokens) ? maxTokens : 1024)),
			anthropicVersion: anthropicVersion.trim() || (DEFAULTS.anthropic.version ?? '2023-06-01')
		};

		stickToBottom = true;
		push('user', prompt.trim());
		prompt = '';
		assistantDraft = '';
		assistantThinkingDraft = '';
		streamingUsage = null;
		streamingThinkingVisible = false;
		streamingThinkingOpen = false;
		thoughtSplitter.reset();
		anthropicCtx = createAnthropicSseContext();

		streaming = true;
		abortController = new AbortController();

		try {
			const trimmedBaseUrl = baseUrl.trim();
			const trimmedApiKey = apiKey.trim();
			const trimmedModel = model.trim();
			const trimmedAnthropicVersion = provider === 'anthropic' ? anthropicVersion.trim() : undefined;

			const origin = typeof location !== 'undefined' ? location.origin : '';

			// 若上游不支持 OpenAI 的 stream_options.include_usage，本次会自动降级重试一次
			let didRetryWithoutUsage = false;
			debugSession = null;

			while (true) {
				const normalizedOpenAiTemperature = clamp(Number.isFinite(temperature) ? temperature : 0.7, 0, 2);
				const normalizedOpenAiTopP = clamp(Number.isFinite(topP) ? topP : 1, 0, 1);
				const normalizedOpenAiPresencePenalty = clamp(Number.isFinite(presencePenalty) ? presencePenalty : 0, -2, 2);
				const normalizedOpenAiFrequencyPenalty = clamp(Number.isFinite(frequencyPenalty) ? frequencyPenalty : 0, -2, 2);

				const request =
					provider === 'openai'
						? {
								model: trimmedModel,
								messages: [
									...(systemPrompt.trim() ? [{ role: 'system', content: systemPrompt.trim() }] : []),
									...messages.map((m) => ({ role: m.role, content: m.content }))
								],
								temperature: normalizedOpenAiTemperature,
								top_p: normalizedOpenAiTopP !== 1 ? normalizedOpenAiTopP : undefined,
								presence_penalty: normalizedOpenAiPresencePenalty !== 0 ? normalizedOpenAiPresencePenalty : undefined,
								frequency_penalty: normalizedOpenAiFrequencyPenalty !== 0 ? normalizedOpenAiFrequencyPenalty : undefined,
								max_tokens: Number.isFinite(maxTokens) ? maxTokens : 1024,
								stream_options: includeUsage && !didRetryWithoutUsage ? { include_usage: true } : undefined,
								stream: true
							}
						: {
								model: trimmedModel,
								system: systemPrompt.trim() ? systemPrompt.trim() : undefined,
								messages: messages.map((m) => ({ role: m.role, content: [{ type: 'text', text: m.content }] })),
								max_tokens: Number.isFinite(maxTokens) ? maxTokens : 1024,
								stream: true
							};

				const proxyPayloadBase = {
					provider,
					baseUrl: trimmedBaseUrl,
					anthropicVersion: trimmedAnthropicVersion,
					request
				};
				const proxyPayload = { ...proxyPayloadBase, apiKey: trimmedApiKey };

				if (!debugSession) {
					debugSession = {
						startedAt: Date.now(),
						endedAt: null,
						aborted: false,
						provider,
						baseUrl: trimmedBaseUrl,
						model: trimmedModel,
						anthropicVersion: trimmedAnthropicVersion,
						upstreamUrl: buildUpstreamUrl(provider, trimmedBaseUrl),
						proxyStatus: null,
						proxyOk: null,
						proxyErrorText: null,
						firstEventAt: null,
						eventCount: 0,
						bytesApprox: 0,
						events: [],
						origin,
						proxyPayloadBase,
						proxyPayloadMaskedJson: prettyJson({ ...proxyPayloadBase, apiKey: maskApiKey(trimmedApiKey) }) || '{}',
						upstreamRequestJson: prettyJson(request) || '{}',
						proxyCurl: buildProxyCurl({ origin, payload: proxyPayload, includeKey: false }),
						upstreamCurl: buildUpstreamCurl({
							provider,
							baseUrl: trimmedBaseUrl,
							apiKey: trimmedApiKey,
							anthropicVersion: trimmedAnthropicVersion,
							request,
							includeKey: false
						})
					};
				}

				const res = await fetch('/api/chat', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(proxyPayload),
					signal: abortController.signal
				});

				if (debugSession) {
					debugSession.proxyStatus = res.status;
					debugSession.proxyOk = res.ok;
				}

				if (!res.ok) {
					const text = await res.text().catch(() => '');
					error = `代理请求失败（HTTP ${res.status}）${text ? `：${text}` : ''}`;
					if (debugSession) debugSession.proxyErrorText = truncateText(text || `HTTP ${res.status}`, DEBUG_ERROR_SNIPPET_MAX);
					openDebugPanel();
					return;
				}

				let retryWithoutUsage = false;
				await streamSse(
					res,
					(event) => {
						recordDebugEvent(event);
						lastEvent = event.event;

						const proxyErr = parseProxyErrorEvent(event);
						if (proxyErr) {
							if (
								provider === 'openai' &&
								includeUsage &&
								!didRetryWithoutUsage &&
								proxyErr.status === 400 &&
								looksLikeUsageUnsupportedError(proxyErr)
							) {
								retryWithoutUsage = true;
								return false;
							}

							error = proxyErr.status ? `上游错误（HTTP ${proxyErr.status}）：${proxyErr.message}` : proxyErr.message;
							if (debugSession) {
								debugSession.proxyErrorText = truncateText(
									proxyErr.status ? `HTTP ${proxyErr.status}: ${proxyErr.message}` : proxyErr.message,
									DEBUG_ERROR_SNIPPET_MAX
								);
							}
							openDebugPanel();
							return false;
						}

						return provider === 'openai' ? applyOpenAiDelta(event) : applyAnthropicDelta(event);
					},
					{ signal: abortController.signal }
				);

				if (retryWithoutUsage) {
					didRetryWithoutUsage = true;
					includeUsage = false;
					showNotice('检测到上游不支持 Token 统计（stream_options.include_usage），已自动关闭并重试。本次回答将不显示 tokens。');
					assistantDraft = '';
					assistantThinkingDraft = '';
					streamingUsage = null;
					thoughtSplitter.reset();
					continue;
				}

				break;
			}
		} catch (e) {
			if (abortController.signal.aborted) {
				error = '已停止。';
				if (debugSession) debugSession.aborted = true;
			} else {
				error = e instanceof Error ? e.message : String(e);
				openDebugPanel();
			}

			if (debugSession && !debugSession.proxyErrorText && error) {
				debugSession.proxyErrorText = truncateText(error, DEBUG_ERROR_SNIPPET_MAX);
			}
		} finally {
			streaming = false;
			abortController = null;

			if (debugSession && !debugSession.endedAt) debugSession.endedAt = Date.now();

			const flushed = thoughtSplitter.flush();
			if (flushed.contentDelta) assistantDraft += flushed.contentDelta;
			if (flushed.thinkingDelta) assistantThinkingDraft += flushed.thinkingDelta;

			const finalText = assistantDraft.trim();
			const finalThinking = assistantThinkingDraft.trim();
			const finalUsage = streamingUsage ?? undefined;
			if (finalText || finalThinking) {
				push('assistant', finalText, finalThinking || undefined, finalUsage);
			}

			assistantDraft = '';
			assistantThinkingDraft = '';
			streamingUsage = null;
			streamingThinkingVisible = false;
			streamingThinkingOpen = false;
		}
	}
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="container">
	<div class="grid" style={`--left-sidebar-width: ${leftSidebarWidth}px; --right-sidebar-width: ${rightSidebarWidth}px;`}>
		<aside class="conversations-panel" class:open={conversationsOpen}>
			<div class="panel-header">
				<h2>会话</h2>
				<div class="panel-header-actions">
					<button class="btn btn-sm" type="button" onclick={createConversation} disabled={streaming}>
						新建
					</button>
					<button class="btn btn-sm" type="button" onclick={() => importInputEl?.click()} disabled={streaming}>
						导入
					</button>
					<button class="btn btn-sm panel-close" type="button" onclick={closePanels}>
						关闭
					</button>
				</div>
			</div>
			<div class="panel-body conversations-body">
				<div class="field">
					<label for="convSearch">搜索</label>
					<input
						id="convSearch"
						bind:value={conversationQuery}
						placeholder="按标题/内容搜索"
						disabled={streaming}
						autocapitalize="off"
						autocomplete="off"
						spellcheck="false"
					/>
				</div>

				{#if !conversationsHydrated}
					<div class="muted">加载中…</div>
				{:else}
					<div class="conv-list">
						{#each getVisibleConversations() as c (c.id)}
							<div class="conv-item" class:active={c.id === currentConversationId}>
								<div class="conv-main">
									{#if editingConversationId === c.id}
										<input
											class="conv-title-edit"
											bind:value={editingConversationTitle}
											onkeydown={(e) => {
												if (e.key === 'Enter') {
													e.preventDefault();
													commitRenameConversation(c.id);
												}
												if (e.key === 'Escape') {
													e.preventDefault();
													cancelRenameConversation();
												}
											}}
											onblur={() => editingConversationId === c.id && commitRenameConversation(c.id)}
											disabled={streaming}
											autocapitalize="off"
											autocomplete="off"
											spellcheck="false"
										/>
									{:else}
										<button class="conv-select" type="button" onclick={() => selectConversation(c.id)} disabled={streaming}>
											<div class="conv-title-row">
												<strong class="conv-title">{c.title}</strong>
												<span class="conv-time">{fmtTime(c.updatedAt)}</span>
											</div>
											<div class="conv-snippet" class:muted={!c.lastSnippet}>{c.lastSnippet || '（空）'}</div>
										</button>
									{/if}
								</div>
								<div class="conv-actions-row">
									<button class="btn btn-sm" type="button" onclick={() => startRenameConversation(c.id)} disabled={streaming}>
										改名
									</button>
									<button class="btn btn-sm" type="button" onclick={() => duplicateConversation(c.id)} disabled={streaming}>
										复制
									</button>
									<button class="btn btn-sm" type="button" onclick={() => exportConversationJson(c.id)} disabled={streaming}>
										JSON
									</button>
									<button
										class="btn btn-sm"
										type="button"
										onclick={() => exportConversationMarkdown(c.id)}
										disabled={streaming}
									>
										MD
									</button>
									<button class="btn btn-sm danger" type="button" onclick={() => deleteConversation(c.id)} disabled={streaming}>
										删除
									</button>
								</div>
							</div>
						{/each}
					</div>
				{/if}

				<input
					class="file-input"
					type="file"
					accept="application/json"
					bind:this={importInputEl}
					onchange={handleImportFileChange}
				/>
			</div>
		</aside>

		<div
			class="col-resizer col-resizer-left"
			class:dragging={resizingSidebar === 'left'}
			role="separator"
			aria-label="调整会话栏宽度"
			aria-orientation="vertical"
			title="拖拽调整宽度"
			onpointerdown={(e) => startSidebarResize('left', e)}
		></div>

		<section class="chat-area" bind:this={chatAreaEl}>
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
					<button class="btn btn-sm conversations-toggle" type="button" onclick={openConversationsPanel}>
						会话
					</button>
					<button class="btn btn-sm settings-toggle" type="button" onclick={openSettingsPanel}>
						设置
					</button>
				</div>
			</div>

			<div class="messages" bind:this={messagesEl} onscroll={syncStickToBottom} use:delegateCopy>
				{#if notice}
					<div class="notice">{notice}</div>
				{/if}
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
								{#if m.role === 'assistant' && formatTokenUsage(m.usage)}
									<span class="meta-pill meta-pill-static" title="本次回答 Token 用量">
										{formatTokenUsage(m.usage)}
									</span>
								{/if}
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
								{#if formatTokenUsage(streamingUsage)}
									<span class="meta-pill meta-pill-static" title="本次回答 Token 用量">
										{formatTokenUsage(streamingUsage)}
									</span>
								{/if}
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

			<div class="composer-wrapper" bind:this={composerWrapperEl}>
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

		<div
			class="col-resizer col-resizer-right"
			class:dragging={resizingSidebar === 'right'}
			role="separator"
			aria-label="调整设置栏宽度"
			aria-orientation="vertical"
			title="拖拽调整宽度"
			onpointerdown={(e) => startSidebarResize('right', e)}
		></div>

		{#if settingsOpen || conversationsOpen}
			<button class="settings-overlay" type="button" aria-label="关闭面板" onclick={closePanels}></button>
		{/if}

			<aside class="settings-panel" class:open={settingsOpen}>
				<div class="panel-header">
					<h2>{rightPanelTab === 'settings' ? '运行设置' : '调试面板'}</h2>
					<div class="panel-header-actions">
						<span class="pill">{streaming ? '生成中' : '空闲'}</span>
						<button class="btn btn-sm panel-close" type="button" onclick={closePanels}>
							关闭
						</button>
					</div>
				</div>
				<div class="panel-tabs">
					<button class="tab" type="button" class:active={rightPanelTab === 'settings'} onclick={() => (rightPanelTab = 'settings')}>
						设置
					</button>
					<button class="tab" type="button" class:active={rightPanelTab === 'debug'} onclick={() => (rightPanelTab = 'debug')}>
						调试
					</button>
				</div>

				{#if rightPanelTab === 'settings'}
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
							<label class="checkbox">
								<input id="includeUsage" type="checkbox" bind:checked={includeUsage} />
								<span>显示 Token 用量（需要上游支持 usage；OpenAI 会尝试 stream_options.include_usage）</span>
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
						<div class="label-row">
							<label for="topP">top_p（核采样）</label>
							<span class="val">{topP}</span>
						</div>
						<input
							id="topP"
							type="range"
							min="0"
							max="1"
							step="0.01"
							bind:value={topP}
							disabled={streaming || provider !== 'openai'}
						/>
					</div>

					<div class="field">
						<div class="label-row">
							<label for="presencePenalty">presence_penalty（存在惩罚）</label>
							<span class="val">{presencePenalty}</span>
						</div>
						<input
							id="presencePenalty"
							type="range"
							min="-2"
							max="2"
							step="0.1"
							bind:value={presencePenalty}
							disabled={streaming || provider !== 'openai'}
						/>
					</div>

					<div class="field">
						<div class="label-row">
							<label for="frequencyPenalty">frequency_penalty（频率惩罚）</label>
							<span class="val">{frequencyPenalty}</span>
						</div>
						<input
							id="frequencyPenalty"
							type="range"
							min="-2"
							max="2"
							step="0.1"
							bind:value={frequencyPenalty}
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
				{:else}
					<div class="panel-body">
						{#if !debugSession}
							<div class="muted">暂无调试记录。发送一次请求后，这里会显示请求、状态与事件流。</div>
						{:else}
							<div class="debug-section">
								<div class="debug-section-head">
									<strong>本次请求</strong>
									<div class="debug-actions">
										<button class="btn btn-sm" type="button" onclick={clearDebugSession}>清空</button>
									</div>
								</div>

								<div class="debug-metrics">
									<div class="debug-kv">
										<span class="muted">开始</span>
										<span>{fmtTime(debugSession.startedAt)}</span>
									</div>
									<div class="debug-kv">
										<span class="muted">首事件</span>
										<span
											>{debugSession.firstEventAt
												? fmtMs(debugSession.firstEventAt - debugSession.startedAt)
												: '—'}</span
										>
									</div>
									<div class="debug-kv">
										<span class="muted">总耗时</span>
										<span
											>{debugSession.endedAt
												? fmtMs(debugSession.endedAt - debugSession.startedAt)
												: streaming
													? '进行中…'
													: '—'}</span
										>
									</div>
									<div class="debug-kv">
										<span class="muted">HTTP</span>
										<span>{debugSession.proxyStatus ?? '—'}</span>
									</div>
									<div class="debug-kv">
										<span class="muted">事件数</span>
										<span>{debugSession.eventCount}</span>
									</div>
									<div class="debug-kv">
										<span class="muted">字节(估算)</span>
										<span>{fmtBytes(debugSession.bytesApprox)}</span>
									</div>
									<div class="debug-kv debug-kv-full">
										<span class="muted">Upstream</span>
										<span class="mono">{debugSession.upstreamUrl || '—'}</span>
									</div>
								</div>

								{#if debugSession.aborted}
									<div class="muted">已停止（abort）。</div>
								{/if}
							</div>

							{#if debugSession.proxyErrorText}
								<div class="debug-section">
									<div class="debug-section-head">
										<strong>错误</strong>
										<div class="debug-actions">
											<button
												class="btn btn-sm"
												type="button"
												onclick={() => copyToClipboard(debugSession?.proxyErrorText ?? '')}
											>
												复制
											</button>
										</div>
									</div>
									<pre class="debug-pre">{debugSession.proxyErrorText}</pre>
								</div>
							{/if}

							<div class="debug-section">
								<div class="debug-section-head">
									<strong>/api/chat 请求（默认脱敏）</strong>
									<div class="debug-actions">
										<button class="btn btn-sm" type="button" onclick={() => copyDebugProxyJson(false)}>复制 JSON</button>
										<button class="btn btn-sm" type="button" onclick={() => copyDebugProxyJson(true)}>复制 JSON（含 key）</button>
									</div>
								</div>
								<pre class="debug-pre">{debugSession.proxyPayloadMaskedJson}</pre>
								<details class="debug-details">
									<summary>上游 request（JSON）</summary>
									<pre class="debug-pre">{debugSession.upstreamRequestJson}</pre>
								</details>
							</div>

							<div class="debug-section">
								<div class="debug-section-head">
									<strong>curl 复现（默认占位 KEY）</strong>
								</div>
								<div class="debug-grid">
									<div class="debug-sub">
										<div class="debug-sub-head">
											<span class="muted">Proxy</span>
											<div class="debug-actions">
												<button class="btn btn-sm" type="button" onclick={() => copyDebugProxyCurl(false)}>复制</button>
												<button class="btn btn-sm" type="button" onclick={() => copyDebugProxyCurl(true)}>含 key</button>
											</div>
										</div>
										<pre class="debug-pre">{debugSession.proxyCurl}</pre>
									</div>
									<div class="debug-sub">
										<div class="debug-sub-head">
											<span class="muted">Upstream</span>
											<div class="debug-actions">
												<button class="btn btn-sm" type="button" onclick={() => copyDebugUpstreamCurl(false)}>复制</button>
												<button class="btn btn-sm" type="button" onclick={() => copyDebugUpstreamCurl(true)}>含 key</button>
											</div>
										</div>
										<pre class="debug-pre">{debugSession.upstreamCurl}</pre>
									</div>
								</div>
							</div>

							<div class="debug-section">
								<div class="debug-section-head">
									<strong>SSE 事件流（最近 {debugSession.events.length}/{DEBUG_MAX_EVENTS}）</strong>
									<span class="muted">{debugSession.eventCount > DEBUG_MAX_EVENTS ? '已截断' : ''}</span>
								</div>
								<div class="debug-events">
									{#each debugSession.events as ev (ev.n)}
										<div class="debug-event">
											<div class="debug-event-meta">
												<span class="pill">{ev.event ?? 'message'}</span>
												<span class="muted">{fmtTime(ev.at)}</span>
												<span class="muted">{ev.dataLen} chars</span>
											</div>
											<pre class="debug-event-pre">{ev.dataSnippet}</pre>
										</div>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				{/if}
		</aside>
	</div>
</div>
