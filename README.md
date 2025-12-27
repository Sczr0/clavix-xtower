# EdgeAI Playground（ESA + SvelteKit）

一个“边缘 AI 调试台”：前端用 SvelteKit（静态站点），后端用阿里云 ESA（Functions and Pages）的 Edge Function 作为代理转发层，支持流式对话（SSE）。

## 功能

- OpenAI Compatible（`/v1/chat/completions`）与 Anthropic（`/v1/messages`）上游代理与流式回传（SSE）
- Markdown 渲染：支持代码块高亮与一键复制
- 思维链展示：若上游返回 `reasoning/thinking` 字段，或模型输出包含 `<think>/<analysis>` 标签，会与正文拆分并在 UI 中折叠展示（默认不显示；也可按单条消息展开）
- 设置持久化：除 API Key 外，其余运行设置会写入浏览器 `localStorage`（刷新不丢）
- OpenAI 采样参数：支持在设置面板配置 `top_p`、`presence_penalty`、`frequency_penalty`（默认不改变原行为）
- 会话管理：新建/切换/重命名/复制/删除/搜索；导入导出（JSON/Markdown）；会话写入 `localStorage`（不含 API Key）
- 体验优化：移动端“设置抽屉”、长对话默认仅渲染最近 200 条（可切换显示全部）、“跳到最新”按钮

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

## 重要限制与安全建议

- 仅支持 `https` 域名形式的 Base URL（允许无路径或以 `/v1` 结尾），不支持 IP/端口/Query（函数侧会校验并拒绝）。
- 允许自定义上游会带来开放代理/滥用风险：建议上线前启用域名白名单、限流、验证码/风控与审计告警。
- API Key 由用户在浏览器输入并经由代理转发：默认不落盘不打印，但平台级日志/Tracing 仍可能带来残留风险，请在控制台侧关闭/脱敏相关能力。
