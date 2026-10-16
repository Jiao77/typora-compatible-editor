import MarkdownIt from 'markdown-it';
import markdownItAbbr from 'markdown-it-abbr';
import markdownItAnchor from 'markdown-it-anchor';
import markdownItAttrs from 'markdown-it-attrs';
import markdownItContainer from 'markdown-it-container';
import markdownItDeflist from 'markdown-it-deflist';
import * as markdownItEmoji from 'markdown-it-emoji';
import markdownItFootnote from 'markdown-it-footnote';
import markdownItFrontMatter from 'markdown-it-front-matter';
import markdownItIns from 'markdown-it-ins';
import markdownItMark from 'markdown-it-mark';
import markdownItMultimdTable from 'markdown-it-multimd-table';
import markdownItSub from 'markdown-it-sub';
import markdownItSup from 'markdown-it-sup';
import markdownItTaskLists from 'markdown-it-task-lists';
import highlightjs from 'highlight.js';

// Typora 支持的 callout 类型，对应 GitHub 风格提示块
export const ALERT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'];

// Typora 的图表围栏语言
export const DIAGRAM_LANGS = new Set(['mermaid', 'sequence', 'flow', 'flowchart']);

const FRONT_MATTER_STORE = Symbol.for('typora.frontMatter');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function createMarkdownIt(options = {}) {
  const md = new MarkdownIt({
    html: options.html !== false,
    xhtmlOut: false,
    breaks: options.breaks === true,
    langPrefix: 'language-',
    linkify: options.linkify !== false,
    typographer: false,
    quotes: '“”‘’'
  });

  // Front Matter 只记录数据，正文渲染时另行输出 md-meta-block
  md[FRONT_MATTER_STORE] = null;
  md.use(markdownItFrontMatter, (frontMatter) => {
    md[FRONT_MATTER_STORE] = frontMatter;
  });
  md.use(markdownItAbbr);
  md.use(markdownItFootnote);
  md.use(markdownItDeflist);
  md.use(markdownItIns);
  md.use(markdownItMark);
  md.use(markdownItSub);
  md.use(markdownItSup);
  md.use(markdownItMultimdTable, {
    multiline: true,
    rowspan: true,
    headerless: true,
    multibody: true,
    autolabel: true
  });
  md.use(markdownItTaskLists, { enabled: false, label: false, labelAfter: false });
  md.use(markdownItAttrs, {
    allowedAttributes: ['id', 'class', 'style', 'width', 'height', 'align', 'title', 'target', 'rel']
  });
  md.use(markdownItAnchor, {
    level: options.anchorLevel ?? [1, 2, 3, 4, 5, 6],
    permalink: false
  });

  for (const type of ALERT_TYPES) {
    md.use(markdownItContainer, type, {
      validate: (params) => params.trim().toLowerCase() === `[!${type.toUpperCase()}]`,
      render: (tokens, idx) => {
        if (tokens[idx].nesting === 1) {
          const title = type.charAt(0).toUpperCase() + type.slice(1);
          return `<div class="md-alert md-alert-${type}">\n<p class="md-alert-title md-alert-text-${type}">${title}</p>\n`;
        }
        return '</div>\n';
      }
    });
  }

  md.use(markdownItEmoji.full);

  return md;
}

export function getFrontMatter(md) {
  return md[FRONT_MATTER_STORE] ?? null;
}

// Front Matter 需要作为 md-meta-block 真实渲染，因此解除 hidden 标记
export function installFrontMatter(md) {
  md.core.ruler.push('typora_front_matter', (state) => {
    for (const token of state.tokens) {
      if (token.type === 'front_matter') {
        token.hidden = false;
        token.block = true;
        if (!token.meta) token.meta = { content: md[FRONT_MATTER_STORE] || '' };
      }
    }
    return true;
  });
  md.renderer.rules.front_matter = (tokens, idx) => {
    // front-matter 插件把内容存为字符串，这里同时兼容字符串与对象两种形态
    const meta = tokens[idx].meta;
    const content = typeof meta === 'string' ? meta : (meta && meta.content) || '';
    return `<pre class="md-meta-block md-end-block">${escapeHtml(String(content).trim())}</pre>\n`;
  };
}

// Typora 的 [TOC] 块，收集全文标题生成 md-toc 结构
export function installToc(md) {
  md.core.ruler.push('typora_toc', (state) => {
    const headings = [];
    for (let i = 0; i < state.tokens.length; i += 1) {
      const token = state.tokens[i];
      if (token.type !== 'heading_open') continue;
      const inline = state.tokens[i + 1];
      if (!inline || inline.type !== 'inline') continue;
      const text = inline.children
        .filter((child) => child.type === 'text' || child.type === 'code_inline')
        .map((child) => child.content)
        .join('')
        .trim();
      headings.push({ level: Number(token.tag.slice(1)), text, id: token.attrGet('id') });
    }

    for (let i = 0; i < state.tokens.length; i += 1) {
      const token = state.tokens[i];
      if (token.type !== 'inline') continue;
      const marker = token.content.trim().toLowerCase();
      if (marker !== '[toc]' && marker !== '{{toc}}') continue;
      const open = state.tokens[i - 1];
      const close = state.tokens[i + 1];
      if (!open || open.type !== 'paragraph_open' || !close || close.type !== 'paragraph_close') continue;
      open.hidden = true;
      close.hidden = true;
      token.type = 'toc';
      token.content = '';
      token.meta = { headings: headings.slice() };
    }
    return true;
  });

  md.renderer.rules.toc = (tokens, idx) => {
    const items = (tokens[idx].meta && tokens[idx].meta.headings) || [];
    if (!items.length) return '<div class="md-toc md-end-block"></div>\n';
    const links = items
      .map((item) => {
        const href = item.id ? `#${encodeURIComponent(item.id)}` : '#';
        return `<div class="md-toc-item md-toc-h${item.level}"><a href="${href}">${escapeHtml(item.text)}</a></div>`;
      })
      .join('');
    return '<div class="md-toc md-end-block"><div class="md-tooltip-hide md-toc-tooltip"></div>' +
      `<div class="md-toc-content"><div class="md-toc-inner">${links}</div></div></div>\n`;
  };
}

