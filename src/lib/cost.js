// @ts-check

/**
 * 成本估算（纯函数）
 *
 * 设计原则：
 * - 不内置价格表：价格易变且缺乏可追溯来源，统一交给用户输入单价
 * - 单价单位：USD / 1,000,000 tokens（输入/输出分开）
 */

/**
 * @typedef {{
 *   inputTokens?: number;
 *   outputTokens?: number;
 *   totalTokens?: number;
 * }} TokenUsage
 *
 * @typedef {{
 *   inputUsdPer1M?: number;
 *   outputUsdPer1M?: number;
 * }} Pricing
 */

/**
 * @param {TokenUsage | null | undefined} usage
 * @param {Pricing | null | undefined} pricing
 * @returns {number | null}
 */
export function estimateUsdCost(usage, pricing) {
	if (!usage || !pricing) return null;

	const inPriceRaw = Number(pricing.inputUsdPer1M);
	const outPriceRaw = Number(pricing.outputUsdPer1M);

	const inPrice = Number.isFinite(inPriceRaw) ? Math.max(0, inPriceRaw) : 0;
	const outPrice = Number.isFinite(outPriceRaw) ? Math.max(0, outPriceRaw) : 0;
	if (inPrice <= 0 && outPrice <= 0) return null;

	const inTokens =
		typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens) ? Math.max(0, usage.inputTokens) : 0;
	const outTokens =
		typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens) ? Math.max(0, usage.outputTokens) : 0;
	if (!inTokens && !outTokens) return null;

	const cost = (inTokens / 1_000_000) * inPrice + (outTokens / 1_000_000) * outPrice;
	return Number.isFinite(cost) ? cost : null;
}

/**
 * @param {number | null | undefined} cost
 */
export function formatUsd(cost) {
	if (typeof cost !== 'number' || !Number.isFinite(cost)) return '—';
	if (cost === 0) return '$0';
	if (cost < 0.01) return `$${cost.toFixed(6)}`;
	if (cost < 1) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}

