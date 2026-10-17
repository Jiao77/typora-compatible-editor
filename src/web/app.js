import { InPlaceEditor } from './inplace.js';
import { resolveDocumentImages, formatMarkdownImage, encodeMarkdownPath } from './document-images.js';
import { SearchCursor } from '@codemirror/search';
import { bindImageContextMenu } from './image-actions.js';

// Typora 式单栏编辑器：整篇文档就地渲染，光标所在块显示 Markdown 源码

const state = {
  themes: [],
  settings: {},
  currentTheme: 'github',
  currentPath: null,
  dirty: false,
  sourceMode: false,
  recent: [],
  searchMatches: [],
  searchIndex: -1
};

const elements = {
  docRoot: document.querySelector('#document'),
  docTitle: document.querySelector('#doc-title'),
  docState: document.querySelector('#doc-state'),
  status: document.querySelector('#status'),
  wordCount: document.querySelector('#word-count'),
  sidebar: document.querySelector('#sidebar'),
  outline: document.querySelector('#outline'),
  recent: document.querySelector('#recent'),
  themeMenu: document.querySelector('#theme-menu'),
  exportMenu: document.querySelector('#export-menu'),
  searchBar: document.querySelector('#search-bar'),
  searchInput: document.querySelector('#search-input'),
  searchResult: document.querySelector('#search-result'),
  uploadInput: document.querySelector('#upload-images'),
  buttons: {
    sidebar: document.querySelector('#btn-sidebar'),
    source: document.querySelector('#btn-source'),
    settings: document.querySelector('#btn-settings'),
    search: document.querySelector('#btn-search'),
    open: document.querySelector('#btn-open'),
    saveAs: document.querySelector('#btn-save-as'),
    theme: document.querySelector('#btn-theme'),
    export: document.querySelector('#btn-export'),
    image: document.querySelector('#btn-image'),
    searchNext: document.querySelector('#search-next'),
    searchClose: document.querySelector('#search-close')
  }
};

let editor = null;

let statusTimer = null;
function setStatus(message, kind = 'info') {
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  elements.status.textContent = message || '';
  if (!message) {
    delete elements.status.dataset.kind;
    return;
  }
  elements.status.dataset.kind = kind;
  if (kind === 'ok') {
    statusTimer = setTimeout(() => {
      elements.status.textContent = '';
      delete elements.status.dataset.kind;
      statusTimer = null;
    }, 2600);
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`接口返回非 JSON 内容：${url}`);
    }
  }
  if (!response.ok) {
    throw new Error((payload && payload.error) || `请求失败：${url} 状态码 ${response.status}`);
  }
  return payload;
}

function getSource() {
  if (state.sourceMode) {
    const textarea = elements.docRoot.querySelector('#source-editor');
    return textarea ? textarea.value : '';
  }
  return editor ? editor.getSource() : '';
}

