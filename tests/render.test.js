import test from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown, renderDocument } from '../src/server/render.js';

test('标题输出 Typora 的 md-heading 契约类名', () => {
  const { body } = renderMarkdown('# 标题一\n\n## 标题二\n');
  assert.match(body, /<h1 class="md-end-block md-heading" tabindex="-1">/);
  assert.match(body, /<h2 class="md-end-block md-heading" tabindex="-1">/);
});

test('段落输出 md-end-block md-p 类名', () => {
  const { body } = renderMarkdown('普通段落。\n');
  assert.match(body, /<p class="md-end-block md-p">普通段落。<\/p>/);
});

test('行内语法覆盖加粗、斜体、删除线、高亮、上下标与 Emoji', () => {
  const { body } = renderMarkdown('**粗** *斜* ~~删~~ ==亮== H~2~O X^2^ :smile:\n');
  assert.match(body, /<strong>粗<\/strong>/);
  assert.match(body, /<em>斜<\/em>/);
  assert.match(body, /<s>删<\/s>/);
  assert.match(body, /<mark>亮<\/mark>/);
  assert.match(body, /H<sub>2<\/sub>O/);
  assert.match(body, /X<sup>2<\/sup>/);
  assert.match(body, /<span class="md-emoji">😄<\/span>/);
});

test('任务列表输出 md-task-list-item 与完成状态类名', () => {
  const { body } = renderMarkdown('- [ ] 未完成\n- [x] 已完成\n');
  assert.match(body, /class="md-list-item task-list-item md-task-list-item task-list-not-done md-task-list-not-done"/);
  assert.match(body, /class="md-list-item task-list-item md-task-list-item task-list-done md-task-list-done"/);
  assert.match(body, /<input type="checkbox" class="task-list-item-checkbox" checked disabled>/);
});

test('围栏代码输出 md-fences 并完成语法高亮', () => {
  const { body } = renderMarkdown('```js\nconst a = 1;\n```\n');
  assert.match(body, /<pre class="md-fences mock-cm md-end-block" lang="js">/);
  assert.match(body, /hljs-keyword/);
});

test('mermaid 围栏输出 md-diagram 容器', () => {
  const { body } = renderMarkdown('```mermaid\ngraph LR\n  A --> B\n```\n');
  assert.match(body, /class="md-diagram md-fences-advanced md-fences md-end-block" lang="mermaid"/);
  assert.match(body, /class="md-diagram-panel-preview"/);
  assert.match(body, /class="md-diagram-source"/);
});

test('表格输出 md-table-fig 与 td-span 单元格', () => {
  const { body } = renderMarkdown('| a | b |\n| :- | -: |\n| 1 | 2 |\n');
  assert.match(body, /<figure class="md-table-fig table-figure">/);
  assert.match(body, /<span class="td-span" contenteditable="true">a<\/span>/);
});

test('块级公式输出 md-math-block 结构', () => {
  const { body } = renderMarkdown('$$\nE = mc^2\n$$\n');
  assert.match(body, /class="md-math-block md-rawblock md-end-block"/);
  assert.match(body, /class="md-rawblock-container md-math-container math-jax-preprocess"/);
});

test('行内公式输出 md-inline-math 结构', () => {
  const { body } = renderMarkdown('公式 $a^2+b^2=c^2$ 结束\n');
  assert.match(body, /class="md-inline-math md-inline-math-container"/);
  assert.match(body, /data-tex="a\^2\+b\^2=c\^2"/);
});

test('callout 提示块输出 md-alert 容器并移除标记行', () => {
  const { body } = renderMarkdown('> [!NOTE]\n> 提示正文\n');
  assert.match(body, /<div class="md-alert md-alert-note">/);
  assert.match(body, /class="md-alert-title md-alert-text-note">Note<\/p>/);
  assert.match(body, /提示正文/);
  assert.doesNotMatch(body, /\[!NOTE\]/);
  assert.match(body, /<\/div>/);
});

test('YAML Front Matter 输出 md-meta-block', () => {
  const { body, frontMatter } = renderMarkdown('---\ntitle: 文档标题\n---\n\n正文\n');
  assert.match(body, /<pre class="md-meta-block md-end-block">title: 文档标题<\/pre>/);
  assert.equal(frontMatter, 'title: 文档标题');
});

test('[TOC] 输出 md-toc 结构并包含各级标题', () => {
  const source = '[TOC]\n\n# 一级\n\n## 二级\n';
  const { body } = renderMarkdown(source);
  assert.match(body, /class="md-toc md-end-block"/);
  assert.match(body, /class="md-toc-item md-toc-h1"/);
  assert.match(body, /class="md-toc-item md-toc-h2"/);
  assert.doesNotMatch(body, /\[TOC\]/);
});

test('图片输出 md-image 包裹结构', () => {
  const { body } = renderMarkdown('![说明](./a.png "标题")\n');
  assert.match(body, /class="md-image md-img-loaded"/);
  assert.match(body, /<img src="\.\/a\.png" alt="说明" title="标题">/);
});

test('定义列表、脚注与分隔线均按契约输出', () => {
  const { body } = renderMarkdown('术语\n: 定义\n\n脚注[^1]\n\n[^1]: 内容\n\n---\n');
  assert.match(body, /<dl>/);
  assert.match(body, /<dt>术语<\/dt>/);
  assert.match(body, /footnote-ref/);
  assert.match(body, /class="md-hr md-end-block"/);
});

test('引用块保持 blockquote 结构', () => {
  const { body } = renderMarkdown('> 普通引用\n');
  assert.match(body, /<blockquote class="md-end-block">/);
  assert.doesNotMatch(body, /md-alert/);
});

test('renderDocument 生成完整文档并包含 #write 容器', () => {
  const html = renderDocument({ source: '# 标题\n', css: 'body{color:red}', title: '测试' });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<title>测试<\/title>/);
  assert.match(html, /body\{color:red\}/);
  assert.match(html, /<div id="write" class="write" role="textbox"/);
});
