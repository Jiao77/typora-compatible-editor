import { build } from 'esbuild';
import express from 'express';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const workDir = path.resolve('work/list_blank_20261017');
await mkdir(workDir, { recursive: true });

const logLines = [];
function log(msg) {
  console.log(msg);
  logLines.push(msg);
}

log('[阶段] 1. 准备并构建测试 bundle...');
const harnessFile = path.join(workDir, 'harness.js');
const bundleFile = path.join(workDir, 'bundle.js');
const harnessCode = `
import { InPlaceEditor } from '../../src/web/inplace.js';
import { EditorView } from '../../src/web/editor-setup.js';
import { updateImageSize, updateImageUrl, findImageNodes } from '../../src/web/image-actions.js';
import { undo, redo } from '@codemirror/commands';

window.InPlaceEditor = InPlaceEditor;
window.EditorView = EditorView;
window.updateImageSize = updateImageSize;
window.updateImageUrl = updateImageUrl;
window.findImageNodes = findImageNodes;
window.undo = undo;
window.redo = redo;
`;
await writeFile(harnessFile, harnessCode);

await build({
  entryPoints: [harnessFile],
  outfile: bundleFile,
  bundle: true,
  platform: 'browser',
  format: 'iife'
});
log('[阶段] 测试包构建完成。');

log('[阶段] 2. 启动本地测试服务并配置静态路由...');
const app = express();
app.use(express.static(workDir));
// 静态路由按生产环境配置：具体 vendor 路由优先于通用 /vendor
app.use('/vendor/mathjax', express.static(path.resolve('node_modules/mathjax')));
app.use('/vendor/@mathjax', express.static(path.resolve('node_modules/@mathjax')));
app.use('/vendor/mermaid', express.static(path.resolve('node_modules/mermaid/dist')));
app.use('/vendor', express.static(path.resolve('public/vendor')));
app.use('/resources', express.static(path.resolve('resources')));
app.use('/style', express.static(path.resolve('public/style')));

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="/style/app.css">
  <link id="theme" rel="stylesheet" href="/resources/themes/github.css">
</head>
<body>
  <div class="workspace">
    <div class="scroll-host">
      <div id="write">
        <div id="document"></div>
      </div>
    </div>
  </div>
  <script src="/bundle.js"></script>
</body>
</html>`);
});

const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;
log(`[阶段] 测试服务监听端口 http://127.0.0.1:${port}`);

log('[阶段] 3. 启动 Chrome 实例并连接 CDP...');
const profileDir = path.join(workDir, 'chrome-profile');
await mkdir(profileDir, { recursive: true });

const chrome = spawn(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] }
);

const endpoint = await new Promise((resolve, reject) => {
  let output = '';
  const timer = setTimeout(() => reject(new Error('Chrome 调试端口等待超时')), 20000);
  chrome.stderr.on('data', (data) => {
    output += data;
    const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  });
  chrome.on('error', reject);
});

log(`[阶段] Chrome CDP 已连接：${endpoint}`);
const origin = new URL(endpoint).origin.replace('ws:', 'http:');
const pages = await (await fetch(origin + '/json/list')).json();
const targetPage = pages.find((p) => p.type === 'page');
if (!targetPage) throw new Error('未检测到有效的 Page Target');

const ws = new WebSocket(targetPage.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

let nextId = 0;
const pendingRequests = new Map();
ws.addEventListener('message', (event) => {
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

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result.value;
}

async function settle() {
  await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
}

async function mouse(type, x, y, extra = {}) {
  return send('Input.dispatchMouseEvent', { type, x, y, ...extra });
}

async function click(x, y) {
  await mouse('mousePressed', x, y, { button: 'left', clickCount: 1 });
  await mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 });
  await settle();
}

async function dispatchKey(key, code) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
  await settle();
}

async function insertText(text) {
  await send('Input.insertText', { text });
  await settle();
}

const suiteResults = {
  timestamp: new Date().toISOString(),
  scenarios: {},
  passed: 0,
  failed: 0,
  failures: []
};

