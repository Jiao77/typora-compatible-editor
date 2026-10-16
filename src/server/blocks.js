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

// 根据首个 token 推断块类型，供前端与主题样式使用
function detectType(group) {
  const first = group[0];
  switch (first.type) {
    case 'heading_open':
      return `heading heading-${Number(first.tag.slice(1))}`;
    case 'fence': {
      const lang = (first.info || '').trim().split(/\s+/)[0];
      if (DIAGRAM_LANGS.has(lang)) return `diagram diagram-${lang}`;
      return `code code-${lang || 'text'}`;
    }
    case 'code_block':
      return 'code code-text';
    case 'math_block':
      return 'math-block';
    case 'table_open':
      return 'table';
    case 'blockquote_open':
      return first.meta && first.meta.alertType ? `alert alert-${first.meta.alertType}` : 'quote';
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
    default:
      return 'block';
  }
}

export function parseBlocks(source) {
  const text = String(source ?? '');
  // env 必须在 parse 与 render 之间共享，脚注等插件依赖它
  const env = {};
  const tokens = markdownIt.parse(text, env);
  const lines = text.split('\n');
  const groups = groupTopLevel(tokens);

  const blocks = groups.map((group, index) => {
    const startLine = group.start;
    const endLine = group.end;
    return {
      index,
      startLine,
      endLine,
      source: lines.slice(startLine, endLine).join('\n'),
      html: markdownIt.renderer.render(group.tokens, markdownIt.options, env),
      type: detectType(group.tokens)
    };
  });

  return { blocks, lineCount: lines.length };
}

export default parseBlocks;
