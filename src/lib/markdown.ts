/**
 * Markdown 渲染（带基础安全清洗 + 代码高亮 + 复制按钮）。
 *
 * 说明：
 * - UI 会用 `{@html ...}` 注入渲染结果，因此必须做 XSS 清洗。
 * - 仅用于“显示”层，不用于请求上游；复制仍以原始文本为准。
 */

import DOMPurify from 'isomorphic-dompurify';
import { marked } from 'marked';

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('text', plaintext);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);

function escapeHtml(raw: string): string {
	return raw
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function normalizeLang(lang: string | undefined): string {
	if (!lang) return '';
	const hit = lang.trim().toLowerCase().match(/^[a-z0-9_-]+/i)?.[0] ?? '';
	return hit;
}

function highlightCode(text: string, lang: string | undefined): { languageLabel: string; html: string } {
	const language = normalizeLang(lang);
	if (!language) return { languageLabel: '', html: escapeHtml(text) };

	if (hljs.getLanguage(language)) {
		try {
			return { languageLabel: language, html: hljs.highlight(text, { language }).value };
		} catch {
			return { languageLabel: language, html: escapeHtml(text) };
		}
	}

	try {
		const auto = hljs.highlightAuto(text);
		return { languageLabel: auto.language ?? language, html: auto.value };
	} catch {
		return { languageLabel: language, html: escapeHtml(text) };
	}
}

marked.setOptions({
	gfm: true,
	breaks: true
});

marked.use({
	renderer: {
		code(token) {
			const { languageLabel, html } = highlightCode(token.text, token.lang);
			const languageClass = normalizeLang(languageLabel);
			const label = languageLabel ? escapeHtml(languageLabel) : '';
			const labelHtml = label ? `<span class="md-code-lang">${label}</span>` : `<span class="md-code-lang">code</span>`;

			return `
<div class="md-code">
  <div class="md-code-header">
    ${labelHtml}
    <button type="button" class="md-code-copy" data-copy-code>复制</button>
  </div>
  <pre><code class="hljs${languageClass ? ` language-${languageClass}` : ''}">${html}</code></pre>
</div>
`;
		},
		link(token) {
			const text = this.parser.parseInline(token.tokens);
			const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
			const href = token.href ? escapeHtml(token.href) : '';
			if (!href) return text;
			return `<a href="${href}"${title} target="_blank" rel="noreferrer noopener">${text}</a>`;
		}
	}
});

export function renderMarkdownToHtml(markdownText: string): string {
	const src = typeof markdownText === 'string' ? markdownText : String(markdownText ?? '');
	const raw = marked.parse(src, { async: false }) as string;

	return DOMPurify.sanitize(raw, {
		USE_PROFILES: { html: true },
		ADD_ATTR: ['target', 'rel', 'data-copy-code'],
		ADD_TAGS: ['button']
	});
}
