import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from '../src/server/index.js';
import { parseBlocks } from '../src/server/blocks.js';
import { replaceRange } from '../src/web/inplace.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withServer(run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const SAMPLE = [
  '# 标题',
  '',
  '普通段落。',
  '',
  '> [!NOTE]',
  '> 提示内容',
  '',
  '- [ ] 待办',
  '- [x] 完成',
  '',
  '```mermaid',
  'graph LR',
  '  A --> B',
  '```',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '---',
  ''
].join('\n');

test('块级解析按顶层结构拆分并保留源码区间', () => {
  const { blocks, lineCount } = parseBlocks(SAMPLE);
  assert.equal(lineCount, SAMPLE.split('\n').length);
  assert.ok(blocks.length >= 7);

  const types = blocks.map((block) => block.type.split(' ')[0]);
  for (const expected of ['heading', 'paragraph', 'alert', 'list', 'diagram', 'math-block', 'hr']) {
    assert.ok(types.includes(expected), `缺少块类型 ${expected}`);
  }

  // 每个块的源码必须与源码文件的行区间一致
  const lines = SAMPLE.split('\n');
  for (const block of blocks) {
    const expected = lines.slice(block.startLine, block.endLine).join('\n');
    assert.equal(block.source, expected, `块 ${block.index} 的源码区间不一致`);
  }
});

test('块级解析为每个块生成渲染结果', () => {
  const { blocks } = parseBlocks(SAMPLE);
  const heading = blocks.find((block) => block.type.startsWith('heading'));
  assert.match(heading.html, /md-end-block md-heading/);

  const diagram = blocks.find((block) => block.type.startsWith('diagram'));
  assert.match(diagram.html, /md-diagram/);

  const math = blocks.find((block) => block.type === 'math-block');
  assert.match(math.html, /md-math-block/);

  const list = blocks.find((block) => block.type.startsWith('list'));
  assert.match(list.html, /md-task-list-item/);
});

test('块级解析正确分组多行块，不产生碎片', () => {
  const source = '```js\nconst a = 1;\nconst b = 2;\n```\n\n段落\n';
  const { blocks } = parseBlocks(source);
  const codeBlock = blocks.find((block) => block.type.startsWith('code'));
  assert.ok(codeBlock.source.includes('const a = 1;'));
  assert.ok(codeBlock.source.includes('const b = 2;'));
  assert.ok(codeBlock.source.startsWith('```js'));
  assert.ok(codeBlock.source.trimEnd().endsWith('```'));
});

test('POST /api/render-blocks 返回源码与渲染结果', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/render-blocks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: SAMPLE })
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.ok(Array.isArray(payload.blocks));
    assert.ok(payload.blocks.length >= 7);
    const paragraph = payload.blocks.find((block) => block.type === 'paragraph');
    assert.equal(paragraph.source, '普通段落。');
    assert.match(paragraph.html, /md-end-block md-p/);
    assert.equal(typeof payload.lineCount, 'number');
  });
});

test('块源码替换保持文档其余部分不变', () => {
  const source = '# 标题\n\n第一段\n\n第二段\n';
  const { blocks } = parseBlocks(source);
  const second = blocks.find((block) => block.source === '第二段');
  const updated = replaceRange(source, second.startLine, second.endLine, '改写内容');
  assert.match(updated, /# 标题/);
  assert.match(updated, /第一段/);
  assert.match(updated, /改写内容/);
  assert.ok(!updated.includes('第二段'));
});

test('块源码替换支持拆分为多个段落', () => {
  const source = '# 标题\n\n单段内容\n';
  const { blocks } = parseBlocks(source);
  const paragraph = blocks.find((block) => block.type === 'paragraph');
  const updated = replaceRange(source, paragraph.startLine, paragraph.endLine, '前半\n\n后半');
  const reparsed = parseBlocks(updated);
  const paragraphs = reparsed.blocks.filter((block) => block.type === 'paragraph');
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0].source, '前半');
  assert.equal(paragraphs[1].source, '后半');
});
