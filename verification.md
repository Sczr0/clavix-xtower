# verification.md

- 日期：2025-12-23（Codex）
- 项目：EdgeAI Playground（ESA + SvelteKit）

## 已验证

- `npm test`：通过（覆盖 baseUrl 校验、端点映射、`/api/chat` 流式透传的基本行为）。
- `npm run build`：通过（SvelteKit adapter-static 输出到 `build/`，与 `esa.jsonc` 配置一致）。

## 未在本地自动化验证（原因与风险）

- 真实上游（OpenAI/Anthropic/LocalAI）联调：需要有有效 Key 与可用上游域名，且涉及敏感信息；建议在 ESA 预发环境用短期 Key 做一次端到端验证，并确认平台日志不泄露请求头/请求体。

---

- 日期：2025-12-26（Codex）
- 变更：添加网站 ICP 备案号（皖ICP备2025107155号），暂不添加公安备案号

## 已验证

- `npm test`：通过（8/8）
- `npm run build`：通过（SvelteKit adapter-static 输出到 `build/`，页脚可见 ICP 备案号链接）
