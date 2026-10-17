import test from 'node:test';
import assert from 'node:assert/strict';
import { InPlaceEditor, replaceRange } from '../src/web/inplace.js';
import { parseBlocks } from '../src/server/blocks.js';

test('replaceRange 能精确替换指定行区间并保持换行', () => {
  const source = 'line 1\nline 2\nline 3';
  const res = replaceRange(source, 1, 2, 'replaced');
  assert.equal(res, 'line 1\nreplaced\nline 3');
});

test('TOC 及多行空行时 parseBlocks 正确输出块区间', () => {
  const source = '[TOC]\n\n\n# 标题\n\n段落内容';
  const { blocks, lineCount } = parseBlocks(source);
  assert.equal(lineCount, 6);

  const toc = blocks.find((b) => b.type === 'toc');
  assert.ok(toc);
  assert.equal(toc.startLine, 0);
  assert.equal(toc.endLine, 1);

  const empty = blocks.filter((b) => b.type === 'empty');
  assert.equal(empty.length, 3);
});

test('parseBlocks 支持接收外部 env 以保留引用链接与脚注上下文', () => {
  const source = '[链接文本][ref]\n\n[ref]: https://example.com "示例"';
  const env = {};
  const { blocks } = parseBlocks(source, env);
  assert.ok(blocks.length >= 2);
  assert.ok(env.references && env.references.REF);
  assert.equal(env.references.REF.href, 'https://example.com');
  assert.ok(blocks[0].html.includes('href="https://example.com"'));
});

test('多项任务列表解析后生成精确的 taskLines 映射', () => {
  const source = '- [ ] 第一项\n- [x] 第二项\n- [ ] 第三项';
  const { blocks, lineCount } = parseBlocks(source);
  assert.equal(lineCount, 3);
  assert.ok(blocks.length >= 1);
  const listBlock = blocks.find((b) => b.type.startsWith('list'));
  assert.ok(listBlock);
  assert.match(listBlock.html, /第二项/);
  assert.deepEqual(listBlock.taskLines, [1, 2, 3]);
});

test('嵌套与多行任务列表正确提取各 checkbox 真实源码行号', () => {
  const source = [
    '- [ ] 第一项',
    '  补充描述行',
    '- [x] 第二项',
    '- [ ] 第三项'
  ].join('\n');
  const { blocks, lineCount } = parseBlocks(source);
  assert.equal(lineCount, 4);
  const listBlock = blocks.find((b) => b.type.startsWith('list'));
  assert.ok(listBlock);
  assert.deepEqual(listBlock.taskLines, [1, 3, 4], '第一项在第1行，第二项在第3行，第三项在第4行');
});
