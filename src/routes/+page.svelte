<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { streamSse, type SseEvent } from '$lib/sse';
	import { renderMarkdownToHtml } from '$lib/markdown';
	import { buildForkForRerun, buildForkForRetry } from '$lib/chat-ops.js';
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
		buildDebugReportShareUrl,
		createDebugReport,
		decodeDebugReportFromHash,
		toDebugReportJson,
		toDebugReportMarkdown
	} from '$lib/debug-report';
	import {
		buildProfilesShareUrl,
		createProfileId,
		decodeProfilesFromHash,
		normalizeProfileName,
		parseProfilesImport,
		serializeProfilesExport,
		readProfiles,
		writeProfiles
	} from '$lib/profiles';
	import {
		DEFAULT_PROMPT_TEMPLATES,
		deleteUserPromptTemplate,
		markPromptTemplateUsed,
		parseTemplateVariables,
		readPromptTemplates,
		renderTemplate,
		togglePromptTemplateFavorite,
		upsertUserPromptTemplate,
		writePromptTemplates
	} from '$lib/prompt-templates';
	import {
		createAnthropicSseContext,
		createThoughtChainSplitter,
		parseAnthropicSseEvent,
		parseOpenAiSseData
	} from '$lib/thought-chain';
	import { estimateUsdCost, formatUsd } from '$lib/cost.js';
	import { applyUiPrefsToRoot, createDefaultUiPrefs, readUiPrefs, writeUiPrefs } from '$lib/ui-prefs.js';

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

	type CompareTargetSecret = {
		apiKey: string;
		inputUsdPer1M: number;
		outputUsdPer1M: number;
	};

	type CompareTargetPricing = {
		inputUsdPer1M: number;
		outputUsdPer1M: number;
	};

	type CompareRunStatus = 'idle' | 'running' | 'done' | 'error' | 'aborted';

	type CompareRun = {
		id: string;
		name: string;
		provider: Provider;
		baseUrl: string;
		model: string;
		run: ConversationRunSnapshot;
		status: CompareRunStatus;
		startedAt: number;
		firstEventAt: number | null;
		endedAt: number | null;
		error: string | null;
		content: string;
		thinking: string;
		usage: TokenUsage | null;
		didRetryWithoutUsage: boolean;
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
			compareMode: boolean;
			compareTargetIds: string[];
			compareEstimateCost: boolean;
			comparePricingById: Record<string, CompareTargetPricing>;
		};
	};

	const SETTINGS_STORAGE_KEY = 'edgeai-playground:settings:v1';
	const LAYOUT_STORAGE_KEY = 'edgeai-playground:layout:v1';

	type StoredLayoutV1 = {
		v: 1;
		leftSidebarWidth: number;
		rightSidebarWidth: number;
	};

	type UiColorScheme = 'system' | 'light' | 'dark';
	type UiFontSize = 'sm' | 'md' | 'lg';
	type UiDensity = 'compact' | 'comfortable' | 'spacious';

	type StoredUiPrefsV1 = {
		v: 1;
		colorScheme: UiColorScheme;
		fontSize: UiFontSize;
		density: UiDensity;
	};

	type Profile = {
		id: string;
		name: string;
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
		createdAt: number;
		updatedAt: number;
		apiKey?: string;
	};

	type StoredProfilesV1 = {
		v: 1;
		currentId: string | null;
		items: Profile[];
	};

	type UserPromptTemplateV1 = {
		id: string;
		title: string;
		content: string;
		createdAt: number;
		updatedAt: number;
	};

	type StoredPromptTemplatesV1 = {
		v: 1;
		items: UserPromptTemplateV1[];
		favorites: string[];
		recent: string[];
	};

	type PromptTemplateView = {
		id: string;
		title: string;
		content: string;
		builtin: boolean;
		createdAt?: number;
		updatedAt?: number;
	};

	const DESKTOP_BREAKPOINT_PX = 980;

	const COMPARE_CURRENT_TARGET_ID = '__current';
	const COMPARE_MAX_TARGETS = 6;

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

	function safeStringArray(v: unknown): string[] {
		if (!Array.isArray(v)) return [];
		const out: string[] = [];
		for (const it of v) {
			if (typeof it !== 'string') continue;
			const s = it.trim();
			if (!s) continue;
			if (!out.includes(s)) out.push(s);
		}
		return out;
	}

	function normalizeCompareTargetIds(raw: string[]): string[] {
		const out: string[] = [];
		for (const it of raw) {
			const s = typeof it === 'string' ? it.trim() : '';
			if (!s) continue;
			if (out.includes(s)) continue;
			out.push(s);
			if (out.length >= COMPARE_MAX_TARGETS) break;
		}
		return out.length ? out : [COMPARE_CURRENT_TARGET_ID];
	}

	function safeComparePricingById(v: unknown): Record<string, CompareTargetPricing> {
		if (!v || typeof v !== 'object') return {};
		const out: Record<string, CompareTargetPricing> = {};
		for (const [rawId, rawPricing] of Object.entries(v)) {
			const id = typeof rawId === 'string' ? rawId.trim() : '';
			if (!id) continue;

			const p = rawPricing as any;
			const inputUsdPer1M = Math.max(0, safeNumber(p?.inputUsdPer1M, 0));
			const outputUsdPer1M = Math.max(0, safeNumber(p?.outputUsdPer1M, 0));
			if (inputUsdPer1M <= 0 && outputUsdPer1M <= 0) continue;
			out[id] = { inputUsdPer1M, outputUsdPer1M };
		}
		return out;
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
					includeUsage: safeBoolean(common.includeUsage, true),
					compareMode: safeBoolean(common.compareMode, false),
					compareTargetIds: normalizeCompareTargetIds(safeStringArray(common.compareTargetIds)),
					compareEstimateCost: safeBoolean(common.compareEstimateCost, false),
					comparePricingById: safeComparePricingById(common.comparePricingById)
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
	let editingMessageId = $state<string | null>(null);
	let editingMessageDraft = $state('');
	let assistantDraft = $state('');
	let assistantThinkingDraft = $state('');
	let streamingUsage = $state<TokenUsage | null>(null);
	let streaming = $state(false);
	let lastEvent = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let error = $state<string | null>(null);

	let settingsHydrated = $state(false);
	let uiPrefsHydrated = $state(false);
	let uiColorScheme = $state<UiColorScheme>('system');
	let uiFontSize = $state<UiFontSize>('md');
	let uiDensity = $state<UiDensity>('comfortable');
	let uiSaveTimer: number | null = null;

	let isDesktop = $state(true);

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
	let compareMode = $state(false);
	let compareTargetIds = $state<string[]>([COMPARE_CURRENT_TARGET_ID]);
	let compareEstimateCost = $state(false);
	let compareSecretsById = $state<Record<string, CompareTargetSecret>>({});
	let compareRuns = $state<CompareRun[]>([]);
	let compareAbortControllers: AbortController[] = [];
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

	// Profiles 资产化（localStorage v1；默认不落盘 API Key）
	let profilesHydrated = $state(false);
	let profiles = $state<Profile[]>([]);
	let activeProfileId = $state('');
	let newProfileName = $state('');
	let profilesImportText = $state('');
	let profilesImportInputEl = $state<HTMLInputElement | null>(null);

	// Prompt 模板库资产化（localStorage v1；内置模板只读）
	let promptTemplatesHydrated = $state(false);
	let promptTemplates = $state<StoredPromptTemplatesV1>({ v: 1, items: [], favorites: [], recent: [] });
	let promptTemplatesOpen = $state(false);
	let promptTemplatesTab = $state<'all' | 'favorites' | 'recent'>('all');
	let promptTemplatesQuery = $state('');
	let selectedTemplateId = $state('');
	let templateDraftTitle = $state('');
	let templateDraftContent = $state('');
	let templateVarValues = $state<Record<string, string>>({});
	let keepUnfilledPlaceholders = $state(true);

	let promptTextareaEl = $state<HTMLTextAreaElement | null>(null);
	let lastDrawerFocusEl: HTMLElement | null = null;
	let lastModalFocusEl: HTMLElement | null = null;

	let conversationsPanelEl = $state<HTMLElement | null>(null);
	let settingsPanelEl = $state<HTMLElement | null>(null);
	let promptTemplatesModalEl = $state<HTMLDivElement | null>(null);

	let convSearchEl = $state<HTMLInputElement | null>(null);
	let providerSelectEl = $state<HTMLSelectElement | null>(null);
	let tmplSearchEl = $state<HTMLInputElement | null>(null);

	const EDGE_SWIPE_PX = 20;
	const SWIPE_TRIGGER_PX = 40;
	const SWIPE_DIRECTION_LOCK_RATIO = 1.2;
	let swipeMode: null | 'open-left' | 'open-right' | 'close-left' | 'close-right' = null;
	let swipeStartX = 0;
	let swipeStartY = 0;
	let swipePointerId: number | null = null;

	function captureDrawerFocus() {
		if (isDesktop) return;
		if (lastDrawerFocusEl) return;
		if (typeof document === 'undefined') return;
		const el = document.activeElement;
		lastDrawerFocusEl = el instanceof HTMLElement ? el : null;
	}

	function captureModalFocus() {
		if (typeof document === 'undefined') return;
		const el = document.activeElement;
		lastModalFocusEl = el instanceof HTMLElement ? el : null;
	}

	async function restoreDrawerFocus() {
		if (!lastDrawerFocusEl) return;
		await tick();
		try {
			lastDrawerFocusEl.focus();
		} catch {
			// 忽略：焦点目标可能已卸载
		}
		lastDrawerFocusEl = null;
	}

	async function restoreModalFocus() {
		if (!lastModalFocusEl) return;
		await tick();
		try {
			lastModalFocusEl.focus();
		} catch {
			// 忽略：焦点目标可能已卸载
		}
		lastModalFocusEl = null;
	}

	function getActiveFocusTrapContainer(): HTMLElement | null {
		if (promptTemplatesOpen) return promptTemplatesModalEl;
		if (!isDesktop && conversationsOpen) return conversationsPanelEl;
		if (!isDesktop && settingsOpen) return settingsPanelEl;
		return null;
	}

	function getFocusableElements(container: HTMLElement): HTMLElement[] {
		const list = Array.from(
			container.querySelectorAll<HTMLElement>(
				'a[href],button,textarea,input,select,summary,[tabindex]:not([tabindex="-1"])'
			)
		);

		return list.filter((el) => {
			if (!(el instanceof HTMLElement)) return false;
			if (el.hasAttribute('disabled')) return false;
			const tab = el.getAttribute('tabindex');
			if (tab === '-1') return false;
			return true;
		});
	}

	function resetSwipe() {
		swipeMode = null;
		swipePointerId = null;
	}

	function handleGlobalPointerDown(e: PointerEvent) {
		if (isDesktop) return;
		if (promptTemplatesOpen) return;
		if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;

		const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
		if (vw <= 0) return;

		const x = e.clientX;
		swipeStartX = e.clientX;
		swipeStartY = e.clientY;
		swipePointerId = e.pointerId;

		if (!conversationsOpen && !settingsOpen) {
			if (x <= EDGE_SWIPE_PX) swipeMode = 'open-left';
			else if (x >= vw - EDGE_SWIPE_PX) swipeMode = 'open-right';
			else resetSwipe();
			return;
		}

		if (conversationsOpen) swipeMode = 'close-left';
		else if (settingsOpen) swipeMode = 'close-right';
		else resetSwipe();
	}

	function handleGlobalPointerMove(e: PointerEvent) {
		if (!swipeMode) return;
		if (swipePointerId !== e.pointerId) return;

		const dx = e.clientX - swipeStartX;
		const dy = e.clientY - swipeStartY;

		if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
		if (Math.abs(dx) < Math.abs(dy) * SWIPE_DIRECTION_LOCK_RATIO) {
			// 更像纵向滚动：不打断用户
			resetSwipe();
			return;
		}

		if (swipeMode === 'open-left' && dx > SWIPE_TRIGGER_PX) {
			openConversationsPanel();
			resetSwipe();
			return;
		}
		if (swipeMode === 'open-right' && dx < -SWIPE_TRIGGER_PX) {
			openSettingsPanel();
			resetSwipe();
			return;
		}
		if (swipeMode === 'close-left' && dx < -SWIPE_TRIGGER_PX) {
			closePanels();
			resetSwipe();
			return;
		}
		if (swipeMode === 'close-right' && dx > SWIPE_TRIGGER_PX) {
			closePanels();
			resetSwipe();
			return;
		}
	}

	function handleGlobalPointerUp(e: PointerEvent) {
		if (swipePointerId !== e.pointerId) return;
		resetSwipe();
	}

	function handleGlobalPointerCancel(e: PointerEvent) {
		if (swipePointerId !== e.pointerId) return;
		resetSwipe();
	}

	function handleGlobalKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			if (promptTemplatesOpen) {
				e.preventDefault();
				closePromptTemplatesModal();
				return;
			}
			if (!isDesktop && (settingsOpen || conversationsOpen)) {
				e.preventDefault();
				closePanels();
				return;
			}
			return;
		}

		if (e.key !== 'Tab') return;
		if (typeof document === 'undefined') return;

		const container = getActiveFocusTrapContainer();
		if (!container) return;

		const focusables = getFocusableElements(container);
		if (!focusables.length) {
			e.preventDefault();
			container.focus?.();
			return;
		}

		const active = document.activeElement;
		const idx = active instanceof HTMLElement ? focusables.indexOf(active) : -1;
		if (e.shiftKey) {
			if (idx <= 0) {
				e.preventDefault();
				focusables[focusables.length - 1].focus();
			}
			return;
		}

		if (idx === -1 || idx === focusables.length - 1) {
			e.preventDefault();
			focusables[0].focus();
		}
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
		compareRuns = [];
		thinkingVisibleById = {};
		thinkingOpenById = {};
		cancelEditMessage();
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

	async function openSettingsPanel() {
		captureDrawerFocus();
		settingsOpen = true;
		conversationsOpen = false;
		rightPanelTab = 'settings';

		if (isDesktop) return;
		await tick();
		providerSelectEl?.focus();
		settingsPanelEl?.focus();
	}

	async function openDebugPanel() {
		captureDrawerFocus();
		settingsOpen = true;
		conversationsOpen = false;
		rightPanelTab = 'debug';

		if (isDesktop) return;
		await tick();
		settingsPanelEl?.focus();
	}

	async function openConversationsPanel() {
		captureDrawerFocus();
		conversationsOpen = true;
		settingsOpen = false;

		if (isDesktop) return;
		await tick();
		convSearchEl?.focus();
		conversationsPanelEl?.focus();
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

	function handleSidebarSeparatorKeydown(side: 'left' | 'right', e: KeyboardEvent) {
		if (!isDesktopViewport()) return;
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;

		const step = e.shiftKey ? 48 : 16;
		const vw = getViewportWidth();
		if (vw <= 0) return;

		e.preventDefault();
		e.stopPropagation();

		if (side === 'left') {
			const max = Math.max(LEFT_SIDEBAR_MIN_PX, Math.min(LEFT_SIDEBAR_MAX_PX, vw - rightSidebarWidth - CENTER_MIN_PX));
			const delta = e.key === 'ArrowRight' ? step : -step;
			leftSidebarWidth = Math.round(clamp(leftSidebarWidth + delta, LEFT_SIDEBAR_MIN_PX, max));
		} else {
			const max = Math.max(RIGHT_SIDEBAR_MIN_PX, Math.min(RIGHT_SIDEBAR_MAX_PX, vw - leftSidebarWidth - CENTER_MIN_PX));
			const delta = e.key === 'ArrowLeft' ? step : -step;
			rightSidebarWidth = Math.round(clamp(rightSidebarWidth + delta, RIGHT_SIDEBAR_MIN_PX, max));
		}

		writeLayout({ v: 1, leftSidebarWidth, rightSidebarWidth });
	}

	async function closePanels() {
		const shouldRestore = !isDesktop && (settingsOpen || conversationsOpen);
		settingsOpen = false;
		conversationsOpen = false;
		if (shouldRestore) await restoreDrawerFocus();
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

	function forkConversationFromMessages(baseMessages: ChatMessage[], suffix: string) {
		if (streaming) return null;
		const now = Date.now();
		const newId = createId();

		const srcMeta = getCurrentConversationMeta();
		const baseTitle = srcMeta ? srcMeta.title : DEFAULT_CONVERSATION_TITLE;

		const meta: ConversationListItem = {
			id: newId,
			title: normalizeConversationTitle(`${baseTitle} · ${suffix}`),
			createdAt: now,
			updatedAt: now,
			lastSnippet: '',
			pinned: false
		};

		const forkMessages = baseMessages.map((m) => ({ ...m, ...(m.usage ? { usage: { ...m.usage } } : {}) }));
		const nextMeta = updateConversationMetaFromMessages(meta, forkMessages, now);

		try {
			writeConversationDetail(localStorage, {
				v: 1,
				id: newId,
				messages: forkMessages,
				run: currentConversationRun
			});
		} catch {
			// localStorage 可能被禁用（隐私模式/策略）
		}

		conversations = sortConversationList([nextMeta, ...conversations]);
		currentConversationId = newId;
		messages = forkMessages;
		editingConversationId = null;
		editingConversationTitle = '';

		persistConversationsIndex();
		resetTransientUiAfterConversationChange();
		conversationsOpen = false;

		return newId;
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

	function sortProfilesList(items: Profile[]) {
		return [...items].sort((a, b) => {
			if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
			if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
			return a.name.localeCompare(b.name);
		});
	}

	function getProfile(id: string): Profile | null {
		return profiles.find((p) => p.id === id) ?? null;
	}

	function persistProfiles() {
		if (!profilesHydrated) return;
		try {
			const payload: StoredProfilesV1 = {
				v: 1,
				currentId: activeProfileId || null,
				items: profiles.map((p) => ({ ...p }))
			};
			writeProfiles(localStorage, payload as any);
		} catch {
			// localStorage 可能被禁用（隐私模式/策略）
		}
	}

	function persistPromptTemplates(next: StoredPromptTemplatesV1 = promptTemplates) {
		if (!promptTemplatesHydrated) return;
		try {
			writePromptTemplates(localStorage, next as any);
		} catch {
			// localStorage 可能被禁用（隐私模式/策略）
		}
	}

	function buildAllPromptTemplates(): PromptTemplateView[] {
		const builtins: PromptTemplateView[] = DEFAULT_PROMPT_TEMPLATES.map((t) => ({ ...t, builtin: true }));
		const users: PromptTemplateView[] = [...promptTemplates.items]
			.sort((a, b) => {
				if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
				if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
				return a.title.localeCompare(b.title);
			})
			.map((t) => ({ ...t, builtin: false }));
		return [...builtins, ...users];
	}

	function getPromptTemplateById(id: string): PromptTemplateView | null {
		const tid = safeString(id, '').trim();
		if (!tid) return null;
		const builtin = DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === tid);
		if (builtin) return { ...builtin, builtin: true };
		const user = promptTemplates.items.find((t) => t.id === tid);
		return user ? { ...user, builtin: false } : null;
	}

	function isPromptTemplateFavorite(id: string) {
		const tid = safeString(id, '').trim();
		if (!tid) return false;
		return promptTemplates.favorites.includes(tid);
	}

	function listTemplatesByIds(ids: string[]): PromptTemplateView[] {
		const out: PromptTemplateView[] = [];
		for (const id of ids) {
			const t = getPromptTemplateById(id);
			if (t) out.push(t);
		}
		return out;
	}

	function getVisiblePromptTemplates(): PromptTemplateView[] {
		const tab = promptTemplatesTab;
		const base =
			tab === 'recent'
				? listTemplatesByIds(promptTemplates.recent)
				: tab === 'favorites'
					? listTemplatesByIds(promptTemplates.favorites)
					: buildAllPromptTemplates();

		const q = promptTemplatesQuery.trim().toLowerCase();
		if (!q) return base;
		return base.filter((t) => t.title.toLowerCase().includes(q) || t.content.toLowerCase().includes(q));
	}

	function selectPromptTemplate(id: string) {
		const t = getPromptTemplateById(id);
		if (!t) {
			selectedTemplateId = '';
			templateDraftTitle = '';
			templateDraftContent = '';
			templateVarValues = {};
			keepUnfilledPlaceholders = true;
			return;
		}
		selectedTemplateId = t.id;
		templateDraftTitle = t.title;
		templateDraftContent = t.content;
		templateVarValues = {};
		keepUnfilledPlaceholders = true;
	}

	async function openPromptTemplatesModal() {
		if (streaming) return;
		captureModalFocus();
		promptTemplatesOpen = true;
		promptTemplatesQuery = '';
		promptTemplatesTab = promptTemplates.recent.length ? 'recent' : promptTemplates.favorites.length ? 'favorites' : 'all';

		const first = getVisiblePromptTemplates()[0];
		if (first) selectPromptTemplate(first.id);

		await tick();
		tmplSearchEl?.focus();
		promptTemplatesModalEl?.focus();
	}

	async function closePromptTemplatesModal() {
		promptTemplatesOpen = false;
		await restoreModalFocus();
	}

	function toggleTemplateFavorite(id: string) {
		const tid = safeString(id, '').trim();
		if (!tid) return;
		promptTemplates = togglePromptTemplateFavorite(promptTemplates as any, tid) as any;
		persistPromptTemplates();
	}

	function createUserTemplate() {
		if (streaming) return;
		promptTemplates = upsertUserPromptTemplate(promptTemplates as any, { title: '新模板', content: '' }, { now: Date.now() }) as any;
		persistPromptTemplates();
		promptTemplatesTab = 'all';
		promptTemplatesQuery = '';
		const id = promptTemplates.items[0]?.id ?? '';
		if (id) selectPromptTemplate(id);
	}

	function saveSelectedUserTemplate() {
		const current = getPromptTemplateById(selectedTemplateId);
		if (!current || current.builtin) return;
		promptTemplates = upsertUserPromptTemplate(
			promptTemplates as any,
			{ id: current.id, title: templateDraftTitle, content: templateDraftContent },
			{ now: Date.now() }
		) as any;
		persistPromptTemplates();
		showNotice('已保存模板');
	}

	function deleteSelectedUserTemplate() {
		const current = getPromptTemplateById(selectedTemplateId);
		if (!current || current.builtin) return;
		const ok = window.confirm(`确定删除模板「${current.title}」吗？此操作不可恢复。`);
		if (!ok) return;
		promptTemplates = deleteUserPromptTemplate(promptTemplates as any, current.id) as any;
		persistPromptTemplates();
		showNotice('已删除模板');

		const first = getVisiblePromptTemplates()[0];
		selectPromptTemplate(first?.id ?? '');
	}

	async function insertPromptText(text: string) {
		const t = safeString(text, '').replaceAll('\r', '').trim();
		if (!t) return;

		const el = promptTextareaEl;
		if (el && typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number') {
			const start = el.selectionStart;
			const end = el.selectionEnd;
			prompt = `${prompt.slice(0, start)}${t}${prompt.slice(end)}`;
			await tick();
			el.focus();
			const pos = start + t.length;
			el.selectionStart = pos;
			el.selectionEnd = pos;
			return;
		}

		prompt = prompt.trim() ? `${prompt}\n\n${t}` : t;
		await tick();
		promptTextareaEl?.focus();
	}

	async function insertSelectedTemplate() {
		if (streaming) return;
		const current = getPromptTemplateById(selectedTemplateId);
		if (!current) return;

		const rendered = renderTemplate(templateDraftContent, templateVarValues, { keepUnfilled: keepUnfilledPlaceholders });
		await insertPromptText(rendered);

		promptTemplates = markPromptTemplateUsed(promptTemplates as any, current.id, { maxRecent: 20 }) as any;
		persistPromptTemplates();
		closePromptTemplatesModal();
		showNotice(`已插入模板：「${current.title}」`);
	}

	function makeUniqueProfileName(raw: string, ignoreId: string | null = null) {
		const base = normalizeProfileName(raw);
		const existing = new Set(profiles.filter((p) => p.id !== ignoreId).map((p) => p.name));
		if (!existing.has(base)) return base;
		for (let i = 2; i < 1000; i++) {
			const next = `${base} (${i})`;
			if (!existing.has(next)) return next;
		}
		return `${base} (${Date.now()})`;
	}

	function snapshotCurrentProfileFields(): ConversationRunSnapshot {
		return {
			provider,
			baseUrl: safeString(baseUrl, '').trim(),
			model: safeString(model, '').trim(),
			systemPrompt: safeString(systemPrompt, ''),
			temperature: clamp(Number.isFinite(temperature) ? temperature : 0.7, 0, 2),
			topP: clamp(Number.isFinite(topP) ? topP : 1, 0, 1),
			presencePenalty: clamp(Number.isFinite(presencePenalty) ? presencePenalty : 0, -2, 2),
			frequencyPenalty: clamp(Number.isFinite(frequencyPenalty) ? frequencyPenalty : 0, -2, 2),
			maxTokens: Math.max(1, Math.floor(Number.isFinite(maxTokens) ? maxTokens : 1024)),
			anthropicVersion: safeString(anthropicVersion, DEFAULTS.anthropic.version ?? '2023-06-01').trim() || '2023-06-01'
		};
	}

	function createProfileFromCurrent() {
		if (streaming) return;

		const now = Date.now();
		const hint = model.trim() ? `${provider}:${model.trim()}` : provider;
		const name = makeUniqueProfileName(newProfileName.trim() || hint);

		const profile: Profile = {
			id: createProfileId(),
			name,
			...snapshotCurrentProfileFields(),
			createdAt: now,
			updatedAt: now
		};

		profiles = sortProfilesList([profile, ...profiles]);
		activeProfileId = profile.id;
		newProfileName = '';
		persistProfiles();
		showNotice(`已保存 Profile：「${profile.name}」`);
	}

	function renameProfile(id: string) {
		const p = getProfile(id);
		if (!p) return;
		const raw = window.prompt('重命名 Profile', p.name);
		if (raw == null) return;
		const name = makeUniqueProfileName(raw, id);

		const idx = profiles.findIndex((it) => it.id === id);
		if (idx === -1) return;
		profiles[idx] = { ...profiles[idx], name, updatedAt: Date.now(), apiKey: undefined };
		profiles = sortProfilesList(profiles);
		persistProfiles();
		showNotice('已重命名 Profile');
	}

	function updateProfileFromCurrent(id: string) {
		if (streaming) return;
		const idx = profiles.findIndex((it) => it.id === id);
		if (idx === -1) return;
		const now = Date.now();
		profiles[idx] = {
			...profiles[idx],
			...snapshotCurrentProfileFields(),
			updatedAt: now,
			apiKey: undefined
		};
		profiles = sortProfilesList(profiles);
		persistProfiles();
		showNotice('已用当前设置覆盖 Profile');
	}

	function deleteProfile(id: string) {
		const p = getProfile(id);
		if (!p) return;
		const ok = window.confirm(`确定删除 Profile「${p.name}」吗？此操作不可恢复。`);
		if (!ok) return;

		profiles = profiles.filter((it) => it.id !== id);
		if (activeProfileId === id) activeProfileId = profiles[0]?.id ?? '';
		persistProfiles();
		showNotice('已删除 Profile');
	}

	function applyProfile(id: string) {
		if (streaming) return;
		const p = getProfile(id);
		if (!p) return;

		// 公共字段
		systemPrompt = p.systemPrompt ?? '';
		maxTokens = Math.max(1, Math.floor(Number.isFinite(p.maxTokens) ? p.maxTokens : 1024));

		// provider-specific：写入 cache，再由 applyCacheToFields/switchProvider 统一落到字段上
		if (p.provider === 'openai') {
			providerCache.openai.baseUrl = p.baseUrl || DEFAULTS.openai.baseUrl;
			providerCache.openai.model = p.model || '';
			providerCache.openai.temperature = clamp(Number.isFinite(p.temperature) ? p.temperature : 0.7, 0, 2);
			providerCache.openai.topP = clamp(Number.isFinite(p.topP) ? p.topP : 1, 0, 1);
			providerCache.openai.presencePenalty = clamp(
				Number.isFinite(p.presencePenalty) ? p.presencePenalty : 0,
				-2,
				2
			);
			providerCache.openai.frequencyPenalty = clamp(
				Number.isFinite(p.frequencyPenalty) ? p.frequencyPenalty : 0,
				-2,
				2
			);
		} else {
			providerCache.anthropic.baseUrl = p.baseUrl || DEFAULTS.anthropic.baseUrl;
			providerCache.anthropic.model = p.model || '';
			providerCache.anthropic.anthropicVersion =
				p.anthropicVersion || (DEFAULTS.anthropic.version ?? '2023-06-01');
		}

		// 导入的 Profile 可能带 apiKey：仅填充输入框，不持久化
		if (typeof p.apiKey === 'string' && p.apiKey.trim()) apiKey = p.apiKey.trim();

		if (provider !== p.provider) {
			provider = p.provider;
			switchProvider(provider);
		} else {
			applyCacheToFields(provider);
		}

		activeProfileId = p.id;
		persistProfiles();
		showNotice(`已应用 Profile：「${p.name}」`);
	}

	function exportProfileJson(id: string) {
		const p = getProfile(id);
		if (!p) return;
		const date = new Date().toISOString().slice(0, 10);
		const filename = `profile-${safeFilenamePart(p.name)}-${date}.json`;
		downloadText(filename, serializeProfilesExport([p]), 'application/json; charset=utf-8');
		showNotice('已下载 Profile JSON（默认脱敏）');
	}

	async function copyProfileJson(id: string) {
		const p = getProfile(id);
		if (!p) return;
		await copyToClipboard(serializeProfilesExport([p]));
		showNotice('已复制 Profile JSON（默认脱敏）');
	}

	function exportAllProfilesJson() {
		if (!profiles.length) return;
		const date = new Date().toISOString().slice(0, 10);
		const filename = `profiles-${date}.json`;
		downloadText(filename, serializeProfilesExport(profiles), 'application/json; charset=utf-8');
		showNotice('已下载 Profiles JSON（默认脱敏）');
	}

	async function copyAllProfilesJson() {
		if (!profiles.length) return;
		await copyToClipboard(serializeProfilesExport(profiles));
		showNotice('已复制 Profiles JSON（默认脱敏）');
	}

	async function copyAllProfilesShareLink() {
		if (!profiles.length) return;
		if (!confirmShareProfile()) return;

		const baseUrl = typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : '';
		const out = buildProfilesShareUrl({ baseUrl, profiles });
		if (!out.ok) {
			showNotice(out.reason);
			return;
		}

		await copyToClipboard(out.url);
		showNotice('已复制分享链接（默认脱敏；如过长请改用导出 JSON）');
	}

	function confirmShareProfile() {
		return window.confirm(
			`分享 Profile 将包含 baseUrl/model/system prompt/参数等信息（默认不包含明文 API Key）。\n\n请确认：\n- 只分享给可信对象\n- 不要发到公开渠道\n\n继续吗？`
		);
	}

	async function copyProfileShareLink(id: string) {
		const p = getProfile(id);
		if (!p) return;
		if (!confirmShareProfile()) return;

		const baseUrl = typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : '';
		const out = buildProfilesShareUrl({ baseUrl, profiles: [p] });
		if (!out.ok) {
			showNotice(out.reason);
			return;
		}

		await copyToClipboard(out.url);
		showNotice('已复制分享链接（默认脱敏；如过长请改用导出 JSON）');
	}

	function addImportedProfiles(items: Profile[]) {
		if (!items.length) return;

		const existing = new Set(profiles.map((p) => p.name));
		const now = Date.now();

		const incoming: Profile[] = [];
		for (const p of items) {
			const base = normalizeProfileName(p.name);
			let name = base;
			if (existing.has(name)) {
				for (let i = 2; i < 1000; i++) {
					const next = `${base} (${i})`;
					if (!existing.has(next)) {
						name = next;
						break;
					}
				}
				if (existing.has(name)) name = `${base} (${now})`;
			}
			existing.add(name);
			incoming.push({ ...p, name, updatedAt: now });
		}

		profiles = sortProfilesList([...incoming, ...profiles]);
		activeProfileId = incoming[0].id;
		persistProfiles();
	}

	async function handleProfilesImportFileChange() {
		if (streaming) return;
		const file = profilesImportInputEl?.files?.[0];
		if (!file) return;

		try {
			const text = await file.text();
			const res = parseProfilesImport(text, { keepApiKey: true });
			if (!res.ok) {
				error = `导入失败：${res.error}`;
				return;
			}

			addImportedProfiles(res.profiles as any);
			showNotice(`已导入 ${res.profiles.length} 个 Profile`);
		} finally {
			if (profilesImportInputEl) profilesImportInputEl.value = '';
		}
	}

	function importProfilesFromText() {
		if (streaming) return;
		const res = parseProfilesImport(profilesImportText, { keepApiKey: true });
		if (!res.ok) {
			error = `导入失败：${res.error}`;
			return;
		}

		addImportedProfiles(res.profiles as any);
		profilesImportText = '';
		showNotice(`已导入 ${res.profiles.length} 个 Profile`);
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

	function confirmShareDebugReport() {
		return window.confirm(
			`分享调试报告将包含你的提示词/模型输出/请求参数等信息（默认不包含明文 API Key）。\n\n请确认：\n- 只分享给可信对象\n- 不要把链接发到公开渠道\n\n继续吗？`
		);
	}

	async function copyDebugReportJson() {
		if (!debugSession) return;
		const report = createDebugReport(debugSession, { mode: 'full' });
		await copyToClipboard(toDebugReportJson(report));
		showNotice('已复制调试报告 JSON（默认脱敏）。');
	}

	async function copyDebugReportMarkdown() {
		if (!debugSession) return;
		const report = createDebugReport(debugSession, { mode: 'full' });
		await copyToClipboard(toDebugReportMarkdown(report));
		showNotice('已复制调试报告 Markdown（默认脱敏）。');
	}

	function downloadDebugReportJson() {
		if (!debugSession) return;
		const date = new Date().toISOString().slice(0, 10);
		const filename = `debug-report-${date}.json`;
		const report = createDebugReport(debugSession, { mode: 'full' });
		downloadText(filename, toDebugReportJson(report), 'application/json; charset=utf-8');
		showNotice('已下载调试报告 JSON（默认脱敏）。');
	}

	async function copyDebugReportShareLink() {
		if (!debugSession) return;
		if (!confirmShareDebugReport()) return;

		const baseUrl = typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : '';
		const out = buildDebugReportShareUrl({ baseUrl, session: debugSession });
		if (!out.ok) {
			showNotice(out.reason);
			return;
		}

		await copyToClipboard(out.url);
		showNotice('已复制分享链接（摘要版，部分字段可能截断）。');
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
		const copyBtn = target?.closest?.('button[data-copy-code]') as HTMLButtonElement | null;
		const downloadBtn = target?.closest?.('button[data-download-code]') as HTMLButtonElement | null;
		const btn = copyBtn || downloadBtn;
		if (!btn) return;

		const root = btn.closest?.('.md-code') as HTMLElement | null;
		const codeEl = root?.querySelector?.('pre code') as HTMLElement | null;
		const text = codeEl?.textContent ?? '';
		if (!text) return;

		if (downloadBtn) {
			const lang = (root?.querySelector?.('.md-code-lang') as HTMLElement | null)?.textContent?.trim().toLowerCase() ?? '';
			const ext =
				lang === 'js' || lang === 'javascript'
					? 'js'
					: lang === 'ts' || lang === 'typescript'
						? 'ts'
						: lang === 'json'
							? 'json'
							: lang === 'md' || lang === 'markdown'
								? 'md'
								: lang === 'yaml'
									? 'yaml'
									: lang === 'yml'
										? 'yml'
										: lang === 'sql'
											? 'sql'
											: lang === 'bash' || lang === 'sh' || lang === 'shell'
												? 'sh'
												: lang === 'html'
													? 'html'
													: lang === 'xml'
														? 'xml'
														: lang === 'css'
															? 'css'
															: 'txt';

			const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
			const filename = `code-${stamp}.${ext}`;

			downloadBtn.disabled = true;
			const oldText = downloadBtn.textContent ?? '下载';
			downloadText(filename, text, 'text/plain; charset=utf-8');
			downloadBtn.textContent = '已下载';
			setTimeout(() => {
				downloadBtn.textContent = oldText;
				downloadBtn.disabled = false;
			}, 1200);
			return;
		}

		if (!copyBtn) return;

		copyBtn.disabled = true;
		const oldText = copyBtn.textContent ?? '复制';

		void copyToClipboard(text)
			.then(() => {
				copyBtn.textContent = '已复制';
				setTimeout(() => {
					copyBtn.textContent = oldText;
					copyBtn.disabled = false;
				}, 1200);
			})
			.catch(() => {
				copyBtn.textContent = '复制失败';
				setTimeout(() => {
					copyBtn.textContent = oldText;
					copyBtn.disabled = false;
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
		// UI 偏好（主题/字号/密度）：首屏已在 app.html 中抢先应用，这里用于同步到状态并兜底
		try {
			const savedUi = readUiPrefs(localStorage);
			const ui = (savedUi ?? createDefaultUiPrefs()) as StoredUiPrefsV1;
			uiColorScheme = ui.colorScheme;
			uiFontSize = ui.fontSize;
			uiDensity = ui.density;
			applyUiPrefsToRoot(document.documentElement, ui);
		} catch {
			const ui = createDefaultUiPrefs() as StoredUiPrefsV1;
			uiColorScheme = ui.colorScheme;
			uiFontSize = ui.fontSize;
			uiDensity = ui.density;
		}
		uiPrefsHydrated = true;

		let desktopMql: MediaQueryList | null = null;
		let desktopMqlListener: (() => void) | null = null;
		try {
			desktopMql = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT_PX + 1}px)`);
			desktopMqlListener = () => {
				isDesktop = !!desktopMql?.matches;
			};
			desktopMqlListener();
			if (typeof desktopMql.addEventListener === 'function') desktopMql.addEventListener('change', desktopMqlListener);
			else (desktopMql as any).addListener?.(desktopMqlListener);
		} catch {
			isDesktop = isDesktopViewport();
		}

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
			compareMode = saved.common.compareMode;
			compareTargetIds = saved.common.compareTargetIds;
			compareEstimateCost = saved.common.compareEstimateCost;
			for (const [id, pricing] of Object.entries(saved.common.comparePricingById)) {
				setCompareSecret(id, {
					inputUsdPer1M: pricing.inputUsdPer1M,
					outputUsdPer1M: pricing.outputUsdPer1M
				});
			}

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

		// Profiles（localStorage v1）
		try {
			const saved = readProfiles(localStorage);
			profiles = (saved?.items ?? []) as any;
			activeProfileId = typeof saved?.currentId === 'string' ? saved.currentId : '';
		} catch {
			profiles = [];
			activeProfileId = '';
		}
		profilesHydrated = true;

		// Prompt 模板库（localStorage v1）
		try {
			promptTemplates = (readPromptTemplates(localStorage) ?? { v: 1, items: [], favorites: [], recent: [] }) as any;
		} catch {
			promptTemplates = { v: 1, items: [], favorites: [], recent: [] };
		}
		promptTemplatesHydrated = true;

		// 分享链接导入：#debug=...（默认导入为摘要版；导入成功后清理 hash，避免后续误分享/重复导入）
		const imported = typeof location !== 'undefined' ? decodeDebugReportFromHash(location.hash) : null;
		if (imported?.session) {
			debugSession = imported.session as any;
			openDebugPanel();
			showNotice(imported.mode === 'share' ? '已从分享链接导入（摘要版）。' : '已从分享链接导入调试报告。');
			try {
				history.replaceState(null, '', `${location.pathname}${location.search}`);
			} catch {
				// 忽略：部分 WebView 可能不允许
			}
		}

		// 分享链接导入：#profile=... / #profiles=...（默认脱敏；导入成功后清理 hash）
		const importedProfiles = typeof location !== 'undefined' ? decodeProfilesFromHash(location.hash) : null;
		if (importedProfiles?.profiles?.length) {
			addImportedProfiles(importedProfiles.profiles as any);
			openSettingsPanel();
			showNotice(`已从分享链接导入 ${importedProfiles.profiles.length} 个 Profile（默认脱敏）`);
			try {
				history.replaceState(null, '', `${location.pathname}${location.search}`);
			} catch {
				// 忽略：部分 WebView 可能不允许
			}
		}

		return () => {
			window.removeEventListener('resize', handleResize);
			if (desktopMql && desktopMqlListener) {
				if (typeof desktopMql.removeEventListener === 'function') desktopMql.removeEventListener('change', desktopMqlListener);
				else (desktopMql as any).removeListener?.(desktopMqlListener);
			}
		};
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

		// 依赖：仅保存“非敏感设置”，API Key 明确不落盘（compareSecretsById 仅用于提取价格）
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
		compareMode;
		compareTargetIds;
		compareEstimateCost;
		compareSecretsById;

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
					includeUsage,
					compareMode,
					compareTargetIds: normalizeCompareTargetIds(compareTargetIds),
					compareEstimateCost,
					comparePricingById: snapshotComparePricingById()
				}
			});
		}, 250);
	});

	$effect(() => {
		if (!uiPrefsHydrated) return;

		uiColorScheme;
		uiFontSize;
		uiDensity;

		const prefs: StoredUiPrefsV1 = { v: 1, colorScheme: uiColorScheme, fontSize: uiFontSize, density: uiDensity };
		try {
			applyUiPrefsToRoot(document.documentElement, prefs);
		} catch {
			// 忽略：极端环境可能不存在 document
		}

		if (uiSaveTimer) window.clearTimeout(uiSaveTimer);
		uiSaveTimer = window.setTimeout(() => writeUiPrefs(localStorage, prefs), 150);
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

	function startEditMessage(id: string) {
		if (streaming) return;
		const m = messages.find((it) => it.id === id);
		if (!m) return;
		editingMessageId = id;
		editingMessageDraft = m.content ?? '';
	}

	function cancelEditMessage() {
		editingMessageId = null;
		editingMessageDraft = '';
	}

	function push(role: Role, content: string, thinking?: string, usage?: TokenUsage) {
		const id = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
		messages.push({ id, role, content, thinking, usage, at: Date.now() });
		touchCurrentConversation();
	}

	function stop() {
		abortController?.abort();
		for (const c of compareAbortControllers) c?.abort();
	}

	function clearChat() {
		stop();
		messages = [];
		assistantDraft = '';
		assistantThinkingDraft = '';
		streamingUsage = null;
		compareRuns = [];
		thinkingVisibleById = {};
		thinkingOpenById = {};
		streamingThinkingVisible = false;
		streamingThinkingOpen = false;
		cancelEditMessage();
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

	function validateRunPrereqs() {
		if (!baseUrl.trim()) {
			error = '请填写上游 Base URL（必须是 https 域名，可选以 /v1 结尾；不允许 IP/端口/query）。';
			openSettingsPanel();
			return false;
		}
		if (!apiKey.trim()) {
			error = '请填写 API Key（仅保存在浏览器内存，不会写入服务端存储）。';
			openSettingsPanel();
			return false;
		}
		if (!model.trim()) {
			error = '请填写模型名。';
			openSettingsPanel();
			return false;
		}
		return true;
	}

	function snapshotRunFromProfile(p: Profile): ConversationRunSnapshot {
		return {
			provider: p.provider,
			baseUrl: safeString(p.baseUrl, '').trim(),
			model: safeString(p.model, '').trim(),
			systemPrompt: safeString(p.systemPrompt, ''),
			temperature: clamp(Number.isFinite(p.temperature) ? p.temperature : 0.7, 0, 2),
			topP: clamp(Number.isFinite(p.topP) ? p.topP : 1, 0, 1),
			presencePenalty: clamp(Number.isFinite(p.presencePenalty) ? p.presencePenalty : 0, -2, 2),
			frequencyPenalty: clamp(Number.isFinite(p.frequencyPenalty) ? p.frequencyPenalty : 0, -2, 2),
			maxTokens: Math.max(1, Math.floor(Number.isFinite(p.maxTokens) ? p.maxTokens : 1024)),
			anthropicVersion: safeString(p.anthropicVersion, DEFAULTS.anthropic.version ?? '2023-06-01').trim() || '2023-06-01'
		};
	}

	function ensureCompareSecret(id: string): CompareTargetSecret {
		const v = compareSecretsById[id];
		return {
			apiKey: typeof v?.apiKey === 'string' ? v.apiKey : '',
			inputUsdPer1M: Number.isFinite(v?.inputUsdPer1M) ? v.inputUsdPer1M : 0,
			outputUsdPer1M: Number.isFinite(v?.outputUsdPer1M) ? v.outputUsdPer1M : 0
		};
	}

	function setCompareSecret(id: string, patch: Partial<CompareTargetSecret>) {
		const prev = ensureCompareSecret(id);
		compareSecretsById = { ...compareSecretsById, [id]: { ...prev, ...patch } };
	}

	function snapshotComparePricingById(): Record<string, CompareTargetPricing> {
		const out: Record<string, CompareTargetPricing> = {};
		for (const [id, v] of Object.entries(compareSecretsById)) {
			const inputUsdPer1M = Number.isFinite(v?.inputUsdPer1M) ? Math.max(0, v.inputUsdPer1M) : 0;
			const outputUsdPer1M = Number.isFinite(v?.outputUsdPer1M) ? Math.max(0, v.outputUsdPer1M) : 0;
			if (inputUsdPer1M <= 0 && outputUsdPer1M <= 0) continue;
			out[id] = { inputUsdPer1M, outputUsdPer1M };
		}
		return out;
	}

	function buildUpstreamRequestForRun(
		run: ConversationRunSnapshot,
		chatMessages: ChatMessage[],
		includeUsageFlag: boolean,
		didRetryWithoutUsage: boolean
	) {
		const trimmedModel = safeString(run.model, '').trim();
		const max_tokens = Math.max(1, Math.floor(Number.isFinite(run.maxTokens) ? run.maxTokens : 1024));

		if (run.provider === 'openai') {
			const normalizedOpenAiTemperature = clamp(Number.isFinite(run.temperature) ? run.temperature : 0.7, 0, 2);
			const normalizedOpenAiTopP = clamp(Number.isFinite(run.topP) ? run.topP : 1, 0, 1);
			const normalizedOpenAiPresencePenalty = clamp(Number.isFinite(run.presencePenalty) ? run.presencePenalty : 0, -2, 2);
			const normalizedOpenAiFrequencyPenalty = clamp(
				Number.isFinite(run.frequencyPenalty) ? run.frequencyPenalty : 0,
				-2,
				2
			);

			const sys = safeString(run.systemPrompt, '').trim();

			return {
				model: trimmedModel,
				messages: [...(sys ? [{ role: 'system', content: sys }] : []), ...chatMessages.map((m) => ({ role: m.role, content: m.content }))],
				temperature: normalizedOpenAiTemperature,
				top_p: normalizedOpenAiTopP !== 1 ? normalizedOpenAiTopP : undefined,
				presence_penalty: normalizedOpenAiPresencePenalty !== 0 ? normalizedOpenAiPresencePenalty : undefined,
				frequency_penalty: normalizedOpenAiFrequencyPenalty !== 0 ? normalizedOpenAiFrequencyPenalty : undefined,
				max_tokens,
				stream_options: includeUsageFlag && !didRetryWithoutUsage ? { include_usage: true } : undefined,
				stream: true
			};
		}

		const sys = safeString(run.systemPrompt, '').trim();
		return {
			model: trimmedModel,
			system: sys ? sys : undefined,
			messages: chatMessages.map((m) => ({ role: m.role, content: [{ type: 'text', text: m.content }] })),
			max_tokens,
			stream: true
		};
	}

	function buildCompareTargets() {
		const ids = normalizeCompareTargetIds(compareTargetIds);
		const targets: Array<{ id: string; name: string; run: ConversationRunSnapshot; apiKey: string }> = [];

		for (const id of ids) {
			if (id === COMPARE_CURRENT_TARGET_ID) {
				const secret = ensureCompareSecret(id);
				const key = (secret.apiKey || apiKey || '').trim();
				targets.push({ id, name: '当前设置', run: snapshotCurrentProfileFields(), apiKey: key });
				continue;
			}

			const p = profiles.find((it) => it.id === id);
			if (!p) continue;
			const secret = ensureCompareSecret(id);
			const key = (secret.apiKey || '').trim();
			targets.push({ id, name: p.name || '未命名 Profile', run: snapshotRunFromProfile(p), apiKey: key });
		}

		return targets;
	}

	function validateComparePrereqs() {
		const targets = buildCompareTargets();
		if (targets.length < 2) {
			error = '对比模式至少需要选择 2 个目标（可包含“当前设置”与 Profiles）。';
			openSettingsPanel();
			return false;
		}

		for (const t of targets) {
			if (!t.run.baseUrl.trim()) {
				error = `对比目标「${t.name}」缺少 Base URL。`;
				openSettingsPanel();
				return false;
			}
			if (!t.apiKey.trim()) {
				error = `对比目标「${t.name}」缺少 API Key（仅保存在内存，不会落盘）。`;
				openSettingsPanel();
				return false;
			}
			if (!t.run.model.trim()) {
				error = `对比目标「${t.name}」缺少模型名（model）。`;
				openSettingsPanel();
				return false;
			}
		}

		return true;
	}

	async function runCompare() {
		notice = null;
		error = null;
		lastEvent = null;

		if (streaming) return;
		if (!validateComparePrereqs()) return;

		// 对比模式：不写入 debugSession（避免与单模型请求混淆）
		debugSession = null;

		const targets = buildCompareTargets();

		compareRuns = targets.map((t) => ({
			id: t.id,
			name: t.name,
			provider: t.run.provider,
			baseUrl: t.run.baseUrl,
			model: t.run.model,
			run: t.run,
			status: 'idle',
			startedAt: 0,
			firstEventAt: null,
			endedAt: null,
			error: null,
			content: '',
			thinking: '',
			usage: null,
			didRetryWithoutUsage: false
		}));

		streaming = true;
		compareAbortControllers = targets.map(() => new AbortController());

		try {
			await Promise.allSettled(
				targets.map(async (t, idx) => {
					const runState = compareRuns[idx];
					if (!runState) return;

					let didRetryWithoutUsage = false;

					while (true) {
						runState.status = 'running';
						runState.startedAt = Date.now();
						runState.firstEventAt = null;
						runState.endedAt = null;
						runState.error = null;
						runState.content = '';
						runState.thinking = '';
						runState.usage = null;

						const thoughtSplitterLocal = createThoughtChainSplitter();
						thoughtSplitterLocal.reset();
						const anthropicCtxLocal = createAnthropicSseContext();

						const request = buildUpstreamRequestForRun(t.run, messages, includeUsage, didRetryWithoutUsage);
						const proxyPayloadBase = {
							provider: t.run.provider,
							baseUrl: t.run.baseUrl,
							anthropicVersion: t.run.provider === 'anthropic' ? t.run.anthropicVersion.trim() : undefined,
							request
						};
						const proxyPayload = { ...proxyPayloadBase, apiKey: t.apiKey };

						let retryWithoutUsage = false;
						let hadUpstreamError = false;

						try {
							const res = await fetch('/api/chat', {
								method: 'POST',
								headers: { 'content-type': 'application/json' },
								body: JSON.stringify(proxyPayload),
								signal: compareAbortControllers[idx]?.signal
							});

							if (!res.ok) {
								const text = await res.text().catch(() => '');
								runState.error = `代理请求失败（HTTP ${res.status}）${text ? `：${text}` : ''}`;
								runState.status = 'error';
								runState.endedAt = Date.now();
								return;
							}

							await streamSse(
								res,
								(event) => {
									if (!runState.firstEventAt) runState.firstEventAt = Date.now();

									const proxyErr = parseProxyErrorEvent(event);
									if (proxyErr) {
										if (
											t.run.provider === 'openai' &&
											includeUsage &&
											!didRetryWithoutUsage &&
											proxyErr.status === 400 &&
											looksLikeUsageUnsupportedError(proxyErr)
										) {
											retryWithoutUsage = true;
											return false;
										}

										runState.error = proxyErr.status
											? `上游错误（HTTP ${proxyErr.status}）：${proxyErr.message}`
											: proxyErr.message;
										runState.status = 'error';
										hadUpstreamError = true;
										return false;
									}

									if (t.run.provider === 'openai') {
										const { done, contentDelta, thinkingDelta, usage } = parseOpenAiSseData(event.data);
										if (usage) runState.usage = mergeTokenUsage(runState.usage, usage);
										if (done) return false;

										if (typeof thinkingDelta === 'string' && thinkingDelta) runState.thinking += thinkingDelta;

										if (typeof contentDelta === 'string' && contentDelta) {
											const out = thoughtSplitterLocal.push(contentDelta);
											if (out.contentDelta) runState.content += out.contentDelta;
											if (out.thinkingDelta) runState.thinking += out.thinkingDelta;
										}

										return true;
									}

									const { contentDelta, thinkingDelta, usage } = parseAnthropicSseEvent(event, anthropicCtxLocal);
									if (usage) runState.usage = mergeTokenUsage(runState.usage, usage);
									if (typeof thinkingDelta === 'string' && thinkingDelta) runState.thinking += thinkingDelta;
									if (typeof contentDelta === 'string' && contentDelta) {
										const out = thoughtSplitterLocal.push(contentDelta);
										if (out.contentDelta) runState.content += out.contentDelta;
										if (out.thinkingDelta) runState.thinking += out.thinkingDelta;
									}
									return true;
								},
								{ signal: compareAbortControllers[idx]?.signal }
							);
						} catch (e) {
							if (compareAbortControllers[idx]?.signal.aborted) {
								runState.status = 'aborted';
								runState.error = null;
							} else {
								runState.status = 'error';
								runState.error = e instanceof Error ? e.message : String(e);
							}
							runState.endedAt = Date.now();
							return;
						} finally {
							// flush 残留 tag 切分
							try {
								const flushed = thoughtSplitterLocal.flush();
								if (flushed.contentDelta) runState.content += flushed.contentDelta;
								if (flushed.thinkingDelta) runState.thinking += flushed.thinkingDelta;
							} catch {
								// ignore
							}
						}

						if (retryWithoutUsage) {
							didRetryWithoutUsage = true;
							runState.didRetryWithoutUsage = true;
							continue;
						}

						if (compareAbortControllers[idx]?.signal.aborted) {
							runState.status = 'aborted';
							runState.endedAt = Date.now();
							return;
						}

						runState.status = hadUpstreamError ? 'error' : 'done';
						runState.endedAt = Date.now();
						break;
					}
				})
			);
	} finally {
			streaming = false;
			abortController = null;
			compareAbortControllers = [];
		}
	}

	function isCompareTargetSelected(id: string) {
		return normalizeCompareTargetIds(compareTargetIds).includes(id);
	}

	function toggleCompareTarget(id: string, checked: boolean) {
		const current = normalizeCompareTargetIds(compareTargetIds);
		if (checked) {
			if (current.includes(id)) return;
			if (current.length >= COMPARE_MAX_TARGETS) {
				showNotice(`最多只能选择 ${COMPARE_MAX_TARGETS} 个对比目标`);
				return;
			}
			compareTargetIds = normalizeCompareTargetIds([...current, id]);
			return;
		}

		compareTargetIds = normalizeCompareTargetIds(current.filter((it) => it !== id));
	}

	function clearCompareResults() {
		compareRuns = [];
	}

	async function copyCompareRun(id: string) {
		const run = compareRuns.find((r) => r.id === id);
		if (!run) return;
		const text = safeString(run.content, '').trim();
		if (!text) {
			showNotice('该列正文为空，无法复制');
			return;
		}
		await copyToClipboard(text);
		showNotice('已复制');
	}

	function adoptCompareRun(id: string) {
		if (streaming) return;
		const run = compareRuns.find((r) => r.id === id);
		if (!run) return;

		const content = safeString(run.content, '').trim();
		const thinking = safeString(run.thinking, '').trim();
		if (!content && !thinking) {
			showNotice('该列无可采用内容');
			return;
		}

		currentConversationRun = run.run;
		push('assistant', content, thinking || undefined, run.usage ?? undefined);
		showNotice(`已采用「${run.name}」的回复`);
		stickToBottom = true;
		void scrollMessagesToBottom();
	}

	function fmtCompareStatus(status: CompareRunStatus) {
		if (status === 'running') return '进行中';
		if (status === 'done') return '完成';
		if (status === 'aborted') return '已停止';
		if (status === 'error') return '错误';
		return '待命';
	}

	function getCompareTtfbMs(run: CompareRun): number | null {
		if (!Number.isFinite(run.startedAt) || !run.startedAt) return null;
		if (!Number.isFinite(run.firstEventAt ?? NaN) || !run.firstEventAt) return null;
		return Math.max(0, run.firstEventAt - run.startedAt);
	}

	function getCompareDurationMs(run: CompareRun): number | null {
		if (!Number.isFinite(run.startedAt) || !run.startedAt) return null;
		if (!Number.isFinite(run.endedAt ?? NaN) || !run.endedAt) return null;
		return Math.max(0, run.endedAt - run.startedAt);
	}

	function getCompareCostUsd(run: CompareRun): number | null {
		if (!compareEstimateCost) return null;
		return estimateUsdCost(run.usage, ensureCompareSecret(run.id));
	}

	async function runAssistant() {
		notice = null;
		error = null;
		lastEvent = null;

		if (streaming) return;
		if (!validateRunPrereqs()) return;

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
				const request = buildUpstreamRequestForRun(
					currentConversationRun ?? snapshotCurrentProfileFields(),
					messages,
					includeUsage,
					didRetryWithoutUsage
				);

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

	function isLastAssistantMessage(id: string) {
		if (!id) return false;
		const idx = messages.findIndex((m) => m.id === id);
		if (idx < 0) return false;
		return idx === messages.length - 1 && messages[idx]?.role === 'assistant';
	}

	async function rerunFromMessage(messageId: string, editedContent?: string) {
		if (streaming) return;
		const out = buildForkForRerun(messages, messageId, editedContent);
		if (!out.ok) {
			showNotice(out.reason);
			return;
		}

		forkConversationFromMessages(out.forkMessages, '重跑');
		cancelEditMessage();

		if (out.shouldAutoRun) {
			await runAssistant();
			return;
		}

		showNotice('已分叉到此处，可继续提问。');
		await tick();
		promptTextareaEl?.focus();
	}

	async function retryAssistantMessage(messageId: string) {
		if (streaming) return;
		const out = buildForkForRetry(messages, messageId);
		if (!out.ok) {
			showNotice(out.reason);
			return;
		}

		forkConversationFromMessages(out.forkMessages, '重试');
		cancelEditMessage();

		if (out.shouldAutoRun) await runAssistant();
	}

	async function continueLastAssistant() {
		if (streaming) return;
		const last = messages[messages.length - 1];
		if (!last || last.role !== 'assistant') return;
		if (!validateRunPrereqs()) return;
		stickToBottom = true;
		push('user', '请继续');
		await runAssistant();
	}

	async function send() {
		notice = null;
		error = null;
		lastEvent = null;

		if (streaming) return;
		const text = prompt.trim();
		if (!text) return;
		if (compareMode) {
			if (!validateComparePrereqs()) return;
		} else {
			if (!validateRunPrereqs()) return;
		}

		stickToBottom = true;
		push('user', text);
		prompt = '';
		if (compareMode) await runCompare();
		else await runAssistant();
	}
</script>

<svelte:window
	onkeydown={handleGlobalKeydown}
	onpointerdown={handleGlobalPointerDown}
	onpointermove={handleGlobalPointerMove}
	onpointerup={handleGlobalPointerUp}
	onpointercancel={handleGlobalPointerCancel}
/>

<div class="container">
	<a class="skip-link" href="#prompt">跳到输入框</a>
	<div class="grid" style={`--left-sidebar-width: ${leftSidebarWidth}px; --right-sidebar-width: ${rightSidebarWidth}px;`}>
		<aside
			id="conversationsPanel"
			class="conversations-panel"
			class:open={conversationsOpen}
			bind:this={conversationsPanelEl}
			tabindex="-1"
			role={!isDesktop ? 'dialog' : undefined}
			aria-modal={!isDesktop ? 'true' : undefined}
			aria-labelledby="conversationsPanelTitle"
			aria-hidden={!isDesktop && !conversationsOpen ? 'true' : undefined}
		>
			<div class="panel-header">
				<h2 id="conversationsPanelTitle">会话</h2>
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
						bind:this={convSearchEl}
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
			role="slider"
			aria-label="调整会话栏宽度"
			aria-orientation="vertical"
			aria-valuemin={LEFT_SIDEBAR_MIN_PX}
			aria-valuemax={LEFT_SIDEBAR_MAX_PX}
			aria-valuenow={leftSidebarWidth}
			tabindex="0"
			title="拖拽调整宽度"
			onpointerdown={(e) => startSidebarResize('left', e)}
			onkeydown={(e) => handleSidebarSeparatorKeydown('left', e)}
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
					<button
						class="btn btn-sm conversations-toggle"
						type="button"
						onclick={openConversationsPanel}
						aria-controls="conversationsPanel"
						aria-expanded={!isDesktop && conversationsOpen}
						aria-haspopup="dialog"
					>
						会话
					</button>
					<button
						class="btn btn-sm settings-toggle"
						type="button"
						onclick={openSettingsPanel}
						aria-controls="settingsPanel"
						aria-expanded={!isDesktop && settingsOpen}
						aria-haspopup="dialog"
					>
						设置
					</button>
				</div>
			</div>

			<div class="messages" bind:this={messagesEl} onscroll={syncStickToBottom} use:delegateCopy>
				{#if notice}
					<div class="notice" role="status" aria-live="polite">{notice}</div>
				{/if}
				{#if error}
					<div class="error" role="alert">{error}</div>
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

								<span class="meta-spacer"></span>

								{#if editingMessageId === m.id}
									<button class="meta-pill" type="button" onclick={cancelEditMessage} disabled={streaming}>取消</button>
									<button
										class="meta-pill"
										type="button"
										onclick={() => rerunFromMessage(m.id, editingMessageDraft)}
										disabled={streaming}
									>
										从此处重跑
									</button>
								{:else}
									<button class="meta-pill" type="button" onclick={() => startEditMessage(m.id)} disabled={streaming}>编辑</button>

									{#if m.role === 'user'}
										<button class="meta-pill" type="button" onclick={() => rerunFromMessage(m.id)} disabled={streaming}>
											从此处重跑
										</button>
									{:else}
										<button class="meta-pill" type="button" onclick={() => retryAssistantMessage(m.id)} disabled={streaming}>重试</button>
										{#if isLastAssistantMessage(m.id)}
											<button class="meta-pill" type="button" onclick={continueLastAssistant} disabled={streaming}>续写</button>
										{/if}
									{/if}
								{/if}
							</div>

							{#if editingMessageId === m.id}
								<div class="msg-edit">
									<textarea
										bind:value={editingMessageDraft}
										rows="6"
										disabled={streaming}
										autocapitalize="off"
										autocomplete="off"
										spellcheck="false"
									></textarea>
									<div class="muted msg-edit-hint">提示：编辑完成后点击上方“从此处重跑”会创建分叉会话。</div>
								</div>
							{:else}
								{#if m.content.trim()}
									<div class="md">{@html renderMarkdownToHtml(m.content)}</div>
								{:else}
									<div class="empty-content muted">（正文为空）</div>
								{/if}
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

				{#if compareMode && compareRuns.length}
					<div class="compare-area">
						<div class="compare-head">
							<div class="compare-head-left">
								<strong>对比结果</strong>
								<span class="muted">{compareRuns.length} 个目标</span>
							</div>
							<div class="compare-head-actions">
								<button class="btn btn-sm danger" type="button" onclick={stop} disabled={!streaming}>停止</button>
								<button class="btn btn-sm" type="button" onclick={clearCompareResults} disabled={streaming}>清空</button>
							</div>
						</div>

						<div class="compare-summary">
							<div class="compare-summary-row compare-summary-header">
								<span class="muted">目标</span>
								<span class="muted">TTFB</span>
								<span class="muted">总耗时</span>
								<span class="muted">Tokens</span>
								<span class="muted">Cost</span>
							</div>
							{#each compareRuns as r (r.id)}
								<div class="compare-summary-row">
									<div class="compare-summary-name">
										<span class="mono">{r.name}</span>
										<span class="muted mono">{r.model}</span>
										<span class="pill">{r.provider === 'openai' ? 'OpenAI' : 'Anthropic'}</span>
										<span class="pill">{fmtCompareStatus(r.status)}</span>
									</div>
									<span>{getCompareTtfbMs(r) == null ? '—' : fmtMs(getCompareTtfbMs(r)!)}</span>
									<span>{getCompareDurationMs(r) == null ? (r.status === 'running' ? '进行中' : '—') : fmtMs(getCompareDurationMs(r)!)}</span>
									<span class="muted">{formatTokenUsage(r.usage) ?? '—'}</span>
									<span class:muted={!compareEstimateCost}>{formatUsd(getCompareCostUsd(r))}</span>
								</div>
							{/each}
						</div>

						<div class="compare-grid">
							{#each compareRuns as r (r.id)}
								<div class="compare-card">
									<div class="compare-card-head">
										<div class="compare-card-title">
											<strong class="mono">{r.name}</strong>
											<span class="muted mono">{r.model}</span>
										</div>
										<div class="compare-card-actions">
											<button class="btn btn-sm" type="button" onclick={() => copyCompareRun(r.id)} disabled={!r.content.trim()}>
												复制
											</button>
											<button
												class="btn btn-sm"
												type="button"
												onclick={() => adoptCompareRun(r.id)}
												disabled={streaming || (!r.content.trim() && !r.thinking.trim())}
											>
												采用
											</button>
										</div>
									</div>

									{#if r.error}
										<div class="compare-run-error">{r.error}</div>
									{/if}

									{#if r.status === 'running'}
										<pre>{r.content}</pre>
									{:else}
										{#if r.content.trim()}
											<div class="md">{@html renderMarkdownToHtml(r.content)}</div>
										{:else}
											<div class="empty-content muted">（正文为空）</div>
										{/if}
									{/if}

									{#if showThinking && r.thinking.trim()}
										<details class="compare-thinking" open={thinkingAutoExpand}>
											<summary>思维链</summary>
											<pre>{r.thinking}</pre>
										</details>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/if}

				{#if streaming && !compareMode}
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

								<span class="meta-spacer"></span>
								<button class="meta-pill" type="button" onclick={stop}>停止</button>
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
						bind:this={promptTextareaEl}
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
						<button
							class="btn-icon btn-icon-secondary"
							type="button"
							onclick={openPromptTemplatesModal}
							disabled={streaming}
							aria-label="模板库"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="20"
								height="20"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
								<polyline points="14 2 14 8 20 8" />
								<line x1="16" y1="13" x2="8" y2="13" />
								<line x1="16" y1="17" x2="8" y2="17" />
								<line x1="10" y1="9" x2="8" y2="9" />
							</svg>
						</button>
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
			role="slider"
			aria-label="调整设置栏宽度"
			aria-orientation="vertical"
			aria-valuemin={RIGHT_SIDEBAR_MIN_PX}
			aria-valuemax={RIGHT_SIDEBAR_MAX_PX}
			aria-valuenow={rightSidebarWidth}
			tabindex="0"
			title="拖拽调整宽度"
			onpointerdown={(e) => startSidebarResize('right', e)}
			onkeydown={(e) => handleSidebarSeparatorKeydown('right', e)}
		></div>

		{#if settingsOpen || conversationsOpen}
			<button class="settings-overlay" type="button" aria-label="关闭面板" onclick={closePanels}></button>
		{/if}

			<aside
				id="settingsPanel"
				class="settings-panel"
				class:open={settingsOpen}
				bind:this={settingsPanelEl}
				tabindex="-1"
				role={!isDesktop ? 'dialog' : undefined}
				aria-modal={!isDesktop ? 'true' : undefined}
				aria-labelledby="settingsPanelTitle"
				aria-hidden={!isDesktop && !settingsOpen ? 'true' : undefined}
			>
				<div class="panel-header">
					<h2 id="settingsPanelTitle">{rightPanelTab === 'settings' ? '运行设置' : '调试面板'}</h2>
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
						<div class="label-row">
							<span class="muted">Profiles</span>
							<span class="muted">{profiles.length ? `${profiles.length} 个` : '暂无'}</span>
						</div>

						{#if profiles.length === 0}
							<div class="muted">暂无 Profile。可先配置右侧参数，然后点击下方“保存”创建。</div>
						{:else}
							<div class="profile-list">
								{#each profiles as p (p.id)}
									<div class="profile-item" class:active={p.id === activeProfileId}>
										<button class="profile-select" type="button" onclick={() => applyProfile(p.id)} disabled={streaming}>
											<div class="profile-title-row">
												<span class="profile-title">{p.name}</span>
												<span class="profile-time mono">{p.provider === 'openai' ? 'OpenAI' : 'Anthropic'}</span>
											</div>
											<div class="profile-meta">
												{p.model || '（未设置模型）'}{p.baseUrl ? ` · ${p.baseUrl}` : ''}
											</div>
										</button>

										{#if p.id === activeProfileId}
											<div class="profile-actions-row">
												<button class="btn btn-sm" type="button" onclick={() => updateProfileFromCurrent(p.id)} disabled={streaming}>
													用当前覆盖
												</button>
												<button class="btn btn-sm" type="button" onclick={() => renameProfile(p.id)}>重命名</button>
												<button class="btn btn-sm" type="button" onclick={() => exportProfileJson(p.id)}>导出</button>
												<button class="btn btn-sm" type="button" onclick={() => copyProfileJson(p.id)}>复制 JSON</button>
												<button class="btn btn-sm" type="button" onclick={() => copyProfileShareLink(p.id)}>分享链接</button>
												<button class="btn btn-sm danger" type="button" onclick={() => deleteProfile(p.id)}>删除</button>
											</div>
										{/if}
									</div>
								{/each}
							</div>
						{/if}

						<div class="field">
							<label for="newProfileName">保存当前为新 Profile</label>
							<div class="profile-create-row">
								<input
									id="newProfileName"
									bind:value={newProfileName}
									placeholder="例如：OpenAI:gpt-4o-mini"
									disabled={streaming}
									autocapitalize="off"
									autocomplete="off"
									spellcheck="false"
								/>
								<button class="btn" type="button" onclick={createProfileFromCurrent} disabled={streaming}>保存</button>
							</div>
						</div>

						<div class="field">
							<label for="profilesImportFile">导入 / 导出</label>
							<div class="debug-actions">
								<button class="btn btn-sm" type="button" onclick={exportAllProfilesJson} disabled={profiles.length === 0}>
									导出全部
								</button>
								<button class="btn btn-sm" type="button" onclick={copyAllProfilesJson} disabled={profiles.length === 0}>
									复制全部 JSON
								</button>
								<button class="btn btn-sm" type="button" onclick={copyAllProfilesShareLink} disabled={profiles.length === 0}>
									分享全部
								</button>
								<button class="btn btn-sm" type="button" onclick={() => profilesImportInputEl?.click()} disabled={streaming}>
									导入文件
								</button>
							</div>

							<details class="profiles-details">
								<summary>粘贴导入</summary>
								<div class="field">
									<textarea
										bind:value={profilesImportText}
										rows="6"
										placeholder="粘贴 Profiles JSON（默认不含 API Key）"
										disabled={streaming}
									></textarea>
								</div>
								<div class="debug-actions">
									<button
										class="btn btn-sm"
										type="button"
										onclick={importProfilesFromText}
										disabled={streaming || !profilesImportText.trim()}
									>
										导入
									</button>
									<button class="btn btn-sm" type="button" onclick={() => (profilesImportText = '')} disabled={!profilesImportText.trim()}>
										清空
									</button>
								</div>
							</details>

							<input
								id="profilesImportFile"
								class="file-input"
								type="file"
								accept="application/json"
								bind:this={profilesImportInputEl}
								onchange={handleProfilesImportFileChange}
							/>
						</div>

						<div class="muted">提示：导出/分享默认不包含明文 API Key；Profile 可能包含 system prompt 等敏感信息，请谨慎分享。</div>
					</div>

					<div class="field-group">
						<div class="field">
							<label for="uiColorScheme">主题</label>
							<select id="uiColorScheme" bind:value={uiColorScheme}>
								<option value="system">跟随系统</option>
								<option value="light">浅色</option>
								<option value="dark">深色</option>
							</select>
						</div>

						<div class="field">
							<label for="uiFontSize">字号</label>
							<select id="uiFontSize" bind:value={uiFontSize}>
								<option value="sm">小</option>
								<option value="md">中</option>
								<option value="lg">大</option>
							</select>
						</div>

						<div class="field">
							<label for="uiDensity">密度</label>
							<select id="uiDensity" bind:value={uiDensity}>
								<option value="compact">紧凑</option>
								<option value="comfortable">舒适</option>
								<option value="spacious">宽松</option>
							</select>
						</div>

						<div class="muted">说明：主题支持跟随系统；字号与密度仅影响本地显示，不会影响 API 请求。</div>
					</div>
					<div class="field-group">
						<div class="field">
							<label for="provider">提供方</label>
							<select
								id="provider"
								bind:this={providerSelectEl}
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
						<label for="compareMode">对比模式</label>
						<label class="checkbox">
							<input id="compareMode" type="checkbox" bind:checked={compareMode} disabled={streaming} />
							<span>同一输入并行跑多个目标（Profiles / 当前设置）</span>
						</label>
					</div>

					{#if compareMode}
						<div class="field">
							<div class="label-row">
								<span class="muted">对比目标</span>
								<span class="muted">{normalizeCompareTargetIds(compareTargetIds).length}/{COMPARE_MAX_TARGETS}</span>
							</div>

							<div class="compare-targets">
								<label class="checkbox compare-target">
									<input
										type="checkbox"
										checked={isCompareTargetSelected(COMPARE_CURRENT_TARGET_ID)}
										onchange={(e) =>
											toggleCompareTarget(COMPARE_CURRENT_TARGET_ID, (e.currentTarget as HTMLInputElement).checked)}
										disabled={streaming}
									/>
									<span>当前设置</span>
								</label>

								{#each profiles as p (p.id)}
									<label class="checkbox compare-target">
										<input
											type="checkbox"
											checked={isCompareTargetSelected(p.id)}
											onchange={(e) => toggleCompareTarget(p.id, (e.currentTarget as HTMLInputElement).checked)}
											disabled={streaming}
										/>
										<span class="compare-target-name">{p.name}</span>
										<span class="muted mono">{p.provider === 'openai' ? 'OpenAI' : 'Anthropic'}</span>
									</label>
								{/each}
							</div>

							<div class="muted">提示：至少选择 2 个目标；API Key 不会落盘。</div>
						</div>

						<div class="field">
							<label class="checkbox">
								<input type="checkbox" bind:checked={compareEstimateCost} disabled={streaming} />
								<span>估算成本（按输入/输出 $/1M tokens）</span>
							</label>
						</div>

						<div class="compare-secrets">
							{#each buildCompareTargets() as t (t.id)}
								<details class="compare-secret">
									<summary>
										<span class="mono">{t.name}</span>
										<span class="muted">{t.run.provider === 'openai' ? 'OpenAI' : 'Anthropic'}</span>
									</summary>

									<div class="field">
										<label for={"compare-key-" + t.id}>API Key</label>
										<input
											id={"compare-key-" + t.id}
											type="password"
											value={ensureCompareSecret(t.id).apiKey}
											placeholder={t.id === COMPARE_CURRENT_TARGET_ID ? '留空则使用上方 API Key' : 'sk-...'}
											disabled={streaming}
											autocapitalize="off"
											autocomplete="off"
											spellcheck="false"
											oninput={(e) => setCompareSecret(t.id, { apiKey: (e.currentTarget as HTMLInputElement).value })}
										/>
									</div>

									{#if compareEstimateCost}
										<div class="compare-price-grid">
											<div class="field">
												<label for={"compare-in-" + t.id}>输入 $/1M</label>
												<input
													id={"compare-in-" + t.id}
													type="number"
													min="0"
													step="0.01"
													value={ensureCompareSecret(t.id).inputUsdPer1M}
													disabled={streaming}
													oninput={(e) =>
														setCompareSecret(t.id, {
															inputUsdPer1M: Number((e.currentTarget as HTMLInputElement).value)
														})}
												/>
											</div>
											<div class="field">
												<label for={"compare-out-" + t.id}>输出 $/1M</label>
												<input
													id={"compare-out-" + t.id}
													type="number"
													min="0"
													step="0.01"
													value={ensureCompareSecret(t.id).outputUsdPer1M}
													disabled={streaming}
													oninput={(e) =>
														setCompareSecret(t.id, {
															outputUsdPer1M: Number((e.currentTarget as HTMLInputElement).value)
														})}
												/>
											</div>
										</div>
									{/if}
								</details>
							{/each}
						</div>
					{/if}
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
										<button class="btn btn-sm" type="button" onclick={copyDebugReportJson}>报告 JSON</button>
										<button class="btn btn-sm" type="button" onclick={copyDebugReportMarkdown}>报告 MD</button>
										<button class="btn btn-sm" type="button" onclick={copyDebugReportShareLink}>分享链接</button>
										<button class="btn btn-sm" type="button" onclick={downloadDebugReportJson}>下载 JSON</button>
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

	{#if promptTemplatesOpen}
		<button class="modal-overlay" type="button" aria-label="关闭模板库" onclick={closePromptTemplatesModal}></button>
		<div class="modal" role="dialog" aria-modal="true" aria-label="Prompt 模板库" bind:this={promptTemplatesModalEl} tabindex="-1">
			<div class="modal-header">
				<h3>Prompt 模板库</h3>
				<div class="modal-header-actions">
					<button class="btn btn-sm" type="button" onclick={createUserTemplate} disabled={streaming}>新建</button>
					<button class="btn btn-sm" type="button" onclick={closePromptTemplatesModal}>关闭</button>
				</div>
			</div>
			<div class="panel-tabs modal-tabs">
				<button class="tab" type="button" class:active={promptTemplatesTab === 'all'} onclick={() => (promptTemplatesTab = 'all')}>全部</button>
				<button
					class="tab"
					type="button"
					class:active={promptTemplatesTab === 'favorites'}
					onclick={() => (promptTemplatesTab = 'favorites')}
				>
					收藏
				</button>
				<button class="tab" type="button" class:active={promptTemplatesTab === 'recent'} onclick={() => (promptTemplatesTab = 'recent')}>
					最近
				</button>
			</div>
			<div class="modal-body tmpl-modal-body">
				<div class="tmpl-col tmpl-list-col">
					<div class="field">
						<label for="tmplSearch">搜索</label>
						<input
							id="tmplSearch"
							bind:this={tmplSearchEl}
							bind:value={promptTemplatesQuery}
							placeholder="按标题/内容搜索"
							autocapitalize="off"
							autocomplete="off"
							spellcheck="false"
						/>
					</div>

					<div class="tmpl-list">
						{#each getVisiblePromptTemplates() as t (t.id)}
							<div class="tmpl-item" class:active={t.id === selectedTemplateId}>
								<button class="tmpl-select" type="button" onclick={() => selectPromptTemplate(t.id)}>
									<div class="tmpl-title-row">
										<span class="tmpl-title">{t.title}</span>
										{#if t.builtin}
											<span class="pill">内置</span>
										{/if}
									</div>
									<div class="tmpl-snippet muted">{truncateText(t.content, 70)}</div>
								</button>
								<button class="tmpl-star" type="button" onclick={() => toggleTemplateFavorite(t.id)} aria-label="收藏/取消收藏">
									{isPromptTemplateFavorite(t.id) ? '★' : '☆'}
								</button>
							</div>
						{/each}

						{#if getVisiblePromptTemplates().length === 0}
							<div class="muted">暂无匹配模板</div>
						{/if}
					</div>
				</div>

				<div class="tmpl-col tmpl-detail-col">
					{#if getPromptTemplateById(selectedTemplateId)}
						<div class="tmpl-detail-head">
							<div class="tmpl-detail-title-row">
								<input bind:value={templateDraftTitle} disabled={getPromptTemplateById(selectedTemplateId)?.builtin} />
								<button
									class="btn btn-sm"
									type="button"
									onclick={() => toggleTemplateFavorite(selectedTemplateId)}
									disabled={!selectedTemplateId}
								>
									{isPromptTemplateFavorite(selectedTemplateId) ? '已收藏' : '收藏'}
								</button>
							</div>
							<div class="tmpl-detail-meta muted">
								{getPromptTemplateById(selectedTemplateId)?.builtin ? '内置模板（只读）' : '自定义模板'}
							</div>
						</div>

						<div class="field">
							<label for="tmplContent">内容</label>
							<textarea
								id="tmplContent"
								bind:value={templateDraftContent}
								rows="10"
								disabled={getPromptTemplateById(selectedTemplateId)?.builtin}
								placeholder={"输入模板内容，可使用 {topic} 等占位符"}
							></textarea>
						</div>

						{#if !getPromptTemplateById(selectedTemplateId)?.builtin}
							<div class="tmpl-detail-actions">
								<button class="btn btn-sm" type="button" onclick={saveSelectedUserTemplate} disabled={streaming}>保存</button>
								<button class="btn btn-sm danger" type="button" onclick={deleteSelectedUserTemplate} disabled={streaming}>删除</button>
							</div>
						{/if}

						<div class="tmpl-vars">
							<div class="label-row">
								<span class="muted">变量</span>
								<label class="checkbox">
									<input type="checkbox" bind:checked={keepUnfilledPlaceholders} />
									<span class="muted">未填写保留占位符</span>
								</label>
							</div>

							{#if parseTemplateVariables(templateDraftContent).length}
								<div class="tmpl-vars-grid">
									{#each parseTemplateVariables(templateDraftContent) as v (v)}
										<div class="field">
											<label for={"var-" + v}>{v}</label>
											<input
												id={"var-" + v}
												value={templateVarValues[v] ?? ''}
												placeholder={`填写 ${v}`}
												oninput={(e) => {
													const target = e.currentTarget as HTMLInputElement;
													templateVarValues = { ...templateVarValues, [v]: target.value };
												}}
											/>
										</div>
									{/each}
								</div>
							{:else}
								<div class="muted">此模板未检测到变量占位符</div>
							{/if}
						</div>

						<div class="tmpl-insert-actions">
							<button class="btn" type="button" onclick={insertSelectedTemplate} disabled={streaming || !selectedTemplateId}>
								插入到输入框
							</button>
						</div>
					{:else}
						<div class="muted">请选择一个模板</div>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>