// 文档标题与字数随内容更新
function updateDocumentMeta() {
  const source = getSource();
  const title = state.currentPath
    ? state.currentPath.split('/').pop()
    : (source.split('\n').find((line) => line.startsWith('# ')) || '').replace(/^#\s*/, '') || '未命名文档';
  elements.docTitle.textContent = title;
  elements.docState.textContent = state.dirty ? '●' : '';
  // 中文字符与英文单词分别计数
  const chinese = (source.match(/[\u4e00-\u9fa5]/g) || []).length;
  const words = (source.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
  elements.wordCount.textContent = `${chinese + words} 字`;
  updateOutline();
}

// 侧边栏大纲：从渲染结果提取标题
function updateOutline() {
  elements.outline.innerHTML = '';
  const headings = [...document.querySelectorAll('#document :is(h1,h2,h3,h4,h5,h6)')];
  if (headings.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'recent-item';
    empty.textContent = '暂无标题';
    elements.outline.append(empty);
    return;
  }
  for (const heading of headings) {
    const level = Number(heading.tagName.slice(1));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outline-item';
    button.dataset.level = String(level);
    button.textContent = heading.textContent.trim();
    button.addEventListener('click', () => heading.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    elements.outline.append(button);
  }
}

async function loadThemes() {
  const payload = await requestJson('/api/themes');
  state.themes = payload.themes;
  renderThemeMenu();
  return payload.themes;
}

function renderThemeMenu() {
  elements.themeMenu.innerHTML = '';
  for (const theme of state.themes) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'popover-item';
    item.dataset.theme = theme.id;
    item.setAttribute('role', 'option');
    const label = document.createElement('span');
    label.textContent = theme.id;
    item.append(label);
    if (theme.id === state.currentTheme) item.classList.add('is-selected');
    item.addEventListener('click', async () => {
      hidePopovers();
      await switchTheme(theme.id);
    });
    elements.themeMenu.append(item);
  }
}

async function switchTheme(themeId) {
  try {
    await applyTheme(themeId);
    if (!state.sourceMode && editor) {
      editor.setTheme(themeId);
      await editor.load(getSource());
    }
    renderThemeMenu();
    updateDocumentMeta();
    setStatus(`已切换主题：${themeId}`, 'ok');
  } catch (error) {
    setStatus(`主题切换失败：${error.message}`, 'error');
  }
}

async function applyTheme(themeId) {
  const response = await fetch(`/api/themes/${encodeURIComponent(themeId)}/css`);
  if (!response.ok) throw new Error(`主题加载失败：${themeId}`);
  const css = await response.text();
  let style = document.querySelector('#typora-theme');
  if (!style) {
    style = document.createElement('style');
    style.id = 'typora-theme';
    document.head.append(style);
  }
  style.textContent = css;
  document.body.dataset.theme = themeId;
  document.body.dataset.shell = /night|dark/i.test(themeId) ? 'dark' : 'light';
  state.currentTheme = themeId;
}

async function loadSettings() {
  state.settings = await requestJson('/api/settings');
  const initial = normalizeThemeName(state.settings.theme || 'github');
  const available = state.themes.some((theme) => theme.id === initial);
  state.currentTheme = available ? initial : 'github';
  await applyTheme(state.currentTheme);
  return state.settings;
}

function normalizeThemeName(value) {
  return String(value)
    .replace(/\s*([A-Z])/g, '-$1')
    .replace(/^-/, '')
    .toLowerCase()
    .replace(/\.css$/, '');
}

const WELCOME_DOC = `# 欢迎使用 TYPOAR

本编辑器采用 Typora 式就地渲染：点击或移动光标至目标行即可编辑，其余内容保持最终排版。

## 数学公式

行内公式 $E = mc^2$，块级公式：

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$

## Mermaid 图表

\`\`\`mermaid
graph LR
  A[开始] --> B{判断}
  B -->|是| C[结束]
  B -->|否| A
\`\`\`

## 表格与任务列表

| 功能 | 状态 |
| :--- | :--: |
| 主题迁移 | 完成 |
| 就地渲染 | 完成 |

- [x] 加载 Typora 主题
- [ ] 导出 PDF

## 其他语法

> [!NOTE]
> 这里演示提示块语法。

~~删除线~~、==高亮==、H~2~O、X^2^、:smile:、脚注[^1]。

[^1]: 这是脚注内容。

[TOC]
`;

function createInPlaceEditor() {
  return new InPlaceEditor({
    root: elements.docRoot,
    theme: state.currentTheme,
    documentPath: state.currentPath,
    onChange: () => {
      state.dirty = true;
      if (window.desktop && window.desktop.reportDirtyState) {
        window.desktop.reportDirtyState(true);
      }
      updateDocumentMeta();
      if (state.settings.autoSave && state.currentPath) scheduleAutoSave();
    },
    onStatus: (message, kind) => {
      if (message) setStatus(message, kind || 'info');
    }
  });
}

let autoSaveTimer = null;
function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  const delay = Number(state.settings.autoSaveDelay || 5) * 1000;
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    saveToPath(state.currentPath, { silent: true });
  }, delay);
}

// 打开与保存优先使用原生对话框，浏览器环境回退到路径输入
async function pickOpenPath() {
  if (window.desktop) return window.desktop.openMarkdown();
  return window.prompt('请输入要打开的 Markdown 文件绝对路径');
}

async function pickSavePath(defaultPath) {
  if (window.desktop) return window.desktop.saveMarkdown(defaultPath);
  return window.prompt('请输入保存路径（绝对路径）', defaultPath || '');
}

