// @ts-check

/**
 * 相对时间格式化（纯函数）
 *
 * 目标：
 * - 用更轻量的“刚刚 / X 分钟前 / X 小时前 / YYYY-MM-DD”替代精确到秒的时间，降低 UI 噪音
 * - 输出稳定、可测试，不依赖浏览器环境
 */

/**
 * @param {number | string | null | undefined} tsMs
 * @param {number | string | null | undefined} [nowMs]
 * @returns {string}
 */
export function formatRelativeTime(tsMs, nowMs) {
	const ts = Number(tsMs);
	const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
	if (!Number.isFinite(ts) || ts <= 0) return '—';
	if (!Number.isFinite(now) || now <= 0) return '—';

	let diff = now - ts;
	if (!Number.isFinite(diff)) return '—';
	if (diff < 0) diff = 0;

	if (diff < 60_000) return '刚刚';
	if (diff < 60 * 60_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
	if (diff < 24 * 60 * 60_000) return `${Math.max(1, Math.floor(diff / (60 * 60_000)))} 小时前`;

	return formatLocalYmd(ts);
}

/**
 * @param {number} tsMs
 * @returns {string}
 */
function formatLocalYmd(tsMs) {
	const d = new Date(tsMs);
	if (!Number.isFinite(d.getTime())) return '—';
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

