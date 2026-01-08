// @ts-check

/**
 * 聊天消息“操作级”纯函数：用于实现“从此处重跑/重试”等逻辑。
 *
 * 设计原则：
 * - 纯函数：不依赖 DOM，不读写 localStorage，便于 node --test 单测
 * - 不修改入参：返回的新数组/对象为拷贝，避免 UI 状态出现意外联动
 */

/**
 * @typedef {'user' | 'assistant'} Role
 *
 * @typedef {{
 *   inputTokens?: number;
 *   outputTokens?: number;
 *   totalTokens?: number;
 * }} TokenUsage
 *
 * @typedef {{
 *   id: string;
 *   role: Role;
 *   content: string;
 *   thinking?: string;
 *   usage?: TokenUsage;
 *   at: number;
 * }} ChatMessage
 *
 * @typedef {{ ok: true; forkMessages: ChatMessage[]; shouldAutoRun: boolean } | { ok: false; reason: string }} ForkResult
 */

/**
 * @param {ChatMessage} m
 * @returns {ChatMessage}
 */
function cloneMessage(m) {
	// usage 只做浅拷贝即可（当前结构为 flat numbers）
	const usage = m.usage ? { ...m.usage } : undefined;
	return { ...m, ...(usage ? { usage } : {}) };
}

/**
 * @param {ChatMessage[]} messages
 * @param {string} id
 */
function findMessageIndex(messages, id) {
	return messages.findIndex((m) => m && typeof m === 'object' && m.id === id);
}

/**
 * @param {ChatMessage[]} messages
 * @param {number} beforeIndex
 */
function findLastUserIndexBefore(messages, beforeIndex) {
	for (let i = beforeIndex - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === 'user') return i;
	}
	return -1;
}

/**
 * “从此处重跑”：把会话裁剪到指定消息（含），并可替换该消息内容。
 *
 * 约定：
 * - 如果裁剪后的最后一条消息是 user 且内容非空，则 shouldAutoRun=true（页面层可直接重新生成 assistant）
 * - 如果最后一条为 assistant，则仅分叉到该点（shouldAutoRun=false）
 *
 * @param {ChatMessage[]} messages
 * @param {string} messageId
 * @param {string} [editedContent]
 * @returns {ForkResult}
 */
export function buildForkForRerun(messages, messageId, editedContent) {
	if (!Array.isArray(messages)) return { ok: false, reason: 'messages 不是数组' };
	if (typeof messageId !== 'string' || !messageId.trim()) return { ok: false, reason: 'messageId 为空' };

	const idx = findMessageIndex(messages, messageId);
	if (idx < 0) return { ok: false, reason: '未找到对应消息' };

	const forkMessages = messages.slice(0, idx + 1).map(cloneMessage);

	if (typeof editedContent === 'string') {
		forkMessages[idx] = { ...forkMessages[idx], content: editedContent };
	}

	const last = forkMessages[forkMessages.length - 1];
	const shouldAutoRun = last?.role === 'user' && typeof last.content === 'string' && !!last.content.trim();

	return { ok: true, forkMessages, shouldAutoRun };
}

/**
 * “重试 assistant 消息”：定位该 assistant 对应的“最近 user 输入”，并把会话裁剪到该 user（含）。
 *
 * @param {ChatMessage[]} messages
 * @param {string} assistantMessageId
 * @returns {ForkResult}
 */
export function buildForkForRetry(messages, assistantMessageId) {
	if (!Array.isArray(messages)) return { ok: false, reason: 'messages 不是数组' };
	if (typeof assistantMessageId !== 'string' || !assistantMessageId.trim()) return { ok: false, reason: 'messageId 为空' };

	const assistantIdx = findMessageIndex(messages, assistantMessageId);
	if (assistantIdx < 0) return { ok: false, reason: '未找到对应消息' };

	const assistant = messages[assistantIdx];
	if (assistant?.role !== 'assistant') return { ok: false, reason: '目标消息不是 assistant' };

	const lastUserIdx = findLastUserIndexBefore(messages, assistantIdx);
	if (lastUserIdx < 0) return { ok: false, reason: 'assistant 之前没有 user 消息，无法重试' };

	const forkMessages = messages.slice(0, lastUserIdx + 1).map(cloneMessage);
	const last = forkMessages[forkMessages.length - 1];
	const shouldAutoRun = last?.role === 'user' && typeof last.content === 'string' && !!last.content.trim();

	return { ok: true, forkMessages, shouldAutoRun };
}