async function pickExportPath(format) {
  const fallback = `${state.currentPath ? state.currentPath.replace(/\.md$/, '') : '未命名文档'}.${format === 'mediawiki' ? 'wiki' : format}`;
  if (window.desktop) return window.desktop.saveExport({ format, defaultPath: fallback });
  return window.prompt(`请输入导出文件绝对路径（.${format}）`, fallback);
}

async function handleOpen() {
  try {
    const target = await pickOpenPath();
    if (!target) return;
    await openFile(target);
  } catch (error) {
    setStatus(`打开失败：${error.message}`, 'error');
  }
}

async function openFile(target) {
  const payload = await requestJson('/api/file/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: target })
  });
  state.sourceMode = false;
  state.currentPath = payload.path;
  if (editor) editor.dispose();
  editor = createInPlaceEditor();
  editor.setTheme(state.currentTheme);
  if (typeof editor.setDocumentPath === 'function') {
    editor.setDocumentPath(payload.path);
  }
  await editor.load(payload.content);
  state.dirty = false;
  if (window.desktop && window.desktop.reportDirtyState) {
    window.desktop.reportDirtyState(false);
  }
  pushRecent(payload.path);
  updateDocumentMeta();
}

async function saveToPath(target, { silent = false } = {}) {
  if (!target) return null;
  const payload = await requestJson('/api/file/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: target, content: getSource() })
  });
  state.currentPath = payload.path;
  if (editor && typeof editor.setDocumentPath === 'function') {
    editor.setDocumentPath(payload.path);
  }
  state.dirty = false;
  if (window.desktop && window.desktop.reportDirtyState) {
    window.desktop.reportDirtyState(false);
  }
  pushRecent(payload.path);
  updateDocumentMeta();
  if (!silent) setStatus(`已保存，共 ${payload.size} 字节`, 'ok');
  return payload;
}

// 保存当前文档并在成功后请求主进程关闭窗口
async function saveThenClose() {
  try {
    if (state.currentPath) {
      await saveToPath(state.currentPath, { silent: true });
    } else {
      const target = await pickSavePath('未命名文档.md');
      if (!target) {
        setStatus('已取消保存', 'warn');
        return;
      }
      await saveToPath(target, { silent: true });
    }
    if (window.desktop && window.desktop.confirmClose) {
      window.desktop.confirmClose();
    }
  } catch (error) {
    setStatus(`保存失败，窗口保持打开：${error.message}`, 'error');
  }
}

async function handleSave() {
  try {
    if (state.currentPath) {
      await saveToPath(state.currentPath);
      return;
    }
    await handleSaveAs();
  } catch (error) {
    setStatus(`保存失败：${error.message}`, 'error');
  }
}

async function handleSaveAs() {
  try {
    const suggested = state.currentPath || '未命名文档.md';
    const target = await pickSavePath(suggested);
    if (!target) return;
    await saveToPath(target);
  } catch (error) {
    setStatus(`另存失败：${error.message}`, 'error');
  }
}

function pushRecent(target) {
  state.recent = [target, ...state.recent.filter((item) => item !== target)].slice(0, 12);
  renderRecent();
}

function renderRecent() {
  elements.recent.innerHTML = '';
  if (state.recent.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'recent-item';
    empty.textContent = '暂无最近文件';
    elements.recent.append(empty);
    return;
  }
  for (const target of state.recent) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'recent-item';
    item.textContent = target.split('/').pop();
    item.title = target;
    item.addEventListener('click', () => openFile(target).catch((error) => setStatus(`打开失败：${error.message}`, 'error')));
    elements.recent.append(item);
  }
}

