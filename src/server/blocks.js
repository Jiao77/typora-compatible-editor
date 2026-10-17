import { markdownIt } from './render.js';
import { DIAGRAM_LANGS } from './mdit/index.js';

// 把整篇 Markdown 拆成顶层块，每个块携带源码区间与渲染结果
// 就地编辑依赖这份结构：非活动块显示渲染结果，活动块显示源码

// 按 token 的嵌套层级成组，保证 open 与 close 落在同一组内
function groupTopLevel(tokens) {
  const groups = [];
  let current = null;
  let depth = 0;

  for (const token of tokens) {
    if (!current) {
      if (token.level !== 0) continue;
      current = { tokens: [], start: null, end: null };
      groups.push(current);
    }

    current.tokens.push(token);

    if (token.map) {
      if (current.start === null) current.start = token.map[0];
      current.end = Math.max(current.end ?? 0, token.map[1]);
    }

    depth += token.nesting || 0;
    if (depth <= 0) {
      current = null;
      depth = 0;
    }
  }

  return groups.filter((group) => group.start !== null && group.end !== null);
}

// 根据 token 列表推断块类型，供前端与主题样式使用
function detectType(group) {
  if (!group || group.length === 0) return 'empty';
  if (group.some((t) => t.type === 'toc')) return 'toc';
  const first = group[0];
  switch (first.type) {
    case 'heading_open':
      return 'heading heading-' + Number(first.tag.slice(1));
    case 'fence': {
      const lang = (first.info || '').trim().split(/\s+/)[0];
      if (DIAGRAM_LANGS.has(lang)) return 'diagram diagram-' + lang;
      return 'code code-' + (lang || 'text');
    }
    case 'code_block':
      return 'code code-text';
    case 'math_block':
      return 'math-block';
    case 'table_open':
      return 'table';
    case 'blockquote_open':
      return first.meta && first.meta.alertType ? 'alert alert-' + first.meta.alertType : 'quote';
    case 'bullet_list_open':
      return 'list list-unordered';
    case 'ordered_list_open':
      return 'list list-ordered';
    case 'hr':
      return 'hr';
    case 'html_block':
      return 'html';
    case 'front_matter':
      return 'meta';
    case 'toc':
      return 'toc';
    case 'paragraph_open':
      return 'paragraph';
    case 'dl_open':
      return 'deflist';
    default:
      return 'block';
  }
}

export function parseBlocks(source, env = {}) {
  const text = String(source ?? '');
  // env 必须在 parse 与 render 之间共享，脚注等插件依赖它
  const tokens = markdownIt.parse(text, env);
  const footnoteBlockIndex = tokens.findIndex((t) => t.type === 'footnote_block_open');
  const bodyTokens = footnoteBlockIndex >= 0 ? tokens.slice(0, footnoteBlockIndex) : tokens;
  const footnotesHtml = footnoteBlockIndex >= 0
    ? markdownIt.renderer.render(tokens.slice(footnoteBlockIndex), markdownIt.options, env)
    : '';
  const lines = text.split('\n');
  const parsedGroups = groupTopLevel(bodyTokens);

  if (footnoteBlockIndex >= 0) {
    const footnoteCloseIndex = tokens.findIndex((t) => t.type === 'footnote_block_close');
    let currentFootnote = null;
    let footnoteIndex = 0;
    for (let i = footnoteBlockIndex + 1; i < footnoteCloseIndex; i++) {
      const token = tokens[i];
      if (token.type === 'footnote_open') {
        currentFootnote = {
          tokens: [],
          start: null,
          end: null,
          footnoteIndex: footnoteIndex++
        };
      } else if (token.type === 'footnote_close') {
        if (currentFootnote && currentFootnote.start !== null && currentFootnote.end !== null) {
          parsedGroups.push(currentFootnote);
        }
        currentFootnote = null;
      } else if (currentFootnote) {
        currentFootnote.tokens.push(token);
        if (token.map) {
          if (currentFootnote.start === null) currentFootnote.start = token.map[0];
          currentFootnote.end = Math.max(currentFootnote.end ?? 0, token.map[1]);
        }
      }
    }
  }

  parsedGroups.sort((a, b) => a.start - b.start);

  const mergedGroups = [];
  let currentLine = 0;

  for (const group of parsedGroups) {
    while (currentLine < group.start) {
      mergedGroups.push({
        start: currentLine,
        end: currentLine + 1,
        tokens: [],
        isEmpty: true
      });
      currentLine += 1;
    }
    mergedGroups.push(group);
    currentLine = Math.max(currentLine, group.end);
  }

  while (currentLine < lines.length) {
    mergedGroups.push({
      start: currentLine,
      end: currentLine + 1,
      tokens: [],
      isEmpty: true
    });
    currentLine += 1;
  }

  // 空文档至少保留一个空行块
  if (mergedGroups.length === 0 && lines.length === 0) {
    mergedGroups.push({
      start: 0,
      end: 0,
      tokens: [],
      isEmpty: true
    });
  }

  const blocks = mergedGroups.map((group, index) => {
    const startLine = group.start;
    const endLine = group.end;
    const isE = Boolean(group.isEmpty);
    const sourceText = lines.slice(startLine, endLine).join('\n');
    const isBlank = sourceText.trim() === '';
    const taskLines = (group.tokens || [])
      .filter((t) => t.type === 'list_item_open' && t.meta && t.meta.taskMarker && t.map)
      .map((t) => t.map[0] + 1);

    let type = 'block';
    let html = '';
    if (isE) {
      if (isBlank) {
        type = 'empty';
        html = '<div class="md-empty-line md-end-block"></div>';
      } else {
        type = 'definition';
        html = '<div class="md-definition md-end-block" style="display:none"></div>';
      }
    } else {
      type = group.footnoteIndex !== undefined ? 'footnote' : detectType(group.tokens);
      html = markdownIt.renderer.render(group.tokens, markdownIt.options, env);
    }

    const footnoteRefs = (group.tokens || [])
      .filter((t) => t.type === 'inline' && Array.isArray(t.children))
      .flatMap((t) => t.children.filter((c) => c.type === 'footnote_ref' && c.meta).map((c) => ({ ...c.meta })));

    return {
      index,
      startLine,
      endLine,
      source: sourceText,
      html,
      type,
      taskLines: taskLines.length > 0 ? taskLines : undefined,
      footnoteRefs: footnoteRefs.length > 0 ? footnoteRefs : undefined,
      footnoteIndex: group.footnoteIndex
    };
  });

  return { blocks, lineCount: lines.length, footnotesHtml };
}

export default parseBlocks;
