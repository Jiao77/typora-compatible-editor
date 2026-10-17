import { build } from 'esbuild';
import express from 'express';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const workDir = path.resolve('work/fixed_slots_test_20261017');
await mkdir(workDir, { recursive: true });

const logLines = [];
function log(msg) {
  console.log(msg);
  logLines.push(msg);
}

log('[阶段] 1. 准备测试打包入口...');
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

if (!process.argv.includes('--reuse')) {
  await build({
    entryPoints: [harnessFile],
    outfile: bundleFile,
    bundle: true,
    platform: 'browser',
    format: 'iife'
  });
  log('[阶段] 测试包构建完成。');
} else {
  log('[阶段] 复用现有测试包。');
}

log('[阶段] 2. 启动本地测试服务...');
const app = express();
app.use(express.static(workDir));
app.use('/resources', express.static(path.resolve('resources')));
app.use('/style', express.static(path.resolve('public/style')));
app.use('/vendor/mathjax', express.static(path.resolve('node_modules/mathjax')));
app.use('/vendor/@mathjax', express.static(path.resolve('node_modules/@mathjax')));
app.use('/vendor/mermaid', express.static(path.resolve('node_modules/mermaid/dist')));
app.use('/vendor', express.static(path.resolve('public/vendor')));

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
await new Promise(resolve => server.once('listening', resolve));
const port = server.address().port;
log(`[阶段] 测试服务已监听端口 http://127.0.0.1:${port}`);

log('[阶段] 3. 启动 Chrome 实例并连接 CDP...');
const profileDir = path.join(workDir, 'profile');
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

log(`[阶段] Chrome CDP 已连接：${endpoint}`);
const origin = new URL(endpoint).origin.replace('ws:', 'http:');
const pages = await (await fetch(origin + '/json/list')).json();
const targetPage = pages.find(p => p.type === 'page');
if (!targetPage) throw new Error('未检测到有效的 Page Target');

const ws = new WebSocket(targetPage.webSocketDebuggerUrl);
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

const suiteResults = {
  timestamp: new Date().toISOString(),
  scenarios: {},
  passed: 0,
  failed: 0,
  failures: []
};