async function handleExport(format) {
  try {
    const target = await pickExportPath(format);
    if (!target) return;
    setStatus(`正在导出 ${format} …`, 'info');
    const endpoint = format === 'pdf'
      ? '/api/export/pdf'
      : format === 'html' ? '/api/export/html' : '/api/export/pandoc';
    const body = format === 'pdf' || format === 'html'
      ? {
        source: getSource(),
        theme: state.currentTheme,
        title: state.currentPath || '未命名文档',
        outPath: target,
        pageSize: state.settings.pageSize,
        margin: state.settings.margin
      }
      : { source: getSource(), to: format, outPath: target };
    const payload = await requestJson(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    setStatus(`导出成功：${payload.outPath.split('/').pop()}（${payload.size} 字节）`, 'ok');
    if (window.desktop && format !== 'pdf') window.desktop.showItemInFolder(payload.outPath);
  } catch (error) {
    setStatus(`导出失败：${error.message}`, 'error');
  }
}

// formatMarkdownImage 与 encodeMarkdownPath 统一由 document-images.js 导出

async function handleUpload(files) {
  if (!files || files.length === 0) return;
  const form = new FormData();
  for (const file of files) form.append('files', file);
  form.append('uploader', state.settings.image_uploader || 'ipic');
  form.append('documentDir', state.currentPath || '');

  setStatus(`正在上传 ${files.length} 个文件 …`, 'info');
  try {
    const response = await fetch('/api/images/upload', { method: 'POST', body: form });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '上传失败');
    const markdown = payload.results.map((item) => formatMarkdownImage(item.filename, item.url)).join('\n\n');
    await insertText(`\n${markdown}\n`);
    setStatus(`上传完成，插入 ${payload.results.length} 个图片引用`, 'ok');
  } catch (error) {
    setStatus(`上传失败：${error.message}`, 'error');
  }
}

// 通过原生对话框选择图片后再上传
async function handleInsertImage() {
  if (window.desktop) {
    try {
      const paths = await window.desktop.chooseImages();
      if (!paths || paths.length === 0) return;
      // 原生对话框返回的是绝对路径，使用 formatMarkdownImage 支持中文与特殊路径
      const markdown = paths.map((target) => formatMarkdownImage(target.split('/').pop(), target)).join('\n\n');
      await insertText(`\n${markdown}\n`);
      setStatus(`已插入 ${paths.length} 个图片引用`, 'ok');
      return;
    } catch (error) {
      setStatus(`插入图片失败：${error.message}`, 'error');
      return;
    }
  }
  elements.uploadInput.click();
}

async function toggleSourceMode() {
  if (!state.sourceMode) {
    const source = getSource();
    if (editor) {
      editor.dispose();
      editor = null;
    }
    state.sourceMode = true;
    const textarea = document.createElement('textarea');
    textarea.id = 'source-editor';
    textarea.spellcheck = false;
    textarea.value = source;
    textarea.addEventListener('input', () => {
      state.dirty = true;
      if (window.desktop && window.desktop.reportDirtyState) {
        window.desktop.reportDirtyState(true);
      }
      updateDocumentMeta();
      if (state.settings.autoSave && state.currentPath) scheduleAutoSave();
    });
    elements.docRoot.replaceChildren(textarea);
    textarea.focus();
    elements.buttons.source.classList.add('is-active');
    setStatus('源码模式', 'info');
    return;
  }

  const textarea = elements.docRoot.querySelector('#source-editor');
  const source = textarea ? textarea.value : '';
  state.sourceMode = false;
  editor = createInPlaceEditor();
  editor.setTheme(state.currentTheme);
  if (typeof editor.setDocumentPath === 'function') {
    editor.setDocumentPath(state.currentPath);
  }
  await editor.load(source);
  elements.buttons.source.classList.remove('is-active');
  state.dirty = true;
  updateDocumentMeta();
  setStatus('已切换到就地渲染', 'ok');
}

// 在当前块插入文本；没有活动块时追加到文档末尾
async function insertText(text, { wrap } = {}) {
  if (state.sourceMode) {
    const textarea = elements.docRoot.querySelector('#source-editor');
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const selected = textarea.value.slice(start, end);
      const insertion = wrap ? `${wrap[0]}${selected}${wrap[1]}` : text;
      textarea.value = textarea.value.slice(0, start) + insertion + textarea.value.slice(end);
      textarea.selectionStart = textarea.selectionEnd = start + insertion.length;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }
  if (editor && editor.blockEditor) {
    const view = editor.blockEditor;
    const { from, to } = view.state.selection.main;
    const selected = view.state.doc.sliceString(from, to);
    const insertion = wrap ? `${wrap[0]}${selected}${wrap[1]}` : text;
    view.dispatch({ changes: { from, to, insert: insertion }, selection: { anchor: from + insertion.length } });
    view.focus();
    state.dirty = true;
    if (window.desktop && window.desktop.reportDirtyState) {
      window.desktop.reportDirtyState(true);
    }
    updateDocumentMeta();
    if (state.settings.autoSave && state.currentPath) scheduleAutoSave();
    return;
  }
  const source = `${getSource()}\n${text}\n`;
  if (editor) editor.dispose();
  editor = createInPlaceEditor();
  editor.setTheme(state.currentTheme);
  if (typeof editor.setDocumentPath === 'function') {
    editor.setDocumentPath(state.currentPath);
  }
  await editor.load(source);
  state.dirty = true;
  updateDocumentMeta();
}