function recordTest(name, passed, details = {}) {
  if (suiteResults.scenarios[name]) return;
  suiteResults.scenarios[name] = { passed, ...details };
  if (passed) {
    suiteResults.passed++;
    log(`[PASS] ${name}`);
  } else {
    suiteResults.failed++;
    suiteResults.failures.push({ name, details });
    log(`[FAIL] ${name}: ${details.error || JSON.stringify(details)}`);
  }
}

try {
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });

  const loadPromise = new Promise((resolve) => {
    const handler = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Page.loadEventFired') {
        ws.removeEventListener('message', handler);
        resolve();
      }
    };
    ws.addEventListener('message', handler);
  });

  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loadPromise;
  await settle();
  log('[阶段] 浏览器页面加载完成。');

  // =========================================================================
  // 测试 1：多级 ol/ul DOM 渲染结构检查
  // =========================================================================
  log('\n--- 执行测试 1：多级 ol/ul DOM 渲染结构检查 ---');
  try {
    const listDoc = [
      '# 列表层级测试',
      '',
      '- 一级无序项 A',
      '  - 二级无序项 A1',
      '    - 三级无序项 A1a',
      '- 一级无序项 B',
      '',
      '1. 一级有序项 1',
      '   1. 二级有序项 1.1',
      '      1. 三级有序项 1.1.1',
      '2. 一级有序项 2'
    ].join('\n');

    await evaluate(`(async () => {
      const h = document.querySelector(".scroll-host");
      if (h) h.scrollTop = 0;
      if (window.editor) window.editor.dispose();
      window.editor = new InPlaceEditor({ root: document.querySelector("#document"), theme: "github" });
      await editor.load(${JSON.stringify(listDoc)});
    })()`);
    await settle();

    const domCheck = await evaluate(`(() => {
      const doc = document.querySelector("#document");
      const ulLevel3 = doc.querySelector("ul > li > ul > li > ul > li");
      const olLevel3 = doc.querySelector("ol > li > ol > li > ol > li");
      return {
        hasUlLevel3: Boolean(ulLevel3 && ulLevel3.textContent.includes("三级无序项 A1a")),
        hasOlLevel3: Boolean(olLevel3 && olLevel3.textContent.includes("三级有序项 1.1.1"))
      };
    })()`);

    assert.ok(domCheck.hasUlLevel3, '三级嵌套无序列表 DOM 结构完整');
    assert.ok(domCheck.hasOlLevel3, '三级嵌套有序列表 DOM 结构完整');

    recordTest('multi_level_list_dom', true, domCheck);
  } catch (err) {
    recordTest('multi_level_list_dom', false, { error: err.message });
  }

  // =========================================================================
  // 测试 2：文档开头/中间/尾部空行点击与 Input.insertText 插入验证
  // =========================================================================
  log('\n--- 执行测试 2：文档开头/中间/尾部空行点击与 Input.insertText ---');
  try {
    const blankDoc = ['', '段落内容一', '', '段落内容二', ''].join('\n');

    await evaluate(`(async () => {
      if (window.editor) window.editor.dispose();
      window.editor = new InPlaceEditor({ root: document.querySelector("#document"), theme: "github" });
      await editor.load(${JSON.stringify(blankDoc)});
    })()`);
    await settle();

    const slotCount = await evaluate(`document.querySelectorAll("#document .md-slot").length`);
    assert.equal(slotCount, 5, '文档应拆分为 5 个槽位（3 空行 + 2 段落）');

    // 2.1 开头空行槽位点击并输入
    const headRect = await evaluate(`(() => {
      const slot = document.querySelectorAll("#document .md-slot")[0];
      const r = slot.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + r.height / 2, top: r.top, bottom: r.bottom };
    })()`);
    await click(headRect.x, headRect.y);

    const headCaret = await evaluate(`(() => {
      const head = editor.view.state.selection.main.head;
      const coords = editor.view.coordsAtPos(head);
      return coords ? { top: coords.top, bottom: coords.bottom } : null;
    })()`);
    assert.ok(headCaret, '开头空行激活后应获取到有效光标坐标');
    assert.ok(headCaret.top >= headRect.top - 10 && headCaret.bottom <= headRect.bottom + 10, '光标位置需在开头空行槽位可视范围内');

    await insertText('HEAD_TEXT');
    let currentSource = await evaluate(`editor.getSource()`);
    assert.ok(currentSource.startsWith('HEAD_TEXT'), '开头空行输入后源码应以 HEAD_TEXT 开头');

    // 2.2 中间空行槽位点击并输入
    const midRect = await evaluate(`(() => {
      const slot = document.querySelectorAll("#document .md-slot")[2];
      const r = slot.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + r.height / 2, top: r.top, bottom: r.bottom };
    })()`);
    await click(midRect.x, midRect.y);

    await insertText('MID_TEXT');
    currentSource = await evaluate(`editor.getSource()`);
    assert.ok(currentSource.includes('HEAD_TEXT\n段落内容一\nMID_TEXT\n段落内容二'), '中间空行输入后内容准确插入');

    // 2.3 尾部空行槽位点击并输入
    const tailRect = await evaluate(`(() => {
      const slots = document.querySelectorAll("#document .md-slot");
      const slot = slots[slots.length - 1];
      const r = slot.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + r.height / 2, top: r.top, bottom: r.bottom };
    })()`);
    await click(tailRect.x, tailRect.y);

    await insertText('TAIL_TEXT');
    currentSource = await evaluate(`editor.getSource()`);
    assert.ok(currentSource.endsWith('TAIL_TEXT'), '尾部空行输入后内容位于文档末尾');

    recordTest('blank_lines_click_insert', true, { finalSource: currentSource });
  } catch (err) {
    recordTest('blank_lines_click_insert', false, { error: err.message });
  }

  // =========================================================================
  // 测试 3：普通段落首 Enter 留块内，第二 Enter 退出且不增多空行
  // =========================================================================
  log('\n--- 执行测试 3：普通段落首 Enter 留块内，第二 Enter 退出 ---');
  try {
    const singleParaDoc = '独立普通段落文本';
    await evaluate(`(async () => {
      if (window.editor) window.editor.dispose();
      window.editor = new InPlaceEditor({ root: document.querySelector("#document"), theme: "github" });
      await editor.load(${JSON.stringify(singleParaDoc)});
    })()`);
    await settle();

    // 激活段落
    const paraRect = await evaluate(`(() => {
      const slot = document.querySelector("#document .md-slot");
      const r = slot.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + r.height / 2 };
    })()`);
    await click(paraRect.x, paraRect.y);

    // 移动光标至行末
    await evaluate(`editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } })`);
    await settle();

    // 第一次 Enter：应保持在块内，行数扩增至 2 行
    await dispatchKey('Enter', 'Enter');
    const afterFirstEnter = await evaluate(`(() => {
      const slot = editor.activeSlot;
      const head = editor.view.state.selection.main.head;
      const coords = editor.view.coordsAtPos(head);
      const scroller = editor.view.scrollDOM;
      const scrollerRect = scroller.getBoundingClientRect();
      const inScroller = Boolean(coords && coords.top >= scrollerRect.top - 1 && coords.bottom <= scrollerRect.bottom + 1);
      return {
        lineCount: editor.view.state.doc.lines,
        isActive: Boolean(slot),
        slotEndLine: slot ? slot.endLine : null,
        slotStartLine: slot ? slot.startLine : null,
        coords,
        scrollerRect,
        inScroller
      };
    })()`);
    assert.equal(afterFirstEnter.lineCount, 2, '首次回车后文档行数应变为 2');
    assert.equal(afterFirstEnter.isActive, true, '首次回车后槽位保持激活状态');
    assert.equal(afterFirstEnter.slotEndLine - afterFirstEnter.slotStartLine, 2, '首次回车后活动槽位行区间扩大');
    assert.ok(afterFirstEnter.inScroller, '首次回车后 caret 应该在编辑器 scroller 可视区');

    // 第二次 Enter：在纯空行上回车，应当退出为新分块
    await dispatchKey('Enter', 'Enter');
    await settle();

    const afterSecondEnter = await evaluate(`(() => {
      const slot = editor.activeSlot;
      const isBlockEmpty = slot ? (slot.startLine + 1 === slot.endLine && editor.getSource().split("\\n")[slot.startLine] === "") : false;
      return {
        lines: editor.getSource().split("\\n"),
        slotsCount: editor.slots.length,
        isActive: Boolean(slot),
        isBlockEmpty
      };
    })()`);

    assert.equal(afterSecondEnter.lines.length, 2, '二次回车后不应产生多余空行，行数保持为 2');
    assert.equal(afterSecondEnter.lines[0], '独立普通段落文本', '第一行文本保持不变');
    assert.equal(afterSecondEnter.lines[1], '', '第二行为空行');
    assert.ok(afterSecondEnter.slotsCount >= 2, '二次回车后已拆分为独立槽位');
    assert.ok(afterSecondEnter.isActive && afterSecondEnter.isBlockEmpty, '二次回车后激活块应为新 empty block');

    // 实际 insertText 验证内容在块外新行
    await insertText('NEW_LINE_AFTER_PARA');
    const sourceAfterInsert = await evaluate(`editor.getSource()`);
    assert.equal(sourceAfterInsert, '独立普通段落文本\nNEW_LINE_AFTER_PARA', '新行输入内容应位于独立新行');

    recordTest('normal_paragraph_double_enter', true, afterSecondEnter);
  } catch (err) {
    recordTest('normal_paragraph_double_enter', false, { error: err.message });
  }

  // =========================================================================
  // 测试 4：列表连续两次 Enter 清空 marker 并退出列表
  // =========================================================================
  log('\n--- 执行测试 4：列表两次 Enter 清空 marker 并退出 ---');
  try {
    const listDoc = '- 第一项\n- 第二项';
    await evaluate(`(async () => {
      if (window.editor) window.editor.dispose();
      window.editor = new InPlaceEditor({ root: document.querySelector("#document"), theme: "github" });
      await editor.load(${JSON.stringify(listDoc)});
    })()`);
    await settle();

    // 点击列表块
    const listRect = await evaluate(`(() => {
      const slot = document.querySelector("#document .md-slot");
      const r = slot.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + r.height / 2 };
    })()`);
    await click(listRect.x, listRect.y);

    // 将光标定位在第二项末尾
    await evaluate(`editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } })`);
    await settle();

    // 第一次 Enter：应生成新列表 marker "- "
    await dispatchKey('Enter', 'Enter');
    const afterFirstEnter = await evaluate(`(() => {
      const text = editor.view.state.doc.line(3).text;
      const head = editor.view.state.selection.main.head;
      const coords = editor.view.coordsAtPos(head);
      const scroller = editor.view.scrollDOM;
      const scrollerRect = scroller.getBoundingClientRect();
      const slotEl = editor.activeSlotEl;
      const slotRect = slotEl ? slotEl.getBoundingClientRect() : null;
      const inScroller = Boolean(coords && coords.top >= scrollerRect.top - 1 && coords.bottom <= scrollerRect.bottom + 1);
      return {
        line3Text: text,
        fullSource: editor.getSource(),
        selection: editor.view.state.selection.main,
        coords,
        scrollerRect: { top: scrollerRect.top, bottom: scrollerRect.bottom, left: scrollerRect.left, right: scrollerRect.right, height: scrollerRect.height },
        scrollerMetrics: { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight },
        slotRect: slotRect ? { top: slotRect.top, bottom: slotRect.bottom, left: slotRect.left, right: slotRect.right, height: slotRect.height } : null,
        inScroller
      };
    })()`);
    assert.equal(afterFirstEnter.line3Text, '- ', '第一次回车后自动延续列表前缀 "- "');

    // 第二次 Enter：在空 marker 行按回车，应清空该 marker 并退出列表
    await dispatchKey('Enter', 'Enter');
    await settle();

    const afterSecondEnter = await evaluate(`(() => {
      const slot = editor.activeSlot;
      const isBlockEmpty = slot ? (slot.startLine + 1 === slot.endLine && editor.getSource().split("\\n")[slot.startLine] === "") : false;
      return {
        source: editor.getSource(),
        lines: editor.getSource().split("\\n"),
        isActive: Boolean(slot),
        isBlockEmpty
      };
    })()`);

    assert.ok(!afterSecondEnter.source.includes('- \n') && !afterSecondEnter.source.endsWith('- '), '空 marker 标记已被完全清除');
    assert.equal(afterSecondEnter.lines[0], '- 第一项');
    assert.equal(afterSecondEnter.lines[1], '- 第二项');
    assert.ok(afterSecondEnter.isActive && afterSecondEnter.isBlockEmpty, '列表二次回车后激活块应为新 empty block');

    // 实际 insertText 验证内容在块外新行
    await insertText('NEW_LINE_AFTER_LIST');
    const sourceAfterInsert = await evaluate(`editor.getSource()`);
    assert.equal(sourceAfterInsert, '- 第一项\n- 第二项\n\nNEW_LINE_AFTER_LIST', '列表退出后新输入内容应位于块外新行');

    // 提交并验证槽位分块类型（必须独立成非 list 段落，不能成为 list 的 lazy continuation）
    await evaluate(`editor.commitActiveBlock()`);
    await settle();

    const slotsCheck = await evaluate(`(() => {
      return editor.slots.map(s => ({
        id: s.id,
        blockType: s.blockType,
        startLine: s.startLine,
        endLine: s.endLine,
        isComplex: s.isComplex
      }));
    })()`);

    const lastSlot = slotsCheck[slotsCheck.length - 1];
    const isIndependentParagraph = Boolean(lastSlot && !lastSlot.blockType.startsWith('list'));

    assert.ok(afterFirstEnter.inScroller, '列表首次回车后 caret 应该在编辑器 scroller 可视区');
    assert.equal(sourceAfterInsert, '- 第一项\n- 第二项\n\nNEW_LINE_AFTER_LIST', '列表退出后新输入内容应位于空行隔离后的独立新行');
    assert.ok(isIndependentParagraph, '列表提交后新增文字必须独立成段落槽位，不能退化为 list');

    recordTest('list_double_enter_clear_marker', true, {
      afterFirstEnter,
      afterSecondEnter,
      sourceAfterInsert,
      slotsCheck,
      isIndependentParagraph
    });
  } catch (err) {
    recordTest('list_double_enter_clear_marker', false, { error: err.message });
  }

  // =========================================================================
  // 测试 5：代码/数学/HTML/图表块双 Enter 后 source 保留结束标记且外部输入在块后
  // =========================================================================
  log('\n--- 执行测试 5：闭合复合块双 Enter 退出与内容外部追加 ---');
  try {
    const fencedCases = [
      {
        type: 'code',
        doc: '```js\nconst count = 42;\n```',
        closingMarker: '```',
        textLine: 2,
        insertVal: 'AFTER_CODE_BLOCK'
      },
      {
        type: 'math-block',
        doc: '$$\nE = mc^2\n$$',
        closingMarker: '$$',
        textLine: 2,
        insertVal: 'AFTER_MATH_BLOCK'
      },
      {
        type: 'html',
        doc: '<div>\n<p>HTML 内容</p>\n</div>',
        closingMarker: '</div>',
        textLine: 2,
        insertVal: 'AFTER_HTML_BLOCK'
      },
      {
        type: 'diagram',
        doc: '```mermaid\ngraph TD;\n  A-->B;\n```',
        closingMarker: '```',
        textLine: 3,
        insertVal: 'AFTER_DIAGRAM_BLOCK'
      }
    ];

    const results = {};

    for (const item of fencedCases) {
      await evaluate(`(async () => {
        if (window.editor) window.editor.dispose();
        window.editor = new InPlaceEditor({ root: document.querySelector("#document"), theme: "github" });
        await editor.load(${JSON.stringify(item.doc)});
      })()`);
      await settle();

      // 点击复合块激活
      const blockRect = await evaluate(`(() => {
        const slot = document.querySelector("#document .md-slot");
        const r = slot.getBoundingClientRect();
        return { x: r.left + 20, y: r.top + 20 };
      })()`);
      await click(blockRect.x, blockRect.y);

      // 将光标定位到指定文本行末尾（闭合标记前的内容行）
      await evaluate(`(() => {
        const line = editor.view.state.doc.line(${item.textLine});
        editor.view.dispatch({ selection: { anchor: line.to } });
      })()`);
      await settle();

      // 第一次 Enter：在块内插入换行生成空行
      await dispatchKey('Enter', 'Enter');
      // 第二次 Enter：空行触发退出闭合块，插入点位于闭合标记后
      await dispatchKey('Enter', 'Enter');
      await settle();

      // 外部输入新内容
      await insertText(item.insertVal);
      const finalSource = await evaluate(`editor.getSource()`);

      assert.ok(finalSource.includes(item.closingMarker), `${item.type} 闭合标记 ${item.closingMarker} 必须完整保留`);
      const markerIndex = finalSource.lastIndexOf(item.closingMarker);
      const insertIndex = finalSource.indexOf(item.insertVal);
      assert.ok(insertIndex > markerIndex, `${item.type} 外部输入内容必须位于闭合标记之后 (marker at ${markerIndex}, insert at ${insertIndex})`);
      assert.equal(finalSource, item.doc + "\n" + item.insertVal, `${item.type} 最终 source 必须等于原块文本追加新行外部输入`);

      results[item.type] = { finalSource, markerIndex, insertIndex };
    }

    recordTest('fenced_blocks_double_enter', true, results);
  } catch (err) {
    recordTest('fenced_blocks_double_enter', false, { error: err.message });
  }

  // =========================================================================
  // 测试 6：撤销（undo）恢复完整初始源码（包含复杂块双 Enter 与外部输入）
  // =========================================================================
  log('\n--- 执行测试 6：撤销恢复完整初始源码 ---');
  try {
    // 6.1 普通段落输入撤销
    const initialDoc = '# 初始文档标题\n\n初始段落测试内容。';
    await evaluate(`(async () => {
      if (window.editor) window.editor.dispose();
      window.editor = new InPlaceEditor({ root: document.querySelector("#document"), theme: "github" });
      await editor.load(${JSON.stringify(initialDoc)});
    })()`);
    await settle();

    // 激活并输入修改内容
    const slotRect = await evaluate(`(() => {
      const slot = document.querySelector("#document .md-slot");
      const r = slot.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + 10 };
    })()`);
    await click(slotRect.x, slotRect.y);
    await evaluate(`editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } })`);
    await settle();

    await insertText('【新增测试文本】');
    const modifiedSource = await evaluate(`editor.getSource()`);
    assert.ok(modifiedSource.includes('【新增测试文本】'), '修改已应用到源码');

    // 执行撤销
    await evaluate(`window.undo(editor.view)`);
    await settle();

    const restoredSource = await evaluate(`editor.getSource()`);
    assert.equal(restoredSource, initialDoc, '撤销后源码应完全恢复为初始内容');

    // 6.2 复杂块双 Enter + 外部输入后的真实 undo 恢复
    const complexDoc = '```js\nconst a = 1;\n```';
    await evaluate(`(async () => {
      if (window.editor) window.editor.dispose();
      window.editor = new InPlaceEditor({ root: document.querySelector("#document"), theme: "github" });
      await editor.load(${JSON.stringify(complexDoc)});
    })()`);
    await settle();

    const codeSlotRect = await evaluate(`(() => {
      const slot = document.querySelector("#document .md-slot");
      const r = slot.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + 20 };
    })()`);
    await click(codeSlotRect.x, codeSlotRect.y);

    // 定位在代码行末
    await evaluate(`(() => {
      const line = editor.view.state.doc.line(2);
      editor.view.dispatch({ selection: { anchor: line.to } });
    })()`);
    await settle();

    // 动作 1：首 Enter 扩展
    await dispatchKey('Enter', 'Enter');
    // 动作 2：第二 Enter 退出闭合块并在外部生成空行
    await dispatchKey('Enter', 'Enter');
    await settle();
    // 动作 3：外部文本输入
    await insertText('EXTERNAL_TEXT');
    const complexEdited = await evaluate(`editor.getSource()`);
    assert.equal(complexEdited, complexDoc + '\nEXTERNAL_TEXT', '外部输入后源码符合预期');

    // 调用真实 undo 直到恢复原 source（最多 3 次真实撤销动作）
    for (let u = 0; u < 3; u++) {
      if (await evaluate(`editor.getSource() === ${JSON.stringify(complexDoc)}`)) break;
      await evaluate(`window.undo(editor.view)`);
      await settle();
    }

    const complexRestored = await evaluate(`editor.getSource()`);
    assert.equal(complexRestored, complexDoc, '复杂块双Enter及外部输入撤销后应完全恢复原 source');
    assert.ok(complexRestored.endsWith('```'), '撤销后闭合标记完整保留未丢失');

    recordTest('undo_restore_source', true, { initialDoc, restoredSource, complexDoc, complexRestored });
  } catch (err) {
    recordTest('undo_restore_source', false, { error: err.message });
  }

  // =========================================================================
  // 测试 7：空白 caret 位于 slot 可视区且插入文本可见
  // =========================================================================
  log('\n--- 执行测试 7：空白 caret 位于 slot 可视区且插入文本可见 ---');
  try {
    const docWithEmpty = ['# 标题行', '', '尾部正文行'].join('\n');
    await evaluate(`(async () => {
      if (window.editor) window.editor.dispose();
      window.editor = new InPlaceEditor({ root: document.querySelector("#document"), theme: "github" });
      await editor.load(${JSON.stringify(docWithEmpty)});
    })()`);
    await settle();

    // 点击空行槽位（索引 1）
    const emptyRect = await evaluate(`(() => {
      const slots = document.querySelectorAll("#document .md-slot");
      const slot = slots[1];
      const r = slot.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + r.height / 2, top: r.top, bottom: r.bottom };
    })()`);
    await click(emptyRect.x, emptyRect.y);

    const caretVisibility = await evaluate(`(() => {
      const head = editor.view.state.selection.main.head;
      const coords = editor.view.coordsAtPos(head);
      const activeSlotEl = editor.activeSlotEl;
      const slotRect = activeSlotEl ? activeSlotEl.getBoundingClientRect() : null;
      return {
        coords,
        slotRect,
        inSlotView: Boolean(coords && slotRect && coords.top >= slotRect.top - 1 && coords.bottom <= slotRect.bottom + 1)
      };
    })()`);

    assert.ok(caretVisibility.coords, '空白槽位点击后应成功计算光标位置坐标');
    assert.ok(caretVisibility.inSlotView, '空白光标应处于 activeSlotEl 可视区域内（容差 1px）');

    // 插入文本并验证 DOM 渲染
    await insertText('插入可见正文测试');
    await evaluate(`editor.commitActiveBlock()`);
    await settle();

    const renderedText = await evaluate(`(() => {
      const doc = document.querySelector("#document");
      return doc ? doc.textContent : '';
    })()`);
    assert.ok(renderedText.includes('插入可见正文测试'), '插入文本在提交后应可见且渲染至 DOM');

    recordTest('blank_caret_visibility', true, { caretVisibility, renderedText });
  } catch (err) {
    recordTest('blank_caret_visibility', false, { error: err.message });
  }

  // 保存测试结果与运行日志
  const jsonReport = JSON.stringify(suiteResults, null, 2);
  await writeFile(path.join(workDir, 'results.json'), jsonReport);
  await writeFile(path.join(workDir, 'run.log'), logLines.join('\n'));

  log(`\n========================================`);
  log(`测试执行完毕：通过 ${suiteResults.passed} 项，失败 ${suiteResults.failed} 项。`);
  log(`日志已保存至 ${path.join(workDir, 'run.log')}`);
  log(`========================================\n`);

  if (suiteResults.failed > 0) {
    process.exitCode = 1;
  }
} finally {
  try { ws.close(); } catch {}
  try { chrome.kill('SIGTERM'); } catch {}
  try { server.close(); } catch {}
}
