// @ts-check

/**
 * 对比模式：目标选择相关纯函数
 *
 * 约束：
 * - 不依赖 DOM，便于 node --test
 * - 仅处理目标 id 列表的归一化与勾选切换
 */

/**
 * @typedef {{ maxTargets?: number }} NormalizeOptions
 */

/**
 * @param {unknown} rawIds
 * @param {NormalizeOptions} [options]
 * @returns {string[]}
 */
export function normalizeCompareTargetIds(rawIds, options) {
	const list = Array.isArray(rawIds) ? rawIds : [];
	const maxTargetsRaw = options?.maxTargets;
	const maxTargets = Number.isFinite(maxTargetsRaw) && Number(maxTargetsRaw) > 0 ? Math.floor(Number(maxTargetsRaw)) : Infinity;

	/** @type {string[]} */
	const out = [];
	for (const it of list) {
		const id = typeof it === 'string' ? it.trim() : '';
		if (!id) continue;
		if (out.includes(id)) continue;
		out.push(id);
		if (out.length >= maxTargets) break;
	}
	return out;
}

/**
 * @param {unknown} currentIds
 * @param {string} id
 * @param {boolean} checked
 * @param {NormalizeOptions} [options]
 * @returns {string[]}
 */
export function toggleCompareTargetId(currentIds, id, checked, options) {
	const normalizedId = typeof id === 'string' ? id.trim() : '';
	const current = normalizeCompareTargetIds(currentIds, options);
	if (!normalizedId) return current;

	if (checked) {
		if (current.includes(normalizedId)) return current;

		const maxTargetsRaw = options?.maxTargets;
		const maxTargets = Number.isFinite(maxTargetsRaw) && Number(maxTargetsRaw) > 0 ? Math.floor(Number(maxTargetsRaw)) : Infinity;
		if (current.length >= maxTargets) return current;

		return normalizeCompareTargetIds([...current, normalizedId], options);
	}

	return normalizeCompareTargetIds(
		current.filter((it) => it !== normalizedId),
		options
	);
}