// 查找：基于 CodeMirror SearchCursor 或源码 textarea 原生范围匹配，绝不篡改编辑 DOM
function runSearch() {
  const query = elements.searchInput.value.trim();
  state.searchMatches = [];
  state.searchIndex = -1;
  if (!query) {
    elements.searchResult.textContent = '';
    return;
  }

  if (state.sourceMode) {
    const textarea = elements.docRoot.querySelector('#source-editor');
    if (!textarea) return;
    const text = textarea.value;
    const lower = text.toLowerCase();
    const needle = query.toLowerCase();
    let idx = lower.indexOf(needle);
    while (idx !== -1) {
      state.searchMatches.push({ from: idx, to: idx + needle.length });
      idx = lower.indexOf(needle, idx + needle.length);
    }
    elements.searchResult.textContent = state.searchMatches.length
      ? `0/${state.searchMatches.length}`
      : '无结果';
    if (state.searchMatches.length > 0) focusNextMatch();
    return;
  }

  if (editor && editor.blockEditor) {
    const view = editor.blockEditor;
    const cursor = new SearchCursor(view.state.doc, query);
    while (!cursor.next().done) {
      state.searchMatches.push({ from: cursor.value.from, to: cursor.value.to });
    }
    elements.searchResult.textContent = state.searchMatches.length
      ? `0/${state.searchMatches.length}`
      : '无结果';
    if (state.searchMatches.length > 0) focusNextMatch();
    return;
  }

  elements.searchResult.textContent = '无结果';
}

function focusNextMatch() {
  if (state.searchMatches.length === 0) return;
  state.searchIndex = (state.searchIndex + 1) % state.searchMatches.length;
  const match = state.searchMatches[state.searchIndex];
  elements.searchResult.textContent = `${state.searchIndex + 1}/${state.searchMatches.length}`;

  if (state.sourceMode) {
    const textarea = elements.docRoot.querySelector('#source-editor');
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(match.from, match.to);
    }
    return;
  }

  if (editor && editor.blockEditor) {
    const view = editor.blockEditor;
    view.dispatch({
      selection: { anchor: match.from, head: match.to },
      scrollIntoView: true
    });
    view.focus();
  }
}

function hidePopovers() {
  elements.themeMenu.hidden = true;
  elements.exportMenu.hidden = true;
  elements.buttons.theme.classList.remove('is-active');
  elements.buttons.export.classList.remove('is-active');
}