function recordTest(name, passed, details = {}) {
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

  const loadPromise = new Promise(resolve => {
    const handler = event => {
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
  // 测试 1：文档尾部脚注与行点击全量几何快照防抖回归测试
  // =========================================================================
  log('\n--- 执行测试 1：尾部脚注与全量几何防抖回归 ---');
  try {
    const prefix = Array.from({ length: 8 }, (_, i) => `## 章节 ${i + 1}\n\n段落文本行 A ${i + 1}\n段落文本行 B ${i + 1}\n`).join('\n') + '\n';
    const tailText = '~~删除线~~、==高亮==、H~2~O、X^2^、:smile:、脚注[^1]。\n\n[^1]: 这是脚注内容。\n\n[TOC]\n';
    const fullDoc = prefix + tailText;

    await evaluate(`(async () => {
      const h = document.querySelector(".scroll-host");
      if (h) h.scrollTop = 0;
      if (window.editor) window.editor.dispose();
      window.editor = new InPlaceEditor({ root: document.querySelector("#document"), theme: "github" });
      await editor.load(${JSON.stringify(fullDoc)});
    })()`);
    await settle();

    // 滚动至接近底部使目标块居中可见
    await evaluate(`(async () => {
      const allBlocks = Array.from(document.querySelectorAll(".md-block"));
      const bodyBlock = allBlocks.find(b => b.textContent.includes("删除线") && b.textContent.includes("脚注"));
      if (bodyBlock) {
        bodyBlock.scrollIntoView({ block: "center", behavior: "instant" });
      } else {
        const h = document.querySelector(".scroll-host");
        if (h) h.scrollTo({ top: h.scrollHeight, behavior: "instant" });
      }
      await new Promise(r => setTimeout(r, 200));
    })()`);
    await settle();

    const slotInfo = await evaluate(`(() => {
      const allBlocks = Array.from(document.querySelectorAll(".md-block"));
      const bodyBlock = allBlocks.find(b => b.textContent.includes("删除线") && b.textContent.includes("脚注"));
      const fnBlock = allBlocks.find(b => b.textContent.includes("这是脚注内容"));
      const host = document.querySelector(".scroll-host");

      const snapshot = allBlocks.map((b, idx) => {
        const r = b.getBoundingClientRect();
        return {
          idx,
          slotId: b.dataset.slotId,
          lineStart: b.dataset.lineStart,
          lineEnd: b.dataset.lineEnd,
          top: r.top,
          height: r.height,
          left: r.left,
          width: r.width
        };
      });

      return {
        bodyLineStart: bodyBlock ? parseInt(bodyBlock.dataset.lineStart) : null,
        bodyLineEnd: bodyBlock ? parseInt(bodyBlock.dataset.lineEnd) : null,
        fnLineStart: fnBlock ? parseInt(fnBlock.dataset.lineStart) : null,
        fnLineEnd: fnBlock ? parseInt(fnBlock.dataset.lineEnd) : null,
        initialScrollTop: host.scrollTop,
        snapshot
      };
    })()`);

    assert.ok(slotInfo.bodyLineStart, '正文槽位包含删除线必须存在');
    assert.ok(slotInfo.fnLineStart, '脚注槽位包含脚注内容必须存在');

    const rounds = 3;
    let roundFailures = [];

    // 辅助函数：逐项比对所有槽位的几何快照
    async function verifyGeometricSnapshot(round, stepLabel) {
      const currentSnapshot = await evaluate(`(() => {
        const allBlocks = Array.from(document.querySelectorAll(".md-block"));
        const host = document.querySelector(".scroll-host");
        return {
          scrollTop: host.scrollTop,
          blocks: allBlocks.map((b, idx) => {
            const r = b.getBoundingClientRect();
            return {
              idx,
              slotId: b.dataset.slotId,
              top: r.top,
              height: r.height
            };
          })
        };
      })()`);

      // 1. 验证外层 scrollTop
      const scrollDiff = Math.abs(currentSnapshot.scrollTop - slotInfo.initialScrollTop);
      if (scrollDiff > 1.0) {
        roundFailures.push(`第 ${round} 轮 ${stepLabel}：外层 scrollTop 漂移 ${scrollDiff.toFixed(2)}px (初始 ${slotInfo.initialScrollTop}, 当前 ${currentSnapshot.scrollTop})`);
      }

      // 2. 逐项验证所有槽位的 top 与 height
      for (let i = 0; i < slotInfo.snapshot.length; i++) {
        const init = slotInfo.snapshot[i];
        const curr = currentSnapshot.blocks[i];
        if (!curr) {
          roundFailures.push(`第 ${round} 轮 ${stepLabel}：槽位数量缺失，缺少索引 ${i}`);
          break;
        }
        const topDiff = Math.abs(curr.top - init.top);
        const heightDiff = Math.abs(curr.height - init.height);
        if (topDiff > 1.0) {
          roundFailures.push(`第 ${round} 轮 ${stepLabel}：槽位 ${init.slotId || i} top 漂移 ${topDiff.toFixed(2)}px (初始 ${init.top.toFixed(1)}, 当前 ${curr.top.toFixed(1)})`);
        }
        if (heightDiff > 1.0) {
          roundFailures.push(`第 ${round} 轮 ${stepLabel}：槽位 ${init.slotId || i} height 漂移 ${heightDiff.toFixed(2)}px (初始 ${init.height.toFixed(1)}, 当前 ${curr.height.toFixed(1)})`);
        }
      }
    }

    for (let r = 0; r < rounds; r++) {
      // 步骤 A：获取正文目标槽位坐标并断言可见性与命中
      const bodyTarget = await evaluate(`(() => {
        const b = Array.from(document.querySelectorAll(".md-block")).find(el => el.textContent.includes("删除线"));
        const rect = b.getBoundingClientRect();
        const x = rect.left + 25;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          x, y,
          inViewport: x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight,
          hitsTarget: b.contains(hit),
          rect
        };
      })()`);

      assert.ok(bodyTarget.inViewport, `第 ${r+1} 轮正文坐标必须在视口内 (y=${bodyTarget.y.toFixed(1)})`);
      assert.ok(bodyTarget.hitsTarget, `第 ${r+1} 轮 elementFromPoint 必须命中正文目标槽位`);

      // 点击正文
      await click(bodyTarget.x, bodyTarget.y);
      const afterClickBody = await evaluate(`(() => {
        const head = editor.view.state.selection.main.head;
        const line = editor.view.state.doc.lineAt(head).number;
        return { line };
      })()`);

      if (afterClickBody.line < slotInfo.bodyLineStart || afterClickBody.line > slotInfo.bodyLineEnd) {
        roundFailures.push(`第 ${r+1} 轮步骤 A：行归属不匹配：当前为 ${afterClickBody.line}，预期在 [${slotInfo.bodyLineStart}, ${slotInfo.bodyLineEnd}] 内`);
      }
      await verifyGeometricSnapshot(r + 1, '步骤 A（点击正文）');

      // 步骤 B：在同一坐标重复点击
      await click(bodyTarget.x, bodyTarget.y);
      const afterRepeatBody = await evaluate(`(() => {
        const head = editor.view.state.selection.main.head;
        const line = editor.view.state.doc.lineAt(head).number;
        return { line };
      })()`);

      if (afterRepeatBody.line < slotInfo.bodyLineStart || afterRepeatBody.line > slotInfo.bodyLineEnd) {
        roundFailures.push(`第 ${r+1} 轮步骤 B（重复点击）：行归属不匹配：当前为 ${afterRepeatBody.line}`);
      }
      await verifyGeometricSnapshot(r + 1, '步骤 B（重复点击正文）');

      // 步骤 C：获取脚注目标槽位坐标并断言可见性与命中
      const fnTarget = await evaluate(`(() => {
        const b = Array.from(document.querySelectorAll(".md-block")).find(el => el.textContent.includes("这是脚注内容"));
        const rect = b.getBoundingClientRect();
        const x = rect.left + 25;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          x, y,
          inViewport: x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight,
          hitsTarget: b.contains(hit),
          rect
        };
      })()`);

      assert.ok(fnTarget.inViewport, `第 ${r+1} 轮脚注坐标必须在视口内 (y=${fnTarget.y.toFixed(1)})`);
      assert.ok(fnTarget.hitsTarget, `第 ${r+1} 轮 elementFromPoint 必须命中脚注槽位`);

      await click(fnTarget.x, fnTarget.y);
      const afterClickFn = await evaluate(`(() => {
        const head = editor.view.state.selection.main.head;
        const line = editor.view.state.doc.lineAt(head).number;
        return { line };
      })()`);

      if (afterClickFn.line < slotInfo.fnLineStart || afterClickFn.line > slotInfo.fnLineEnd) {
        roundFailures.push(`第 ${r+1} 轮步骤 C（脚注点击）：行归属不匹配：当前为 ${afterClickFn.line}，预期在 [${slotInfo.fnLineStart}, ${slotInfo.fnLineEnd}] 内`);
      }
      await verifyGeometricSnapshot(r + 1, '步骤 C（点击脚注）');

      // 步骤 D：切回正文原始坐标，再次断言可见性
      const switchBackCheck = await evaluate(`(() => {
        const hit = document.elementFromPoint(${bodyTarget.x}, ${bodyTarget.y});
        const b = Array.from(document.querySelectorAll(".md-block")).find(el => el.textContent.includes("删除线"));
        return {
          inViewport: ${bodyTarget.x} > 0 && ${bodyTarget.x} < window.innerWidth && ${bodyTarget.y} > 0 && ${bodyTarget.y} < window.innerHeight,
          hitsTarget: b ? b.contains(hit) : false
        };
      })()`);
      assert.ok(switchBackCheck.inViewport, `第 ${r+1} 轮切回正文坐标必须在视口内`);

      await click(bodyTarget.x, bodyTarget.y);
      const afterSwitchBack = await evaluate(`(() => {
        const head = editor.view.state.selection.main.head;
        const line = editor.view.state.doc.lineAt(head).number;
        return { line };
      })()`);

      if (afterSwitchBack.line < slotInfo.bodyLineStart || afterSwitchBack.line > slotInfo.bodyLineEnd) {
        roundFailures.push(`第 ${r+1} 轮步骤 D（切回正文）：行归属不匹配：当前为 ${afterSwitchBack.line}`);
      }
      await verifyGeometricSnapshot(r + 1, '步骤 D（切回正文）');
    }

    recordTest('tail_footnote_and_jitter_regression', roundFailures.length === 0, {
      rounds,
      failures: roundFailures,
      slotInfo: {
        bodyLine: [slotInfo.bodyLineStart, slotInfo.bodyLineEnd],
        fnLine: [slotInfo.fnLineStart, slotInfo.fnLineEnd],
        initialScrollTop: slotInfo.initialScrollTop,
        totalTrackedSlots: slotInfo.snapshot.length
      }
    });
  } catch (err) {
    recordTest('tail_footnote_and_jitter_regression', false, { error: err.message });
  }

  // =========================================================================
  // 测试 2：多行段落单行槽位就地编辑与选区交互
  // =========================================================================
  log('\n--- 执行测试 2：多行段落单行就地编辑 ---');
  try {
    const multilineDoc = `段落第一行内容甲\n段落第二行内容乙\n段落第三行内容丙\n`;
    await evaluate(`(async () => {
      const h = document.querySelector(".scroll-host");
      if (h) h.scrollTop = 0;
      if (window.editor) window.editor.dispose();
      window.editor = new InPlaceEditor({ root: document.querySelector("#document"), theme: "github" });
      await editor.load(${JSON.stringify(multilineDoc)});
    })()`);
    await settle();

    // 检查初始槽位划分
    const initialSlots = await evaluate(`(() => {
      const blocks = Array.from(document.querySelectorAll(".md-block"));
      return blocks.map(b => ({
        lineStart: b.dataset.lineStart,
        lineEnd: b.dataset.lineEnd,
        text: b.textContent.trim()
      }));
    })()`);

    // 点击第一行
    const l1Target = await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll(".md-block")).find(el => el.textContent.includes("内容甲"));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const x = r.left + 30;
      const y = r.top + r.height / 2;
      return {
        x, y,
        inViewport: x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight,
        hitsTarget: b.contains(document.elementFromPoint(x, y))
      };
    })()`);
    assert.ok(l1Target, '第一行槽位必须存在');
    assert.ok(l1Target.inViewport, '第一行目标坐标必须在视口内');
    assert.ok(l1Target.hitsTarget, '第一行坐标必须命中目标槽位');
    await click(l1Target.x, l1Target.y);

    const l1State = await evaluate(`(() => {
      const head = editor.view.state.selection.main.head;
      const line = editor.view.state.doc.lineAt(head).number;
      return { line };
    })()`);
    assert.equal(l1State.line, 1, '光标应定位在第 1 行');

    // 点击第二行
    const l2Target = await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll(".md-block")).find(el => el.textContent.includes("内容乙"));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const x = r.left + 30;
      const y = r.top + r.height / 2;
      return {
        x, y,
        inViewport: x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight,
        hitsTarget: b.contains(document.elementFromPoint(x, y))
      };
    })()`);
    assert.ok(l2Target, '第二行槽位必须存在');
    assert.ok(l2Target.inViewport, '第二行目标坐标必须在视口内');
    assert.ok(l2Target.hitsTarget, '第二行坐标必须命中目标槽位');
    await click(l2Target.x, l2Target.y);

    const l2State = await evaluate(`(() => {
      const head = editor.view.state.selection.main.head;
      const line = editor.view.state.doc.lineAt(head).number;
      return { line };
    })()`);
    assert.equal(l2State.line, 2, '光标应定位在第 2 行');

    // 点击第二行末尾（基于源码文本视觉末尾坐标 side = -1）
    const l2EndTarget = await evaluate(`(() => {
      const line = editor.view.state.doc.line(2);
      const coords = editor.view.coordsAtPos(line.to, -1);
      return { x: coords.left, y: (coords.top + coords.bottom) / 2, expectedPos: line.to };
    })()`);
    await click(l2EndTarget.x, l2EndTarget.y);
    const posAtEnd = await evaluate(`editor.view.state.selection.main.head`);
    assert.equal(posAtEnd, l2EndTarget.expectedPos, '点击行尾时光标应停在 line.to');

    // 鼠标拖选整行文本
    const l2StartCoords = await evaluate(`(() => {
      const line = editor.view.state.doc.line(2);
      const coords = editor.view.coordsAtPos(line.from);
      return { x: coords.left + 2, y: (coords.top + coords.bottom) / 2 };
    })()`);
    await mouse('mousePressed', l2StartCoords.x, l2StartCoords.y, { button: 'left', clickCount: 1 });
    await mouse('mouseMoved', l2EndTarget.x, l2EndTarget.y, { button: 'left', buttons: 1 });
    await mouse('mouseReleased', l2EndTarget.x, l2EndTarget.y, { button: 'left', clickCount: 1 });
    await settle();

    const dragSelection = await evaluate(`(() => {
      const sel = editor.view.state.selection.main;
      const line = editor.view.state.doc.line(2);
      return { from: sel.from, to: sel.to, expectedFrom: line.from, expectedTo: line.to };
    })()`);
    assert.equal(dragSelection.from, dragSelection.expectedFrom, '拖选起点与 line.from 一致');
    assert.equal(dragSelection.to, dragSelection.expectedTo, '拖选终点与 line.to 一致');

    // 第二行追加输入
    await click(l2EndTarget.x, l2EndTarget.y);
    await send('Input.insertText', { text: '【已修改】' });
    await settle();

    const modifiedDoc = await evaluate(`editor.getSource()`);
    assert.ok(modifiedDoc.includes('段落第二行内容乙【已修改】'), '文档应包含实际输入内容');

    recordTest('multiline_paragraph_per_line_editing', true, {
      initialSlots,
      posAtEnd,
      dragSelection,
      modifiedDoc
    });
  } catch (err) {
    recordTest('multiline_paragraph_per_line_editing', false, { error: err.message });
  }

  // =========================================================================
  // 测试 3：复杂结构（Math/Mermaid/HTML/Code）整块编辑与溢出内部滚动
  // =========================================================================
  log('\n--- 执行测试 3：复杂块（Math/Mermaid/HTML/Code）整块编辑与内部滚动 ---');
  try {
    const complexDoc = [
      '# 复杂块综合测试',
      '',
      '前置参照段落文本。',
      '',
      '$$',
      '\\begin{matrix}',
      'a & b \\\\',
      'c & d',
      '\\end{matrix}',
      '$$',
      '',
      '```mermaid',
      'graph LR',
      '  A[开始] --> B[处理]',
      '  B --> C[完成]',
      '```',
      '',
      '<div class="compact-html-preview" style="height:30px; overflow:hidden;">',
      '  <p>HTML第1行</p>',
      '  <p>HTML第2行</p>',
      '  <p>HTML第3行</p>',
      '  <p>HTML第4行</p>',
      '  <p>HTML第5行</p>',
      '  <p>HTML第6行</p>',
      '  <p>HTML第7行</p>',
      '  <p>HTML第8行</p>',
      '  <p>HTML第9行</p>',
      '  <p>HTML第10行</p>',
      '</div>',
      '',
      '中间参照段落文本。',
      '',
      '```javascript',
      'function testCode() {',
      '  const factor = 42;',
      '  return factor * 2;',
      '}',
      '```',
      '',
      '末尾参照段落文本。'
    ].join('\n');

    await evaluate(`(async () => {
      const h = document.querySelector(".scroll-host");
      if (h) h.scrollTop = 0;
      if (window.editor) window.editor.dispose();
      window.editor = new InPlaceEditor({ root: document.querySelector("#document"), theme: "github" });
      await editor.load(${JSON.stringify(complexDoc)});
    })()`);
    await settle();

    // 1. 验证 Math 块为完整单一槽位（含开闭 $$）
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll(".md-block")).find(el => el.dataset.blockType === "math-block" || el.classList.contains("md-block-math-block"));
      if (b) b.scrollIntoView({ block: "center", behavior: "instant" });
    })()`);
    await settle();

    const mathSlot = await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll(".md-block")).find(el => el.dataset.blockType === "math-block" || el.classList.contains("md-block-math-block"));
      if (!b) return null;
      const rect = b.getBoundingClientRect();
      const x = rect.left + 30;
      const y = rect.top + rect.height / 2;
      return {
        lineStart: parseInt(b.dataset.lineStart),
        lineEnd: parseInt(b.dataset.lineEnd),
        x, y,
        inViewport: x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight,
        hitsTarget: b.contains(document.elementFromPoint(x, y)),
        rect
      };
    })()`);
    assert.ok(mathSlot, 'Math 块槽位必须存在');
    assert.ok(mathSlot.lineEnd > mathSlot.lineStart, 'Math 块必须为覆盖开闭区间的整块槽位');
    assert.ok(mathSlot.inViewport, 'Math 块必须在视口内');
    assert.ok(mathSlot.hitsTarget, 'Math 块坐标必须命中目标槽位');

    // 记录点击前相邻参照段落外层位置
    const mathNeighborBefore = await evaluate(`(() => {
      const prev = Array.from(document.querySelectorAll(".md-block")).find(b => b.textContent.includes("前置参照段落文本"));
      const next = Array.from(document.querySelectorAll(".md-block")).find(b => b.textContent.includes("中间参照段落文本"));
      return {
        prevTop: prev ? prev.getBoundingClientRect().top : null,
        nextTop: next ? next.getBoundingClientRect().top : null
      };
    })()`);

    // 点击进入 Math 块
    await click(mathSlot.x, mathSlot.y);
    const mathActiveState = await evaluate(`(() => {
      const head = editor.view.state.selection.main.head;
      const line = editor.view.state.doc.lineAt(head).number;
      const prev = Array.from(document.querySelectorAll(".md-block")).find(b => b.textContent.includes("前置参照段落文本"));
      return {
        line,
        prevTop: prev ? prev.getBoundingClientRect().top : null
      };
    })()`);

    assert.ok(
      mathActiveState.line >= mathSlot.lineStart && mathActiveState.line <= mathSlot.lineEnd,
      `Math 块激活行 ${mathActiveState.line} 应在 [${mathSlot.lineStart}, ${mathSlot.lineEnd}] 范围内完整可编辑`
    );
    if (mathNeighborBefore.prevTop !== null && mathActiveState.prevTop !== null) {
      assert.ok(Math.abs(mathNeighborBefore.prevTop - mathActiveState.prevTop) <= 1.0, '点击 Math 块时邻块顶距应保持稳定');
    }

    // 2. 验证 Mermaid 块为完整单一槽位（含开闭 ```）
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll(".md-block")).find(el => (el.dataset.blockType && el.dataset.blockType.startsWith("diagram")) || el.classList.contains("md-block-diagram"));
      if (b) b.scrollIntoView({ block: "center", behavior: "instant" });
    })()`);
    await settle();

    const mermaidSlot = await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll(".md-block")).find(el => (el.dataset.blockType && el.dataset.blockType.startsWith("diagram")) || el.classList.contains("md-block-diagram"));
      if (!b) return null;
      const rect = b.getBoundingClientRect();
      const x = rect.left + 30;
      const y = rect.top + rect.height / 2;
      return {
        lineStart: parseInt(b.dataset.lineStart),
        lineEnd: parseInt(b.dataset.lineEnd),
        x, y,
        inViewport: x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight,
        hitsTarget: b.contains(document.elementFromPoint(x, y)),
        rect
      };
    })()`);
    assert.ok(mermaidSlot, 'Mermaid 块槽位必须存在');
    assert.ok(mermaidSlot.lineEnd > mermaidSlot.lineStart, 'Mermaid 块必须为覆盖开闭区间的整块槽位');
    assert.ok(mermaidSlot.inViewport, 'Mermaid 块坐标必须在视口内');
    assert.ok(mermaidSlot.hitsTarget, 'Mermaid 块坐标必须命中目标槽位');

    // 点击进入 Mermaid 块
    await click(mermaidSlot.x, mermaidSlot.y);
    const mermaidActiveState = await evaluate(`(() => {
      const head = editor.view.state.selection.main.head;
      const line = editor.view.state.doc.lineAt(head).number;
      return { line };
    })()`);
    assert.ok(
      mermaidActiveState.line >= mermaidSlot.lineStart && mermaidActiveState.line <= mermaidSlot.lineEnd,
      `Mermaid 块激活行 ${mermaidActiveState.line} 应在 [${mermaidSlot.lineStart}, ${mermaidSlot.lineEnd}] 范围内完整可编辑`
    );

    // 3. 溢出内部滚动验证（HTML 紧凑容器）
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll(".md-block")).find(el => el.textContent.includes("HTML第1行") || el.dataset.blockType === "html");
      if (b) b.scrollIntoView({ block: "center", behavior: "instant" });
    })()`);
    await settle();

    const htmlSlot = await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll(".md-block")).find(el => el.textContent.includes("HTML第1行") || el.dataset.blockType === "html");
      if (!b) return null;
      const rect = b.getBoundingClientRect();
      const x = rect.left + 30;
      const y = rect.top + rect.height / 2;
      return {
        lineStart: parseInt(b.dataset.lineStart),
        lineEnd: parseInt(b.dataset.lineEnd),
        x, y,
        inViewport: x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight,
        hitsTarget: b.contains(document.elementFromPoint(x, y)),
        rect
      };
    })()`);
    assert.ok(htmlSlot, 'HTML 紧凑槽位必须存在');
    assert.ok(htmlSlot.inViewport, 'HTML 槽位坐标必须在视口内');
    assert.ok(htmlSlot.hitsTarget, 'HTML 槽位坐标必须命中目标元素');
    await click(htmlSlot.x, htmlSlot.y);

    const scrollMetricsBefore = await evaluate(`(() => {
      const scroller = editor.view.scrollDOM || editor.view.dom.querySelector(".cm-scroller");
      const host = document.querySelector(".scroll-host");
      const slotEl = document.querySelector(".md-slot.is-active");
      const prevBlock = Array.from(document.querySelectorAll(".md-block")).find(b => b.textContent.includes("前置参照段落文本"));
      const nextBlock = Array.from(document.querySelectorAll(".md-block")).find(b => b.textContent.includes("中间参照段落文本"));
      return {
        hostScrollTop: host.scrollTop,
        slotRect: slotEl ? slotEl.getBoundingClientRect() : null,
        cmScrollTop: scroller ? scroller.scrollTop : 0,
        cmScrollHeight: scroller ? scroller.scrollHeight : 0,
        cmClientHeight: scroller ? scroller.clientHeight : 0,
        prevTop: prevBlock ? prevBlock.getBoundingClientRect().top : null,
        nextTop: nextBlock ? nextBlock.getBoundingClientRect().top : null
      };
    })()`);

    assert.ok(
      scrollMetricsBefore.cmScrollHeight > scrollMetricsBefore.cmClientHeight,
      `活动层内部必须溢出可滚 (scrollHeight=${scrollMetricsBefore.cmScrollHeight} > clientHeight=${scrollMetricsBefore.cmClientHeight})`
    );

    // 滚轮事件触发内部滚动
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: htmlSlot.x,
      y: htmlSlot.y,
      deltaX: 0,
      deltaY: 60
    });
    await settle();

    const scrollMetricsAfter = await evaluate(`(() => {
      const scroller = editor.view.scrollDOM || editor.view.dom.querySelector(".cm-scroller");
      const host = document.querySelector(".scroll-host");
      const slotEl = document.querySelector(".md-slot.is-active");
      const prevBlock = Array.from(document.querySelectorAll(".md-block")).find(b => b.textContent.includes("前置参照段落文本"));
      const nextBlock = Array.from(document.querySelectorAll(".md-block")).find(b => b.textContent.includes("中间参照段落文本"));
      return {
        hostScrollTop: host.scrollTop,
        slotRect: slotEl ? slotEl.getBoundingClientRect() : null,
        cmScrollTop: scroller ? scroller.scrollTop : 0,
        prevTop: prevBlock ? prevBlock.getBoundingClientRect().top : null,
        nextTop: nextBlock ? nextBlock.getBoundingClientRect().top : null
      };
    })()`);

    // 断言内部滚动发生且外层与相邻块完全稳定
    assert.ok(scrollMetricsAfter.cmScrollTop > 0, `滚轮应改变内部 cmScrollTop（当前为 ${scrollMetricsAfter.cmScrollTop}）`);
    assert.ok(
      Math.abs(scrollMetricsBefore.hostScrollTop - scrollMetricsAfter.hostScrollTop) <= 1.0,
      '滚轮不应引起外层 host.scrollTop 偏移'
    );
    if (scrollMetricsBefore.prevTop !== null && scrollMetricsAfter.prevTop !== null) {
      assert.ok(Math.abs(scrollMetricsBefore.prevTop - scrollMetricsAfter.prevTop) <= 1.0, '滚轮后前置块顶距保持稳定');
    }
    if (scrollMetricsBefore.nextTop !== null && scrollMetricsAfter.nextTop !== null) {
      assert.ok(Math.abs(scrollMetricsBefore.nextTop - scrollMetricsAfter.nextTop) <= 1.0, '滚轮后后置块顶距保持稳定');
    }

    // 4. 复杂块内 Enter 保持同一 block 固定高度断言
    // 将光标设置在 HTML 块内部第 2 行末尾（避免破坏开标签影响语义块）
    const beforeEnterState = await evaluate(`(() => {
      const slot = editor.activeSlot;
      const targetLine = slot.startLine + 2;
      const lineObj = editor.view.state.doc.line(targetLine);
      editor.view.dispatch({ selection: { anchor: lineObj.to } });
      const slotEl = document.querySelector(".md-slot.is-active");
      const nextBlock = Array.from(document.querySelectorAll(".md-block")).find(b => b.textContent.includes("中间参照段落文本"));
      return {
        linesBefore: editor.view.state.doc.lines,
        isComplexBefore: Boolean(slot && slot.isComplex),
        heightBefore: slotEl ? slotEl.getBoundingClientRect().height : 0,
        nextTopBefore: nextBlock ? nextBlock.getBoundingClientRect().top : null
      };
    })()`);
    await settle();

    await dispatchKey('Enter', 'Enter');
    const afterEnterState = await evaluate(`(() => {
      const slot = editor.activeSlot;
      const slotEl = document.querySelector(".md-slot.is-active");
      const nextBlock = Array.from(document.querySelectorAll(".md-block")).find(b => b.textContent.includes("中间参照段落文本"));
      return {
        linesAfter: editor.view.state.doc.lines,
        isComplexAfter: Boolean(slot && slot.isComplex),
        heightAfter: slotEl ? slotEl.getBoundingClientRect().height : 0,
        nextTopAfter: nextBlock ? nextBlock.getBoundingClientRect().top : null
      };
    })()`);

    assert.equal(
      afterEnterState.linesAfter,
      beforeEnterState.linesBefore + 1,
      `复杂块内 Enter 后行数必须增加 1 (前 ${beforeEnterState.linesBefore}, 后 ${afterEnterState.linesAfter})`
    );
    assert.equal(afterEnterState.isComplexAfter, true, '复杂块内 Enter 后 isComplex 仍为 true');
    assert.ok(
      Math.abs(beforeEnterState.heightBefore - afterEnterState.heightAfter) <= 1.0,
      `复杂块内 Enter 必须保持槽位高度固定 (前 ${beforeEnterState.heightBefore}, 后 ${afterEnterState.heightAfter})`
    );
    if (beforeEnterState.nextTopBefore !== null && afterEnterState.nextTopAfter !== null) {
      assert.ok(
        Math.abs(beforeEnterState.nextTopBefore - afterEnterState.nextTopAfter) <= 1.0,
        '复杂块内 Enter 不得引起后续块顶距下移'
      );
    }

    // 离开块并验证 source 完整保留
    await evaluate(`editor.commitActiveBlock()`);
    await settle();
    const finalComplexSource = await evaluate(`editor.getSource()`);
    assert.ok(finalComplexSource.includes('HTML第1行'), '提交后 source 必须完整保留');

    recordTest('complex_blocks_whole_block_editing_and_scroll', true, {
      mathSlot,
      mermaidSlot,
      scrollMetricsBefore,
      scrollMetricsAfter,
      beforeEnterState,
      afterEnterState
    });
  } catch (err) {
    recordTest('complex_blocks_whole_block_editing_and_scroll', false, { error: err.message });
  }

  // =========================================================================
  // 测试 4：文档变更事务与生命周期契约
  // =========================================================================
  log('\n--- 执行测试 4：文档变更事务契约 ---');
  try {
    const mutationDoc = [
      '# 初始标题',
      '',
      '第一段正文文本。',
      '',
      '![示例图片](images/sample.png)',
      '',
      '第二段正文文本。'
    ].join('\n');

    await evaluate(`(async () => {
      const h = document.querySelector(".scroll-host");
      if (h) h.scrollTop = 0;
      if (window.editor) window.editor.dispose();
      window.editor = new InPlaceEditor({ root: document.querySelector("#document"), theme: "github" });
      await editor.load(${JSON.stringify(mutationDoc)});
    })()`);
    await settle();

    // 4.1 getSource() 同步检查
    const initialSource = await evaluate(`editor.getSource()`);
    assert.equal(initialSource, mutationDoc, 'getSource() 内容与初始加载一致');

    // 4.2 Enter 创建新行（测试无 activeSlot 时 dispatch 选区真实激活）
    await evaluate(`(() => {
      const line = editor.view.state.doc.line(3);
      editor.view.focus();
      editor.view.dispatch({ selection: { anchor: line.from + 4 } });
    })()`);
    await settle();

    const linesBeforeEnter = await evaluate(`editor.view.state.doc.lines`);
    await dispatchKey('Enter', 'Enter');
    const linesAfterEnter = await evaluate(`editor.view.state.doc.lines`);
    assert.equal(linesAfterEnter, linesBeforeEnter + 1, '按下 Enter 后行数增加 1');

    // 4.3 Backspace 合并行
    await dispatchKey('Backspace', 'Backspace');
    const linesAfterBackspace = await evaluate(`editor.view.state.doc.lines`);
    assert.equal(linesAfterBackspace, linesBeforeEnter, '按下 Backspace 后行数应恢复合并');

    // 4.4 Undo 恢复状态
    await send('Input.insertText', { text: '【测试追加】' });
    await settle();
    const docWithExtra = await evaluate(`editor.getSource()`);
    assert.ok(docWithExtra.includes('【测试追加】'), '文档应包含追加文本');

    await evaluate(`window.undo(editor.view)`);
    await settle();
    const docAfterUndo = await evaluate(`editor.getSource()`);
    assert.ok(!docAfterUndo.includes('【测试追加】'), '执行 undo 后应撤销追加文本');

    // 4.5 全文搜索式全局选区跳转
    await evaluate(`editor.view.dispatch({ selection: { anchor: 2 } })`);
    await settle();
    const globalSel = await evaluate(`editor.view.state.selection.main.head`);
    assert.equal(globalSel, 2, '全局派发选区位置应准确设置');

    // 4.6 跨块选区与全文原文保持（禁止缩弱断言）
    const docLen = await evaluate(`editor.view.state.doc.length`);
    await evaluate(`editor.view.dispatch({ selection: { anchor: 0, head: ${docLen} } })`);
    await settle();
    const selectionState = await evaluate(`(() => {
      const sel = editor.view.state.selection.main;
      return {
        anchor: sel.anchor,
        head: sel.head,
        source: editor.getSource()
      };
    })()`);
    assert.equal(selectionState.anchor, 0, '跨块全选 anchor 必须为 0');
    assert.equal(selectionState.head, docLen, '跨块全选 head 必须为 docLen');
    assert.equal(selectionState.source, initialSource, '全选操作下 getSource() 全文内容必须保持一致不丢失');

    // 4.7 图片尺寸与 URL 修改
    const imageTestResult = await evaluate(`(() => {
      const docText = editor.getSource();
      const nodes = window.findImageNodes(docText);
      if (nodes.length === 0) return { error: "未找到图片节点" };
      const target = nodes[0];
      window.updateImageSize(editor.view, target, "60%");
      const afterSizeDoc = editor.getSource();

      const nodes2 = window.findImageNodes(afterSizeDoc);
      const target2 = nodes2[0];
      window.updateImageUrl(editor.view, target2, "images/updated.png");
      const finalDoc = editor.getSource();

      return {
        initialUrl: target.url,
        afterSizeDoc,
        finalDoc
      };
    })()`);

    assert.ok(!imageTestResult.error, imageTestResult.error);
    assert.ok(imageTestResult.afterSizeDoc.includes('width="60%"'), 'updateImageSize 成功增加 width 属性');
    assert.ok(imageTestResult.finalDoc.includes('images/updated.png'), 'updateImageUrl 成功修改 URL 路径');

    // 4.8 离开块后渲染新内容
    await evaluate(`(() => {
      const line1 = editor.view.state.doc.line(1);
      editor.view.dispatch({ changes: { from: 0, to: line1.to, insert: "# 动态标题更新" } });
    })()`);
    await evaluate(`editor.commitActiveBlock()`);
    await settle();

    const renderedTitle = await evaluate(`(() => {
      const h1 = document.querySelector("#document h1");
      return h1 ? h1.textContent : null;
    })()`);
    assert.equal(renderedTitle, '动态标题更新', '离开块提交后 DOM 渲染最新标题');

    recordTest('document_mutation_contracts', true, {
      initialSourceLength: initialSource.length,
      imageTestResult,
      renderedTitle
    });
  } catch (err) {
    recordTest('document_mutation_contracts', false, { error: err.message });
  }

  // =========================================================================
  // 测试 5：空白区域点击退出编辑与生命周期注销
  // =========================================================================
  log('\n--- 执行测试 5：空白区域点击退出编辑与生命周期注销 ---');
  try {
    const marginDoc = [
      '# 留白测试文档',
      '',
      '第一段正文文本用于点击测试。'
    ].join('\n');

    await evaluate(`(async () => {
      const h = document.querySelector(".scroll-host");
      if (h) h.scrollTop = 0;
      if (window.editor) window.editor.dispose();
      window.editor = new InPlaceEditor({ root: document.querySelector("#document"), theme: "github" });
      await editor.load(${JSON.stringify(marginDoc)});
    })()`);
    await settle();

    // 获取段落槽位坐标与外部 scroll-host 左右空白坐标
    const coords = await evaluate(`(() => {
      const slotEl = document.querySelector(".md-slot:nth-child(2)");
      const slotRect = slotEl.getBoundingClientRect();
      const host = document.querySelector(".scroll-host");
      const hostRect = host.getBoundingClientRect();
      return {
        slotX: slotRect.left + 50,
        slotY: slotRect.top + slotRect.height / 2,
        leftMarginX: Math.max(0, hostRect.left + 15),
        leftMarginY: slotRect.top + slotRect.height / 2,
        rightMarginX: Math.min(window.innerWidth - 10, hostRect.right - 15),
        rightMarginY: slotRect.top + slotRect.height / 2
      };
    })()`);

    // 1. 点击槽位激活，输入内容
    await click(coords.slotX, coords.slotY);
    await settle();
    const isEditing1 = await evaluate(`Boolean(editor.activeSlot)`);
    assert.ok(isEditing1, '点击段落应成功激活编辑槽位');

    await send('Input.insertText', { text: '【追加文本】' });
    await settle();

    // 2. 点击左侧空白退出编辑，验证渲染保留输入
    await click(coords.leftMarginX, coords.leftMarginY);
    await settle();
    const isEditingAfterLeftClick = await evaluate(`Boolean(editor.activeSlot)`);
    assert.equal(isEditingAfterLeftClick, false, '点击左空白应退出编辑并提交');
    const docAfterLeft = await evaluate(`editor.getSource()`);
    assert.ok(docAfterLeft.includes('【追加文本】'), '退出编辑后应保留输入内容');

    // 3. 再次激活，点击右侧空白退出编辑
    await click(coords.slotX, coords.slotY);
    await settle();
    const isEditing2 = await evaluate(`Boolean(editor.activeSlot)`);
    assert.ok(isEditing2, '再次点击应成功激活槽位');

    await click(coords.rightMarginX, coords.rightMarginY);
    await settle();
    const isEditingAfterRightClick = await evaluate(`Boolean(editor.activeSlot)`);
    assert.equal(isEditingAfterRightClick, false, '点击右空白应退出编辑');

    // 4. 再次激活并在框内点击，保持编辑状态
    await click(coords.slotX, coords.slotY);
    await settle();
    await click(coords.slotX + 20, coords.slotY);
    await settle();
    const isEditingInside = await evaluate(`Boolean(editor.activeSlot)`);
    assert.ok(isEditingInside, '框内再次点击应保持编辑状态不退出');

    // 5. dispose 后验证 mousedownTarget 事件正确移除
    await evaluate(`(() => {
      window.__testFiredAfterDispose = false;
      const target = editor.mousedownTarget;
      editor.dispose();
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    })()`);
    await settle();
    const disposedOk = await evaluate(`editor.mousedownTarget === null && editor.enabled === false`);
    assert.ok(disposedOk, 'dispose 后 mousedownTarget 被置空且编辑器被禁用');

    recordTest('margin_click_exit_and_lifecycle_cleanup', true, {
      leftMarginExit: true,
      rightMarginExit: true,
      insideClickRemains: true,
      disposedOk: true
    });
  } catch (err) {
    recordTest('margin_click_exit_and_lifecycle_cleanup', false, { error: err.message });
  }

  // 记录完整测试结果
  const jsonReport = JSON.stringify(suiteResults, null, 2);
  await writeFile(path.join(workDir, 'results.json'), jsonReport);
  await writeFile(path.join(workDir, 'before.json'), jsonReport);
  await writeFile(path.join(workDir, 'run.log'), logLines.join('\n'));

  log(`\n========================================`);
  log(`测试运行完成：通过 ${suiteResults.passed} 项，失败 ${suiteResults.failed} 项。`);
  log(`结果已保存至 ${path.join(workDir, 'results.json')} 与 before.json`);
  log(`========================================\n`);

  if (suiteResults.failed > 0) {
    process.exitCode = 1;
  }

} finally {
  try { ws.close(); } catch {}
  try { chrome.kill('SIGTERM'); } catch {}
  try { server.close(); } catch {}
}
