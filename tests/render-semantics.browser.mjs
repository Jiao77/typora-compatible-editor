import express from 'express';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const workDir = path.resolve('work/render_semantics_20261017/test');
await mkdir(workDir, { recursive: true });
const profileDir = fs.mkdtempSync(path.join(workDir, 'profile-'));
const resultsJsonPath = path.join(workDir, 'results.json');
if (fs.existsSync(resultsJsonPath)) {
  fs.unlinkSync(resultsJsonPath);
}

// 1. 准备测试打包入口，导出 InPlaceEditor
const harnessFile = path.join(workDir, 'harness.js');
const bundleFile = path.join(workDir, 'bundle.js');
const harnessCode = `
import { InPlaceEditor } from '../../../src/web/inplace.js';
window.InPlaceEditor = InPlaceEditor;
`;
await writeFile(harnessFile, harnessCode);

await build({
  entryPoints: [harnessFile],
  outfile: bundleFile,
  bundle: true,
  platform: 'browser',
  format: 'iife'
});

// 2. 测试页面模板
const testPageHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/style/app.css">
</head>
<body data-theme="github" data-shell="light">
  <div id="write">
    <div id="document" class="document"></div>
  </div>
  <script src="/bundle.js"></script>
</body>
</html>`;

await writeFile(path.join(workDir, 'index.html'), testPageHtml);

// 3. 启动本地测试服务
const app = express();
app.use(express.static(workDir));
app.use('/style', express.static(path.resolve('public/style')));

const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const port = server.address().port;
const testUrl = `http://127.0.0.1:${port}/`;