function togglePopover(menu, button) {
  const willShow = menu.hidden;
  hidePopovers();
  if (!willShow) return;
  const rect = button.getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - menu.offsetWidth - 12)}px`;
  menu.style.top = `${rect.top - menu.offsetHeight - 8}px`;
  button.classList.add('is-active');
}

function bindEvents() {
  elements.buttons.sidebar.addEventListener('click', () => {
    const open = elements.sidebar.classList.toggle('is-open');
    elements.buttons.sidebar.classList.toggle('is-active', open);
  });
  elements.buttons.source.addEventListener('click', toggleSourceMode);
  elements.buttons.settings.addEventListener('click', () => {
    if (window.desktop) window.desktop.openSettings();
    else window.open('/settings.html', '_blank', 'width=660,height=620');
  });
  elements.buttons.search.addEventListener('click', () => {
    elements.searchBar.hidden = !elements.searchBar.hidden;
    if (!elements.searchBar.hidden) elements.searchInput.focus();
    else runSearch();
  });
  elements.buttons.searchNext.addEventListener('click', focusNextMatch);
  elements.buttons.searchClose.addEventListener('click', () => {
    elements.searchBar.hidden = true;
    elements.searchInput.value = '';
    runSearch();
  });
  elements.searchInput.addEventListener('input', runSearch);
  elements.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') focusNextMatch();
    if (event.key === 'Escape') elements.buttons.searchClose.click();
  });

  elements.buttons.open.addEventListener('click', handleOpen);
  elements.buttons.saveAs.addEventListener('click', handleSaveAs);
  elements.buttons.image.addEventListener('click', handleInsertImage);
  elements.uploadInput.addEventListener('change', (event) => {
    handleUpload(event.target.files);
    event.target.value = '';
  });

  elements.buttons.theme.addEventListener('click', () => togglePopover(elements.themeMenu, elements.buttons.theme));
  elements.buttons.export.addEventListener('click', () => togglePopover(elements.exportMenu, elements.buttons.export));
  for (const item of elements.exportMenu.querySelectorAll('.popover-item')) {
    item.addEventListener('click', () => {
      const format = item.dataset.format;
      hidePopovers();
      handleExport(format);
    });
  }

  document.addEventListener('mousedown', (event) => {
    if (event.target.closest('.popover') || event.target.closest('.status-button')) return;
    hidePopovers();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hidePopovers();
  });

  // 侧边栏分类切换
  for (const tab of document.querySelectorAll('.sidebar-tab')) {
    tab.addEventListener('click', () => {
      const panel = tab.dataset.panel;
      for (const item of document.querySelectorAll('.sidebar-tab')) item.classList.toggle('is-active', item === tab);
      for (const target of document.querySelectorAll('.sidebar-panel')) {
        target.classList.toggle('is-active', target.dataset.panel === panel);
      }
    });
  }

  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => {
    if (!event.dataTransfer || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    handleUpload(event.dataTransfer.files);
  });

  // 未保存状态上报给主进程，由主进程在关闭时弹原生确认框
  // 不使用 beforeunload，否则窗口无法关闭
  window.addEventListener('beforeunload', () => {
    if (window.desktop && window.desktop.reportDirtyState) {
      window.desktop.reportDirtyState(state.dirty);
    }
  });

  // 原生菜单事件
  if (window.desktop) {
    window.desktop.onMenu((action, payload) => {
      switch (action) {
        case 'open': handleOpen(); break;
        case 'save': handleSave(); break;
        case 'saveAndClose':
          // 保存成功后由主进程关闭窗口；保存失败则保持打开，避免内容丢失
          saveThenClose();
          break;
        case 'export': handleExport(payload); break;
        case 'search':
          elements.searchBar.hidden = false;
          elements.searchInput.focus();
          break;
        case 'format': insertText(payload); break;
        case 'wrap': insertText('', { wrap: payload }); break;
        case 'image': handleInsertImage(); break;
        case 'insert':
          if (payload === 'table') insertText('\n| 列一 | 列二 |\n| :--- | :--- |\n| 内容 | 内容 |\n');
          if (payload === 'math') insertText('\n$$\nE = mc^2\n$$\n');
          if (payload === 'code') insertText('\n```\n\n```\n');
          break;
        case 'source': toggleSourceMode(); break;
        case 'font': {
          const next = Math.min(24, Math.max(12, Number(state.settings.fontSize || 16) + payload));
          state.settings.fontSize = next;
          document.documentElement.style.setProperty('--editor-font-size', `${next}px`);
          setStatus(`正文字号：${next} px`, 'ok');
          break;
        }
        case 'themes': loadThemes().then(() => setStatus('主题列表已刷新', 'ok')); break;
        default: break;
      }
    });
  }
}

async function bootstrap() {
  try {
    await loadThemes();
    await loadSettings();
    document.documentElement.style.setProperty('--editor-font-size', `${state.settings.fontSize || 16}px`);
    editor = createInPlaceEditor();
    bindImageContextMenu({
      container: elements.docRoot,
      getEditor: () => editor,
      getSettings: () => state.settings,
      onStatus: setStatus,
      onOpenSettings: () => elements.buttons.settings.click()
    });
    editor.setTheme(state.currentTheme);
    await editor.load(WELCOME_DOC);
    bindEvents();
    updateDocumentMeta();
  } catch (error) {
    setStatus(`初始化失败：${error.message}`, 'error');
  }
}

bootstrap();

export { getSource };
