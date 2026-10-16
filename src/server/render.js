import {
  createMarkdownIt,
  installMath,
  installHighlight,
  installAlerts,
  installFrontMatter,
  installToc,
  DIAGRAM_LANGS
} from './mdit/index.js';

// Typora 主题 CSS 依赖 #write 容器与 md-* 结构类名，渲染规则严格输出这套契约

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 围栏代码：图表语言输出 md-diagram，普通代码输出 md-fences
function renderFence(tokens, idx, options) {
  const token = tokens[idx];
  const info = (token.info || '').trim();
  const lang = info.split(/\s+/)[0] || '';

  if (DIAGRAM_LANGS.has(lang)) {
    return `<div class="md-diagram md-fences-advanced md-fences md-end-block" lang="${escapeHtml(lang)}">` +
      `<div class="md-diagram-panel"><div class="md-diagram-panel-preview"></div></div>` +
      `<pre class="md-fences mock-cm md-end-block" lang="${escapeHtml(lang)}">` +
      `<code class="md-diagram-source">${escapeHtml(token.content)}</code></pre></div>\n`;
  }

  // 渲染规则的 this 指向规则表，高亮回调必须从 options 参数读取
  const highlighted = options.highlight(token.content, lang);
  const classes = ['md-fences', 'mock-cm', 'md-end-block'];
  if (/\{?lineno/.test(info)) classes.push('md-fences-with-lineno');
  return `<pre class="${classes.join(' ')}" lang="${escapeHtml(lang)}">` +
    `<code class="md-fence-code">${highlighted}</code></pre>\n`;
}

// 表格：外层包裹 figure.md-table-fig，单元格内容包裹 span.td-span
function renderTableOpen() {
  return '<figure class="md-table-fig table-figure"><table>';
}

function renderTableClose() {
  return '</table></figure>';
}

function renderCellOpen(tokens, idx) {
  const token = tokens[idx];
  const tag = token.type === 'th_open' ? 'th' : 'td';
  const style = token.attrs && token.attrs.find((attr) => attr[0] === 'style');
  const styleAttr = style ? ` style="${escapeHtml(style[1])}"` : '';
  return `<${tag}${styleAttr}><span class="td-span" contenteditable="true">`;
}

function renderCellClose(tokens, idx) {
  const tag = tokens[idx].type === 'th_close' ? 'th' : 'td';
  return `</span></${tag}>`;
}

function renderParagraphOpen() {
  return '<p class="md-end-block md-p">';
}

function renderHeadingOpen(tokens, idx) {
  const token = tokens[idx];
  const classes = ['md-end-block', 'md-heading'];
  return `<${token.tag} class="${classes.join(' ')}" tabindex="-1">`;
}

function renderHeadingClose(tokens, idx) {
  return `</${tokens[idx].tag}>`;
}

// 列表项：任务列表项使用 Typora 的 md-task-list-item 与状态类名
function renderListItemOpen(tokens, idx) {
  const token = tokens[idx];
  const classes = ['md-list-item'];
  const marker = token.meta && token.meta.taskMarker;
  if (marker) {
    classes.push('task-list-item', 'md-task-list-item');
    classes.push(marker.done ? 'task-list-done' : 'task-list-not-done');
    classes.push(marker.done ? 'md-task-list-done' : 'md-task-list-not-done');
  }
  return `<li class="${classes.join(' ')}">`;
}

function renderBlockquoteOpen(tokens, idx) {
  const token = tokens[idx];
  const alertType = token.meta && token.meta.alertType;
  if (alertType) {
    const title = alertType.charAt(0).toUpperCase() + alertType.slice(1);
    return `<div class="md-alert md-alert-${alertType}">` +
      `<p class="md-alert-title md-alert-text-${alertType}">${title}</p>\n`;
  }
  return '<blockquote class="md-end-block">';
}

function renderBlockquoteClose(tokens, idx) {
  const alertType = tokens[idx].meta && tokens[idx].meta.alertType;
  return alertType ? '</div>\n' : '</blockquote>\n';
}

function renderHr() {
  return '<div tabindex="-1" contenteditable="false" class="md-hr md-end-block"><hr></div>';
}

function renderSoftbreak() {
  return '<span class="md-softbreak"> </span>';
}

function renderHardbreak() {
  return '<br/>';
}

// 图片：Typora 输出 span.md-image 包裹 img，主题选择器依赖该结构
function renderImage(tokens, idx, options, env, self) {
  const token = tokens[idx];
  const src = token.attrGet('src') || '';
  const title = token.attrGet('title');
  const alt = self.renderInlineAsText(token.children || [], options, env);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<span class="md-image md-img-loaded"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${titleAttr}></span>`;
}

// Emoji token 的内容位于 markup 字段之外，直接取 content
function renderEmoji(tokens, idx) {
  return `<span class="md-emoji">${escapeHtml(tokens[idx].content)}</span>`;
}

export function applyTyporaDom(mdInstance) {
  const renderer = mdInstance.renderer.rules;
  // 自定义规则必须自行遵守 token.hidden，否则紧凑列表的隐藏段落会产生不平衡标签
  const hiddenAware = (rule) => (tokens, idx, options, env, self) =>
    tokens[idx].hidden ? '' : rule(tokens, idx, options, env, self);

  renderer.fence = renderFence;
  renderer.table_open = renderTableOpen;
  renderer.table_close = renderTableClose;
  renderer.th_open = renderCellOpen;
  renderer.td_open = renderCellOpen;
  renderer.th_close = renderCellClose;
  renderer.td_close = renderCellClose;
  renderer.paragraph_open = hiddenAware(renderParagraphOpen);
  renderer.paragraph_close = hiddenAware(() => '</p>');
  renderer.heading_open = renderHeadingOpen;
  renderer.heading_close = renderHeadingClose;
  renderer.list_item_open = renderListItemOpen;
  renderer.blockquote_open = renderBlockquoteOpen;
  renderer.blockquote_close = renderBlockquoteClose;
  renderer.hr = renderHr;
  renderer.softbreak = renderSoftbreak;
  renderer.hardbreak = renderHardbreak;
  renderer.image = renderImage;
  renderer.emoji = renderEmoji;
}

function renderTaskListFix(mdInstance) {
  // 任务列表插件插入原始 HTML checkbox，这里改写为 Typora 契约 token 并记录完成状态
  mdInstance.core.ruler.push('typora_task_list', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.type !== 'inline' || !token.children) continue;

      const checkbox = token.children.find(
        (child) => child.type === 'html_inline' && child.content.includes('task-list-item-checkbox')
      );
      if (!checkbox) continue;

      const checked = /\schecked/.test(checkbox.content);
      checkbox.type = 'task_checkbox';
      checkbox.meta = { checked };
      checkbox.content = '';

      // 记录状态到最近的 list_item_open，供列表项输出 Typora 类名
      for (let j = i; j >= 0; j -= 1) {
        if (tokens[j].type === 'list_item_open') {
          tokens[j].meta = { ...(tokens[j].meta || {}), taskMarker: { done: checked } };
          break;
        }
      }
    }
    return true;
  });

  mdInstance.renderer.rules.task_checkbox = (tokens, idx) => {
    const checked = tokens[idx].meta && tokens[idx].meta.checked;
    return `<input type="checkbox" class="task-list-item-checkbox"${checked ? ' checked' : ''} disabled>`;
  };
}

const md = createMarkdownIt();
installMath(md);
installHighlight(md);
installFrontMatter(md);
installAlerts(md);
installToc(md);
renderTaskListFix(md);
applyTyporaDom(md);

export function renderMarkdown(source) {
  const tokens = md.parse(source, {});
  const body = md.renderer.render(tokens, md.options, {});
  const frontMatterToken = tokens.find((token) => token.type === 'front_matter');
  const meta = frontMatterToken ? frontMatterToken.meta : null;
  const frontMatter = typeof meta === 'string' ? meta : (meta && meta.content) || null;
  return { body, tokens, frontMatter };
}

// 生成完整文档，可供浏览器预览、HTML 导出与 Chrome 打印 PDF 共用
export function renderDocument({ source, css = '', title = '', lang = 'zh-CN', scripts = [] }) {
  const { body } = renderMarkdown(source);
  const scriptTags = scripts.map((src) => `<script src="${escapeHtml(src)}"></script>`).join('\n');
  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body>
<div id="write" class="write" role="textbox" aria-placeholder="Start writing..." aria-multiline="true" contenteditable="false" spellcheck="true" tabindex="-1">
${body}</div>
${scriptTags}
</body>
</html>`;
}

export { md as markdownIt };
