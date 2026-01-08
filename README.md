# EdgeAI Playground（ESA + SvelteKit）

一个“边缘 AI 调试台”：前端用 SvelteKit（静态站点），后端用阿里云 ESA（Functions and Pages）的 Edge Function 作为代理转发层，支持流式对话（SSE）。

## 功能

- OpenAI Compatible（`/v1/chat/completions`）与 Anthropic（`/v1/messages`）上游代理与流式回传（SSE）
- Markdown 渲染：支持代码块高亮、一键复制与下载
- 消息级操作：编辑历史消息后“从此处重跑”（分叉会话）、一键重试、续写、停止
- 思维链展示：若上游返回 `reasoning/thinking` 字段，或模型输出包含 `<think>/<analysis>` 标签，会与正文拆分并在 UI 中折叠展示（默认不显示；也可按单条消息展开）
- 设置持久化：除 API Key 外，其余运行设置会写入浏览器 `localStorage`（刷新不丢）
- OpenAI 采样参数：支持在设置面板配置 `top_p`、`presence_penalty`、`frequency_penalty`（默认不改变原行为）
- 会话管理：新建/切换/重命名/复制/删除/搜索；导入导出（JSON/Markdown）；会话写入 `localStorage`（不含 API Key）
- 体验优化：移动端“设置抽屉”、长对话默认仅渲染最近 200 条（可切换显示全部）、“跳到最新”按钮
- 调试报告：调试面板一键导出 JSON/Markdown、下载 JSON，并可生成分享链接（hash）一键导入展示（默认不含明文 API Key）
- 代理安全护栏（可选）：支持上游域名白名单、按 IP 限流、上游超时、请求体大小限制（默认关闭，见下方环境变量）

## 目录结构

- `src/`：SvelteKit 前端（静态构建到 `build/`）
- `functions/index.js`：ESA Edge Function（同域 `/api/chat` 代理转发）
- `esa.jsonc`：ESA 构建与路由配置

## 本地开发

> 本项目的 `/api/chat` 逻辑属于 ESA Edge Function；本地通过一个轻量 dev-proxy 复用同一份函数代码。

1) 安装依赖：

```sh
npm ci
```

2) 终端 A：启动 dev-proxy（默认 `http://127.0.0.1:8787`）：

```sh
npm run dev:proxy
```

3) 终端 B：启动前端（Vite 会把 `/api/*` 代理到 dev-proxy）：

```sh
npm run dev -- --open
```

## 部署到阿里云 ESA（Functions and Pages）

1) 在 ESA 控制台创建 Functions and Pages 项目（关联本仓库或直接上传）。
2) 确保项目根目录存在 `esa.jsonc`，ESA 会按其中的 `installCommand/buildCommand/assets/entry` 执行构建与发布。
3) 绑定域名后访问站点即可使用。

## 调试报告（导出与分享）

在“调试面板 → 本次请求”中：

- **报告 JSON / 报告 MD**：复制结构化调试报告到剪贴板（默认脱敏，不包含明文 API Key）
- **下载 JSON**：下载完整报告文件，适合发给同事/工单排障
- **分享链接**：生成“摘要版”分享链接（URL hash），新开标签访问即可自动导入并展示

注意：调试报告仍会包含你的提示词/模型输出/请求参数等信息，请仅分享给可信对象；分享链接为摘要版，部分字段可能截断，如需完整信息请使用“下载 JSON”。

## 重要限制与安全建议

- 仅支持 `https` 域名形式的 Base URL（允许无路径或以 `/v1` 结尾），不支持 IP/端口/Query（函数侧会校验并拒绝）。
- 允许自定义上游会带来开放代理/滥用风险：建议上线前启用域名白名单、限流、验证码/风控与审计告警。
- API Key 由用户在浏览器输入并经由代理转发：默认不落盘不打印，但平台级日志/Tracing 仍可能带来残留风险，请在控制台侧关闭/脱敏相关能力。

### 可选：代理安全护栏（环境变量）

以下环境变量均作用于 `functions/index.js`（未配置则不启用，保持当前默认行为）：

- `EDGEAI_ALLOWED_UPSTREAM_HOSTS`：上游域名白名单（逗号分隔）
  - 支持精确域名：`api.openai.com,api.anthropic.com,openrouter.ai`
  - 支持后缀匹配：`*.openai.com` 或 `.openai.com`（仅匹配子域名；根域名需显式加入）
- `EDGEAI_RATE_LIMIT_PER_MINUTE`：按客户端标识的每分钟请求数限制（整数；≤0 关闭）
  - best-effort：基于单实例内存 Map；多实例/冷启动不保证全局一致，但可作为基础护栏
  - 客户端 IP 取自 `x-forwarded-for`/`x-real-ip`/`cf-connecting-ip` 等常见头
- `EDGEAI_MAX_REQUEST_BYTES`：`/api/chat` 请求体最大字节数（UTF-8；整数；≤0 关闭）
- `EDGEAI_UPSTREAM_TIMEOUT_MS`：上游请求/流式读取总超时（毫秒；整数；≤0 关闭）；超时会通过 SSE `event: error` 返回并关闭连接

## Profiles（配置预设 / 环境）

在右侧“设置”面板新增 **Profiles** 区块，可将以下运行配置保存为“命名预设”，并一键切换：
- provider / baseUrl / model
- system prompt
- 采样参数（temperature/top_p/presence_penalty/frequency_penalty/maxTokens、以及 Anthropics 的 version）

### 导入 / 导出 / 分享
- 支持导出 Profiles JSON（下载/复制），以及从 JSON 导入。
- 支持生成分享链接（URL hash），新开页面可自动导入。
- 默认脱敏：导出/分享 **不包含明文 API Key**（导入内容如包含 apiKey 仅用于填充输入框，不会持久化）。

### 注意
Profile 可能包含 system prompt 等敏感信息，请谨慎分享。