// Typora 的 callout 语法写作引用块首行 [!NOTE]，这里把该块标记为 md-alert 容器
const ALERT_PATTERN = /^\[!([A-Za-z]+)\]\s*$/;

export function installAlerts(md) {
  md.core.ruler.push('typora_alert', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i].type !== 'blockquote_open') continue;
      const paraIndex = i + 1;
      if (!tokens[paraIndex] || tokens[paraIndex].type !== 'paragraph_open') continue;
      const inline = tokens[paraIndex + 1];
      if (!inline || inline.type !== 'inline' || inline.children.length === 0) continue;
      const first = inline.children[0];
      if (first.type !== 'text') continue;
      const newlineAt = first.content.indexOf('\n');
      const marker = (newlineAt === -1 ? first.content : first.content.slice(0, newlineAt)).trim();
      const match = ALERT_PATTERN.exec(marker);
      if (!match) continue;
      const type = match[1].toLowerCase();
      if (!ALERT_TYPES.includes(type)) continue;

      if (newlineAt === -1) {
        inline.children.shift();
      } else {
        first.content = first.content.slice(newlineAt + 1);
      }

      // 移除标记行与正文之间的换行 token
      while (inline.children.length > 0 && inline.children[0].type === 'softbreak') {
        inline.children.shift();
      }

      // 记录 alert 类型，由渲染规则输出标题与容器类名
      tokens[i].meta = { ...(tokens[i].meta || {}), alertType: type };
      tokens[i].attrSet('class', `md-alert md-alert-${type}`);

      // 同步标记配对的关闭 token，渲染关闭标签时才能判断容器类型
      let depth = 0;
      for (let j = i; j < tokens.length; j += 1) {
        if (tokens[j].type === 'blockquote_open') depth += 1;
        else if (tokens[j].type === 'blockquote_close') {
          depth -= 1;
          if (depth === 0) {
            tokens[j].meta = { ...(tokens[j].meta || {}), alertType: type };
            break;
          }
        }
      }

      // 标记行独占正文时移除隐藏的空段落
      if (inline.children.length === 0) {
        tokens[paraIndex].hidden = true;
        tokens[paraIndex + 2].hidden = true;
      }
    }
    return true;
  });
}

// Typora 使用 MathJax 渲染数学公式，服务端只输出占位容器
function renderMathInline(tex) {
  return `<span class="md-inline-math md-inline-math-container" data-tex="${escapeHtml(tex)}">` +
    `<span class="md-mathjax-midline">\\(${escapeHtml(tex)}\\)</span></span>`;
}

export function installMath(md) {
  const inlineRule = (state, silent) => {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 0x24) return false;
    if (state.src.charCodeAt(start + 1) === 0x24) return false;
    let end = start + 1;
    while (end < state.posMax) {
      const code = state.src.charCodeAt(end);
      if (code === 0x5c) {
        end += 2;
        continue;
      }
      if (code === 0x24) break;
      if (code === 0x0a) return false;
      end += 1;
    }
    if (end >= state.posMax || state.src.charCodeAt(end) !== 0x24) return false;
    if (end === start + 1) return false;
    const tex = state.src.slice(start + 1, end);
    if (silent) return true;
    const token = state.push('math_inline', 'math', 0);
    token.content = tex;
    token.markup = '$';
    state.pos = end + 1;
    return true;
  };

  const blockRule = (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    const line = state.src.slice(start, max);
    if (!line.startsWith('$$')) return false;
    const closer = line.length > 2 && line.trimEnd().endsWith('$$') && line.trim() !== '$$';
    if (silent) return closer;
    const token = state.push('math_block', 'math', 0);
    if (closer) {
      token.content = line.trim().slice(2, -2).trim();
      state.line = startLine + 1;
      return true;
    }
    const body = [];
    let nextLine = startLine + 1;
    let found = false;
    for (; nextLine < endLine; nextLine += 1) {
      const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineEnd = state.eMarks[nextLine];
      const text = state.src.slice(lineStart, lineEnd);
      const closeAt = text.indexOf('$$');
      if (closeAt >= 0) {
        body.push(text.slice(0, closeAt));
        found = true;
        nextLine += 1;
        break;
      }
      body.push(text);
    }
    if (!found) return false;
    token.content = body.join('\n').trim();
    token.markup = '$$';
    token.map = [startLine, nextLine];
    state.line = nextLine;
    return true;
  };

  md.inline.ruler.before('escape', 'math_inline', inlineRule);
  md.block.ruler.before('fence', 'math_block', blockRule, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.renderer.rules.math_inline = (tokens, idx) => renderMathInline(tokens[idx].content);
  md.renderer.rules.math_block = (tokens, idx) => {
    const tex = tokens[idx].content;
    return `<div class="md-math-block md-rawblock md-end-block" data-tex="${escapeHtml(tex)}">` +
      `<div class="md-rawblock-container md-math-container math-jax-preprocess">\\[${escapeHtml(tex)}\\]</div></div>\n`;
  };
}

export function installHighlight(md) {
  md.options.highlight = (code, lang) => {
    if (lang && highlightjs.getLanguage(lang)) {
      return highlightjs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }
    return escapeHtml(code);
  };
}

export default createMarkdownIt;