// 4. 启动无头 Chrome，profile 位于 work 目录下
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chrome = spawn(chromePath, [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${profileDir}`,
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

let ws = null;

try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Chrome 调试端口等待超时')), 10000);
    chrome.stderr.on('data', data => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    chrome.on('error', reject);
  });

  const origin = new URL(endpoint).origin.replace('ws:', 'http:');
  const pages = await (await fetch(origin + '/json/list')).json();
  const targetPage = pages.find(p => p.type === 'page');
  if (!targetPage) throw new Error('未检测到有效的 Page Target');

  ws = new WebSocket(targetPage.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));

  let nextId = 0;
  const pendingRequests = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const callback = pendingRequests.get(message.id);
    pendingRequests.delete(message.id);
    if (callback) {
      if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
      else callback.resolve(message.result);
    }
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pendingRequests.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send('Page.enable');
  await send('Runtime.enable');

  const loadPromise = new Promise((resolve) => {
    const handler = (evt) => {
      const res = JSON.parse(evt.data);
      if (res.method === 'Page.loadEventFired') {
        ws.removeEventListener('message', handler);
        resolve();
      }
    };
    ws.addEventListener('message', handler);
  });

  await send('Page.navigate', { url: testUrl });
  await loadPromise;

  // 5. 执行测试逻辑与断言
  const evalResult = await send('Runtime.evaluate', {
    expression: `(async () => {
      const root = document.querySelector('#document');

      function assert(condition, message) {
        if (!condition) {
          throw new Error('断言失败: ' + message);
        }
      }

      function checkFootnotesConsistency(stageName) {
        const footnoteSections = root.querySelectorAll('section.footnotes');
        assert(footnoteSections.length === 1, stageName + ' - 全文必须仅有 1 份 section.footnotes，实际为: ' + footnoteSections.length);

        const sec = footnoteSections[0];
        const items = sec.querySelectorAll('li.footnote-item');
        assert(items.length > 0, stageName + ' - 脚注列表项数量应大于 0');

        for (let i = 0; i < items.length; i++) {
          const li = items[i];
          const clonedLi = li.cloneNode(true);
          const backRefs = clonedLi.querySelectorAll('a.footnote-backref');
          for (const br of backRefs) {
            br.remove();
          }
          assert(clonedLi.textContent.trim().length > 0, stageName + ' - 移除 backref 后脚注项内容不得为空 (index ' + i + ')');
        }

        // 验证正文中的每一个 ref 链接目标是否存在
        const refs = root.querySelectorAll('sup.footnote-ref a');
        assert(refs.length > 0, stageName + ' - 正文中必须存在脚注引用链接');
        for (const ref of refs) {
          const href = ref.getAttribute('href');
          assert(href && href.startsWith('#'), stageName + ' - 引用链接格式必须为 #id，实际为: ' + href);
          const targetId = decodeURIComponent(href.slice(1));
          const targetEl = document.getElementById(targetId);
          assert(targetEl !== null, stageName + ' - 引用链接目标未找到: ' + targetId);
        }

        // 验证 footer 中的每一个 backlink 目标是否存在
        const backlinks = sec.querySelectorAll('a.footnote-backref');
        assert(backlinks.length > 0, stageName + ' - 脚注尾部必须存在反向链接');
        for (const bl of backlinks) {
          const href = bl.getAttribute('href');
          assert(href && href.startsWith('#'), stageName + ' - 反向链接格式必须为 #id，实际为: ' + href);
          const targetId = decodeURIComponent(href.slice(1));
          const targetEl = document.getElementById(targetId);
          assert(targetEl !== null, stageName + ' - 反向链接目标未找到: ' + targetId);
        }
      }

      function checkFootnoteSlots(editor, stageName, currentSource) {
        const lines = currentSource.split('\\n');
        const footnoteEls = root.querySelectorAll('.md-slot[data-block-type="footnote"]');
        assert(footnoteEls.length === 2, stageName + ' - 页面中 .md-slot[data-block-type="footnote"] 数量必须恰好为 2，实际为: ' + footnoteEls.length);

        const footnoteSlots = (editor.slots || []).filter((s) => s.blockType === 'footnote');
        assert(footnoteSlots.length === 2, stageName + ' - editor.slots 中 blockType==="footnote" 的数量必须恰好为 2，实际为: ' + footnoteSlots.length);

        for (const s of footnoteSlots) {
          assert(s.isComplex === true, stageName + ' - 脚注槽位 s.isComplex 必须为 true');
          const expectedSlice = lines.slice(s.startLine, s.endLine).join('\\n');
          assert(s.source === expectedSlice, stageName + ' - 脚注槽位 source 必须等于原文 lines.slice 切片');
        }

        const hasEarly = footnoteSlots.some((s) => s.source.includes('[^early]:'));
        const hasNote = footnoteSlots.some((s) => s.source.includes('[^note]:'));
        assert(hasEarly, stageName + ' - 必须包含带有 [^early]: 的独立脚注槽位');
        assert(hasNote, stageName + ' - 必须包含带有 [^note]: 的独立脚注槽位');
      }

      // 用例 1: 3 段多行段落，增加段间脚注 [^early]，文末多段 [^note]，2 条行内脚注，未引用定义
      const source1 = [
        '第一段包含多行文字说明。',
        '这里引用了提前定义的普通脚注[^early]，以及普通脚注[^note]。',
        '',
        '[^early]: 这是位于正文段落之间的独立脚注定义。',
        '',
        '第二段也是多行文字描述。',
        '重复引用相同的脚注[^note]，同时包含行内脚注^[这是第一个行内脚注内容]。',
        '',
        '第三段为收尾段落。',
        '行内脚注补充^[这是第二个行内脚注说明]。',
        '',
        '[^note]: 这是第一行定义。',
        '',
        '    这是第二段缩进的多行定义内容。',
        '',
        '[^unused]: 未被引用的定义，不应该出现在底部脚注列表中。',
        ''
      ].join('\\n');

      let editor = new window.InPlaceEditor({ root, theme: 'github' });
      await editor.load(source1);

      // 初次加载断言
      checkFootnotesConsistency('用例1-初次加载');
      checkFootnoteSlots(editor, '用例1-初次加载', source1);
      assert(editor.getSource() === source1, '用例1-初次加载时源码不得被篡改');

      // 验证未引用的定义不在底部列表
      const sec1 = root.querySelector('section.footnotes');
      assert(!sec1.textContent.includes('未被引用的定义'), '用例1 - 未引用的定义不得出现在底部脚注列表');

      // 激活槽位并通过 view.dispatch 插入一段文本触发 dirty reparse
      editor.activateSlotByLine(1, { anchor: 0 });
      const insertText1 = '【测试插入前缀】';
      editor.view.dispatch({
        changes: { from: 0, insert: insertText1 }
      });
      await editor.commitActiveBlock();

      const expectedSource1 = insertText1 + source1;
      assert(editor.getSource() === expectedSource1, '用例1 - commit后源码应为源文加上该插入，不得出现额外篡改');
      checkFootnotesConsistency('用例1-commit后');
      checkFootnoteSlots(editor, '用例1-commit后', expectedSource1);

      editor.dispose();
      root.innerHTML = '';

      // 用例 2: 只有行内脚注，没有任何 [^def]
      const source2 = [
        '文档只有一段话。',
        '这里使用了行内脚注^[行内脚注测试，没有任何独立定义]，用于验证 footer 渲染。'
      ].join('\\n');

      editor = new window.InPlaceEditor({ root, theme: 'github' });
      await editor.load(source2);

      checkFootnotesConsistency('用例2-初次加载');
      assert(editor.getSource() === source2, '用例2-初次加载时源码不得被篡改');

      const inlineFootnoteSlots = (editor.slots || []).filter((s) => s.blockType === 'footnote');
      assert(inlineFootnoteSlots.length === 0, '用例2 - 只有行内脚注的文档不应该有任何 footnote 类型的源槽位');
      const inlineFootnoteEls = root.querySelectorAll('.md-slot[data-block-type="footnote"]');
      assert(inlineFootnoteEls.length === 0, '用例2 - 只有行内脚注的页面中不应有 .md-slot[data-block-type="footnote"] 元素');

      editor.activateSlotByLine(1, { anchor: 0 });
      const insertText2 = '【行内前缀】';
      editor.view.dispatch({
        changes: { from: 0, insert: insertText2 }
      });
      await editor.commitActiveBlock();

      const expectedSource2 = insertText2 + source2;
      assert(editor.getSource() === expectedSource2, '用例2 - commit后源码应为源文加上该插入，不得出现额外篡改');
      checkFootnotesConsistency('用例2-commit后');

      editor.dispose();
      root.innerHTML = '';

      // 用例 3: deflist 定义列表
      const source3 = [
        '术语一',
        ':   定义内容一',
        ':   第二行定义内容',
        '',
        '术语二',
        ':   定义内容二'
      ].join('\\n');

      editor = new window.InPlaceEditor({ root, theme: 'github' });
      await editor.load(source3);

      const deflistSlots = root.querySelectorAll('.md-slot[data-block-type="deflist"]');
      assert(deflistSlots.length === 1, '用例3 - .md-slot[data-block-type="deflist"] 必须恰好存在一个，实际为: ' + deflistSlots.length);

      const targetDeflistSlot = editor.slots.find((s) => s.blockType === 'deflist');
      assert(targetDeflistSlot !== undefined, '用例3 - editor.slots 中必须存在 deflist 类型的 slot');
      assert(targetDeflistSlot.isComplex === true, '用例3 - editor.slots 中 deflist 的 slot.isComplex 必须为 true');

      const singleSlotEl = deflistSlots[0];
      const allDts = singleSlotEl.querySelectorAll('dt');
      const allDds = singleSlotEl.querySelectorAll('dd');
      assert(allDts.length === 2, '用例3 - 单一 deflist slot 必须包含所有 dt 节点（共2个），实际为: ' + allDts.length);
      assert(allDds.length === 3, '用例3 - 单一 deflist slot 必须包含所有 dd 节点（共3个），实际为: ' + allDds.length);

      const dlElements = singleSlotEl.querySelectorAll('dl');
      assert(dlElements.length > 0, '用例3 - deflist slot 中必须包含真实的 dl 元素');
      for (const dl of dlElements) {
        assert(!dl.textContent.includes(':   '), '用例3 - dl 节点内容中不能出现裸冒号标记');
      }

      assert(editor.getSource() === source3, '用例3-初次加载时源码不得被篡改');

      editor.dispose();

      return {
        status: 'ok',
        case1Pass: true,
        case2Pass: true,
        case3Pass: true
      };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });

  if (evalResult.exceptionDetails) {
    throw new Error('Runtime.evaluate 执行异常：' + JSON.stringify(evalResult.exceptionDetails));
  }

  const results = evalResult.result.value;
  await writeFile(path.join(workDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log('Semantics browser test passed! Results:', JSON.stringify(results, null, 2));
  process.exit(0);
} finally {
  if (ws) {
    ws.close();
  }
  chrome.kill('SIGTERM');
  server.close();
}
