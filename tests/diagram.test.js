import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.TYPORA_THEME_DIR = path.join(rootDir, 'tests', 'fixtures', 'themes', 'user');
process.env.TYPORA_BUILTIN_THEME_DIR = path.join(rootDir, 'tests', 'fixtures', 'themes', 'builtin');

const { app } = await import('../src/server/index.js');
import { DIAGRAM_LANGS, MERMAID_LANGS, FLOW_LANGS, SEQUENCE_LANGS } from '../src/web/mermaid.js';
const tmpDir = path.join(rootDir, 'tests', '.tmp', 'diagram');

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

const DIAGRAM_SOURCE = [
  '# 图表测试',
  '',
  '```mermaid',
  'graph LR',
  '  A[开始] --> B[结束]',
  '```',
  '',
  '```flow',
  'st=>start: Start',
  'op=>operation: Operation',
  'e=>end',
  'st->op->e',
  '```',
  '',
  '```sequence',
  'Alice->Bob: 你好',
  'Bob-->Alice: 收到',
  '```',
  ''
].join('\n');

test('图表语言集合划分与 Typora 实现一致', () => {
  assert.deepEqual([...MERMAID_LANGS], ['mermaid']);
  assert.ok(FLOW_LANGS.has('flow'));
  assert.ok(SEQUENCE_LANGS.has('sequence'));
  for (const lang of ['mermaid', 'flow', 'sequence']) {
    assert.ok(DIAGRAM_LANGS.has(lang));
  }
});

test('渲染管线为三类图表输出 md-diagram 容器', async () => {
  const { renderMarkdown } = await import('../src/server/render.js');
  const { body } = renderMarkdown(DIAGRAM_SOURCE);
  assert.equal((body.match(/class="md-diagram md-fences-advanced/g) || []).length, 3);
  assert.match(body, /lang="mermaid"/);
  assert.match(body, /lang="flow"/);
  assert.match(body, /lang="sequence"/);
});

test('导出 HTML 固化三类图表并移除围栏源码', async () => {
  await mkdir(tmpDir, { recursive: true });
  const target = path.join(tmpDir, 'diagrams.html');
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/export/html`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: DIAGRAM_SOURCE, theme: 'github', outPath: target })
      });
      assert.equal(response.status, 200);
    });

    const html = await readFile(target, 'utf8');
    assert.equal((html.match(/md-diagram-rendered/g) || []).length, 3, '三类图表都应渲染成功');
    assert.equal((html.match(/<svg/g) || []).length, 3, '每个图表都应产出 SVG');
    assert.ok(!html.includes('md-diagram-source'), '围栏源码应被移除');
    assert.ok(!html.includes('st=&gt;start'), 'flow 源码应被移除');
    assert.ok(!html.includes('Alice-&gt;Bob'), 'sequence 源码应被移除');
    assert.ok(!html.includes('/theme-assets/'), '主题资源应内嵌');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('导出 HTML 内嵌主题字体资源', async () => {
  await mkdir(tmpDir, { recursive: true });
  const target = path.join(tmpDir, 'fonts.html');
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/export/html`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: '# 字体\n', theme: 'github', outPath: target })
      });
      assert.equal(response.status, 200);
    });
    const html = await readFile(target, 'utf8');
    assert.ok(html.includes('data:font/woff2;base64'), 'github 主题字体应内嵌为 data URI');
    assert.ok(!html.includes('@include-when-export'), '导出时应转换为标准 @import');
    assert.ok(html.includes('@import url("https://fonts.googleapis.com/css?family=Open+Sans'), '导出时应保留外链字体引入');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('导出 PDF 固化公式与图表', async () => {
  await mkdir(tmpDir, { recursive: true });
  const target = path.join(tmpDir, 'diagrams.pdf');
  const source = `# 公式图表\n\n行内公式 $E = mc^2$。\n\n$$\n\\frac{a}{b} = c\n$$\n\n\`\`\`mermaid\ngraph LR\n  A[开始] --> B[结束]\n\`\`\`\n`;
  try {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/export/pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, theme: 'github', outPath: target })
      });
      assert.equal(response.status, 200);
    });
    const buffer = await readFile(target);
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    assert.ok(buffer.length > 10_000);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
