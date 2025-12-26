/**
 * 思维链解析与拆分（前端/Node 通用）。
 *
 * 目标：
 * - 支持 OpenAI Compatible SSE 增量里常见的 reasoning 字段（如 delta.reasoning / delta.reasoning_content）。
 * - 支持把模型输出中的 <think>...</think> / <analysis>...</analysis> 拆分为“正文(content)”与“思维链(thinking)”。
 *
 * 说明：
 * - 这里只处理“模型显式输出/上游显式返回”的文本，不涉及任何模型内部推理机制。
 */

const DEFAULT_OPEN_TAGS = ['<think>', '<analysis>'];
const DEFAULT_CLOSE_TAGS = ['</think>', '</analysis>'];

/**
 * @typedef {'open' | 'close'} TagKind
 * @typedef {{ index: number; tag: string; kind: TagKind }} TagHit
 */

/**
 * 找到最早出现的标签位置（大小写不敏感）。
 * @param {string} text
 * @param {string[]} openTags
 * @param {string[]} closeTags
 * @returns {TagHit | null}
 */
function findNextTag(text, openTags, closeTags) {
	const lower = text.toLowerCase();

	/** @type {TagHit | null} */
	let best = null;

	for (const tag of openTags) {
		const idx = lower.indexOf(tag);
		if (idx === -1) continue;
		if (!best || idx < best.index) best = { index: idx, tag, kind: 'open' };
	}
	for (const tag of closeTags) {
		const idx = lower.indexOf(tag);
		if (idx === -1) continue;
		if (!best || idx < best.index) best = { index: idx, tag, kind: 'close' };
	}

	return best;
}

/**
 * @typedef {{
 *   push: (chunk: string) => { contentDelta: string; thinkingDelta: string };
 *   flush: () => { contentDelta: string; thinkingDelta: string };
 *   reset: () => void;
 * }} ThoughtChainSplitter
 */

/**
 * 创建一个“流式”思维链拆分器：逐段输入字符串，输出 content/thinking 增量。
 * - 会吞掉 <think>/<analysis> 标签本身
 * - 为避免标签被切片（chunk 末尾只有 "<thi"），内部会保留最多 (maxTagLen - 1) 个尾部字符作为缓冲
 *
 * @param {{ openTags?: string[]; closeTags?: string[] }} [options]
 * @returns {ThoughtChainSplitter}
 */
export function createThoughtChainSplitter(options = {}) {
	const openTags = (options.openTags?.length ? options.openTags : DEFAULT_OPEN_TAGS).map((t) => t.toLowerCase());
	const closeTags = (options.closeTags?.length ? options.closeTags : DEFAULT_CLOSE_TAGS).map((t) => t.toLowerCase());
	const allTags = [...openTags, ...closeTags];
	const maxTagLen = Math.max(1, ...[...openTags, ...closeTags].map((t) => t.length));

	let buffer = '';
	let inThinking = false;

	/**
	 * @param {{ contentDelta: string; thinkingDelta: string }} out
	 * @param {string} text
	 */
	function append(out, text) {
		if (!text) return;
		if (inThinking) out.thinkingDelta += text;
		else out.contentDelta += text;
	}

	function calcKeepTailLen() {
		const max = Math.min(maxTagLen - 1, buffer.length);
		if (max <= 0) return 0;

		const lower = buffer.toLowerCase();
		for (let len = max; len > 0; len--) {
			const suffix = lower.slice(-len);
			for (const tag of allTags) {
				if (tag.startsWith(suffix)) return len;
			}
		}

		return 0;
	}

	return {
		push(chunk) {
			if (typeof chunk !== 'string' || chunk.length === 0) return { contentDelta: '', thinkingDelta: '' };

			/** @type {{ contentDelta: string; thinkingDelta: string }} */
			const out = { contentDelta: '', thinkingDelta: '' };
			buffer += chunk;

			while (true) {
				const hit = findNextTag(buffer, openTags, closeTags);
				if (!hit) break;

				const before = buffer.slice(0, hit.index);
				append(out, before);

				buffer = buffer.slice(hit.index + hit.tag.length);
				inThinking = hit.kind === 'open';
			}

			// 没有更多完整标签时：尽可能输出，只保留可能构成“半截标签”的尾部
			const keep = calcKeepTailLen();
			if (keep > 0) {
				const safe = buffer.slice(0, buffer.length - keep);
				append(out, safe);
				buffer = buffer.slice(buffer.length - keep);
			} else if (buffer) {
				append(out, buffer);
				buffer = '';
			}

			return out;
		},
		flush() {
			/** @type {{ contentDelta: string; thinkingDelta: string }} */
			const out = { contentDelta: '', thinkingDelta: '' };
			append(out, buffer);
			buffer = '';
			return out;
		},
		reset() {
			buffer = '';
			inThinking = false;
		}
	};
}

