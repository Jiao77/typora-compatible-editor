import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderDocument } from '../src/server/render.js';

test('默认图片输出标准 span.md-image 包裹与 img 基础属性', () => {
  const md = '![默认图](https://example.com/default.png)\n';
  const { body } = renderMarkdown(md);
  assert.match(body, /<span class="md-image md-img-loaded"><img src="https:\/\/example\.com\/default\.png" alt="默认图"><\/span>/);
});

test('不同缩放比例 (25%、50%、75%、100%) 正确输出 width 属性', () => {
  const scales = ['25%', '50%', '75%', '100%'];
  for (const scale of scales) {
    const md = `![缩放图](https://example.com/scale.png){width=${scale}}\n`;
    const { body } = renderMarkdown(md);
    assert.match(body, /class="md-image md-img-loaded"/);
    assert.match(body, new RegExp(`width="${scale}"`));
    assert.match(body, /alt="缩放图"/);
  }
});

test('同一源地址的多张图片具有各自独立的属性与缩放比例', () => {
  const md = [
    '![图一](https://example.com/duplicate.png){width=25%}',
    '',
    '![图二](https://example.com/duplicate.png){width=50%}',
    '',
    '![图三](https://example.com/duplicate.png){width=75%}',
    '',
    '![图四](https://example.com/duplicate.png){width=100%}',
    '',
    '![图五](https://example.com/duplicate.png)'
  ].join('\n');

  const { body } = renderMarkdown(md);
  assert.match(body, /<img src="https:\/\/example\.com\/duplicate\.png" alt="图一" width="25%">/);
  assert.match(body, /<img src="https:\/\/example\.com\/duplicate\.png" alt="图二" width="50%">/);
  assert.match(body, /<img src="https:\/\/example\.com\/duplicate\.png" alt="图三" width="75%">/);
  assert.match(body, /<img src="https:\/\/example\.com\/duplicate\.png" alt="图四" width="100%">/);
  assert.match(body, /<img src="https:\/\/example\.com\/duplicate\.png" alt="图五">/);
});

test('保留 class、id、title 属性且特殊字符正确转义', () => {
  const md = '![名称 & 符号](https://example.com/attr.png "标题 & <测试>"){width=50% #image-anchor .responsive-img}\n';
  const { body } = renderMarkdown(md);

  assert.match(body, /class="md-image md-img-loaded"/);
  assert.match(body, /src="https:\/\/example\.com\/attr\.png"/);
  assert.match(body, /alt="名称 &amp; 符号"/);
  assert.match(body, /title="标题 &amp; &lt;测试&gt;"/);
  assert.match(body, /width="50%"/);
  assert.match(body, /id="image-anchor"/);
  assert.match(body, /class="responsive-img"/);
});

test('严格过滤 on* 开头的事件处理器属性，避免注入风险', () => {
  const md = '![恶意图](https://example.com/xss.png){onload=alert(1) onerror=alert(2) width=50%}\n';
  const { body } = renderMarkdown(md);

  assert.match(body, /width="50%"/);
  assert.doesNotMatch(body, /onload/i);
  assert.doesNotMatch(body, /onerror/i);
});

test('renderDocument 整篇渲染包含图片尺寸及容器结构', () => {
  const doc = renderDocument({ source: '## 演示\n\n![架构图](https://example.com/arch.png){width=50%}\n' });
  assert.match(doc, /<div id="write"/);
  assert.match(doc, /<span class="md-image md-img-loaded"><img src="https:\/\/example\.com\/arch\.png" alt="架构图" width="50%"><\/span>/);
});