/**
 * OpenAI Compatible：从单条 SSE data 字符串中提取正文/思维链增量。
 *
 * 兼容场景：
 * - 标准：choices[0].delta.content
 * - 兼容旧格式：choices[0].text
 * - 常见“思维链字段”：choices[0].delta.reasoning / delta.reasoning_content / delta.thinking
 *
 * @param {string} data
 * @returns {{ done: boolean; contentDelta: string; thinkingDelta: string }}
 */
export function parseOpenAiSseData(data) {
	if (data === '[DONE]') return { done: true, contentDelta: '', thinkingDelta: '' };
	if (typeof data !== 'string' || !data) return { done: false, contentDelta: '', thinkingDelta: '' };

	try {
		const parsed = JSON.parse(data);
		const choice = parsed?.choices?.[0] ?? {};
		const delta = choice?.delta ?? {};

		const contentDelta = typeof delta?.content === 'string' ? delta.content : typeof choice?.text === 'string' ? choice.text : '';

		const thinkingDelta =
			typeof delta?.reasoning === 'string'
				? delta.reasoning
				: typeof delta?.reasoning_content === 'string'
					? delta.reasoning_content
					: typeof delta?.thinking === 'string'
						? delta.thinking
						: '';

		return { done: false, contentDelta, thinkingDelta };
	} catch {
		// 上游偶尔会插入不可解析片段；按“无增量”处理
		return { done: false, contentDelta: '', thinkingDelta: '' };
	}
}

/**
 * @typedef {{ event: string | null; data: string; id: string | null }} SseEvent
 * @typedef {{ blockTypes: Map<number, string> }} AnthropicSseContext
 */

/**
 * Anthropic：创建流式解析上下文（用于记住 content block 的类型）。
 * @returns {AnthropicSseContext}
 */
export function createAnthropicSseContext() {
	return { blockTypes: new Map() };
}

/**
 * Anthropic：解析单条 SSE 事件，提取正文/思维链增量。
 *
 * 兼容思路：
 * - 先通过 content_block_start 记录 index -> content_block.type
 * - content_block_delta 根据 index 的 type 决定落到正文还是思维链
 * - 同时做 shape-based 兜底（delta.text / delta.thinking 等）
 *
 * @param {SseEvent} event
 * @param {AnthropicSseContext} ctx
 * @returns {{ contentDelta: string; thinkingDelta: string }}
 */
export function parseAnthropicSseEvent(event, ctx) {
	if (!event?.data) return { contentDelta: '', thinkingDelta: '' };

	try {
		const parsed = JSON.parse(event.data);
		const type = String(event.event ?? parsed?.type ?? '');

		if (type === 'content_block_start') {
			const index = parsed?.index;
			const blockType = parsed?.content_block?.type;
			if (Number.isInteger(index) && typeof blockType === 'string') ctx.blockTypes.set(index, blockType);
			return { contentDelta: '', thinkingDelta: '' };
		}

		if (type !== 'content_block_delta') return { contentDelta: '', thinkingDelta: '' };

		const index = parsed?.index;
		const blockType = Number.isInteger(index) ? ctx.blockTypes.get(index) : undefined;
		const delta = parsed?.delta ?? {};

		const deltaType = typeof delta?.type === 'string' ? delta.type : '';

		// 常见：text
		const textDelta =
			typeof delta?.text === 'string'
				? delta.text
				: typeof delta?.text_delta?.text === 'string'
					? delta.text_delta.text
					: deltaType === 'text_delta' && typeof delta?.text === 'string'
						? delta.text
						: '';

		// 常见：thinking（可能会被标记为 redacted_thinking）
		const thinkingDelta =
			typeof delta?.thinking === 'string'
				? delta.thinking
				: typeof delta?.thinking_delta?.thinking === 'string'
					? delta.thinking_delta.thinking
					: deltaType === 'thinking_delta' && typeof delta?.thinking === 'string'
						? delta.thinking
						: '';

		const isThinkingBlock =
			blockType === 'thinking' || blockType === 'redacted_thinking' || blockType === 'thinking_summary';

		if (isThinkingBlock) return { contentDelta: '', thinkingDelta: thinkingDelta || textDelta };
		return { contentDelta: textDelta, thinkingDelta };
	} catch {
		return { contentDelta: '', thinkingDelta: '' };
	}
}
