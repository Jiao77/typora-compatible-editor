import { build } from 'esbuild';
import express from 'express';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const workDir = path.resolve('work/wheel_handoff_20261017');
await mkdir(workDir, { recursive: true });

const logLines = [];
function log(msg) {
  console.log(msg);
  logLines.push(msg);
}

log('[阶段] 1. 准备并构建滚轮测试 bundle...');
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
  log('[阶段] 测试包构建成功。');
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

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await settle();
}

const testResults = {
  timestamp: new Date().toISOString(),
  checks: {},
  passed: 0,
  failed: 0,
  failures: []
};

function recordCheck(name, passed, details = {}) {
  testResults.checks[name] = { passed, ...details };
  if (passed) {
    testResults.passed++;
    log(`[PASS] ${name}`);
  } else {
    testResults.failed++;
    testResults.failures.push({ name, details });
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

  const prefix = Array.from({ length: 15 }, (_, i) => `## 填充章节 ${i + 1}\n\n填充段落文本行 A ${i + 1}\n填充段落文本行 B ${i + 1}\n`).join('\n') + '\n';
  const midSection = [
    '### 滚轮测试段落',
    '',
    '非溢出普通段落文本内容。',
    '',
    '<div class="compact-html-preview" style="height:30px; overflow:hidden;">',
    '  <p>溢出内容行1</p>',
    '  <p>溢出内容行2</p>',
    '  <p>溢出内容行3</p>',
    '  <p>溢出内容行4</p>',
    '  <p>溢出内容行5</p>',
    '  <p>溢出内容行6</p>',
    '  <p>溢出内容行7</p>',
    '  <p>溢出内容行8</p>',
    '  <p>溢出内容行9</p>',
    '  <p>溢出内容行10</p>',
    '</div>',
    '',
    '后置参照段落文本。'
  ].join('\n');
  const suffix = '\n\n' + Array.from({ length: 15 }, (_, i) => `## 尾部章节 ${i + 1}\n\n尾部文本 ${i + 1}\n`).join('\n');
  const fullDoc = prefix + midSection + suffix;

  await evaluate(`(async () => {
    window.editor = new InPlaceEditor({ root: document.querySelector('#document'), theme: 'github' });
    await editor.load(${JSON.stringify(fullDoc)});
    await document.fonts.ready;
  })()`);
  await settle();

  // =========================================================================
  // 校验点 1：非溢出块内滚轮直接驱动外层页面滚动
  // =========================================================================
  log('\n--- 校验点 1：非溢出普通块滚轮驱动外层页面 ---');
  try {
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('.md-block')).find(el => el.textContent.includes('非溢出普通段落文本内容'));
      b.scrollIntoView({ block: 'center', behavior: 'instant' });
    })()`);
    await settle();

    // 重新获取真实坐标并断言命中
    const target1 = await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('.md-block')).find(el => el.textContent.includes('非溢出普通段落文本内容'));
      const r = b.getBoundingClientRect();
      const x = r.left + 30;
      const y = r.top + r.height / 2;
      return {
        x, y,
        inViewport: x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight,
        hit: b.contains(document.elementFromPoint(x, y)),
        initialHostTop: document.querySelector('.scroll-host').scrollTop
      };
    })()`);
    assert.ok(target1.inViewport && target1.hit, '非溢出目标块坐标必须在视口内且命中');

    // 激活非溢出块
    await click(target1.x, target1.y);

    // 向下滚轮 60px
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: target1.x, y: target1.y, deltaX: 0, deltaY: 60 });
    await settle();
    const hostTopAfterDown = await evaluate(`document.querySelector('.scroll-host').scrollTop`);
    assert.ok(hostTopAfterDown > target1.initialHostTop, '非溢出块内向下滚轮必须驱动外层页面');

    // 重新测量外层移动后的有效坐标并向上滚轮 60px
    const target1AfterScroll = await evaluate(`(() => {
      const slotEl = document.querySelector('.md-slot.is-active');
      const r = slotEl.getBoundingClientRect();
      const x = r.left + 30;
      const y = r.top + r.height / 2;
      return {
        x, y,
        inViewport: x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight,
        hit: slotEl.contains(document.elementFromPoint(x, y))
      };
    })()`);
    assert.ok(target1AfterScroll.inViewport && target1AfterScroll.hit, '滚动后坐标必须有效且命中活跃层');

    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: target1AfterScroll.x, y: target1AfterScroll.y, deltaX: 0, deltaY: -60 });
    await settle();
    const hostTopAfterUp = await evaluate(`document.querySelector('.scroll-host').scrollTop`);
    assert.ok(hostTopAfterUp < hostTopAfterDown, '非溢出块内向上滚轮必须驱动外层页面向上');

    recordCheck('non_overflow_block_scrolls_page', true, {
      initialHostTop: target1.initialHostTop,
      hostTopAfterDown,
      hostTopAfterUp
    });
  } catch (err) {
    recordCheck('non_overflow_block_scrolls_page', false, { error: err.message });
  }

  // =========================================================================
  // 校验点 2：溢出块内部滚动与外层页面隔离
  // =========================================================================
  log('\n--- 校验点 2：溢出块内部先滚动且外层页面保持静止 ---');
  let overflowTargetX = 0;
  let overflowTargetY = 0;
  let baselineHostTop = 0;

  try {
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('.md-block')).find(el => el.textContent.includes('溢出内容行1'));
      b.scrollIntoView({ block: 'center', behavior: 'instant' });
    })()`);
    await settle();

    const target2 = await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('.md-block')).find(el => el.textContent.includes('溢出内容行1'));
      const r = b.getBoundingClientRect();
      const x = r.left + 30;
      const y = r.top + r.height / 2;
      return {
        x, y,
        inViewport: x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight,
        hit: b.contains(document.elementFromPoint(x, y))
      };
    })()`);
    assert.ok(target2.inViewport && target2.hit, '溢出块目标坐标必须在视口内且命中');

    overflowTargetX = target2.x;
    overflowTargetY = target2.y;
    await click(overflowTargetX, overflowTargetY);

    const initialMetrics = await evaluate(`(() => {
      const scroller = editor.view.scrollDOM;
      const host = document.querySelector('.scroll-host');
      const slotEl = document.querySelector('.md-slot.is-active');
      const prevBlock = Array.from(document.querySelectorAll('.md-block')).find(b => b.textContent.includes('非溢出普通段落文本内容'));
      const nextBlock = Array.from(document.querySelectorAll('.md-block')).find(b => b.textContent.includes('后置参照段落文本'));
      return {
        hostTop: host.scrollTop,
        cmTop: scroller.scrollTop,
        cmHeight: scroller.clientHeight,
        cmScrollHeight: scroller.scrollHeight,
        slotHeight: slotEl.getBoundingClientRect().height,
        prevTop: prevBlock.getBoundingClientRect().top,
        nextTop: nextBlock.getBoundingClientRect().top
      };
    })()`);
    baselineHostTop = initialMetrics.hostTop;
    assert.ok(initialMetrics.cmScrollHeight > initialMetrics.cmHeight, '槽位必须处于溢出状态');
    assert.equal(initialMetrics.cmTop, 0, '初始内部滚动位置为 0');

    // 触发单次内部向下滚动
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: overflowTargetX, y: overflowTargetY, deltaX: 0, deltaY: 40 });
    await settle();

    const afterSingleWheel = await evaluate(`(() => {
      const scroller = editor.view.scrollDOM;
      const host = document.querySelector('.scroll-host');
      const slotEl = document.querySelector('.md-slot.is-active');
      const prevBlock = Array.from(document.querySelectorAll('.md-block')).find(b => b.textContent.includes('非溢出普通段落文本内容'));
      const nextBlock = Array.from(document.querySelectorAll('.md-block')).find(b => b.textContent.includes('后置参照段落文本'));
      return {
        hostTop: host.scrollTop,
        cmTop: scroller.scrollTop,
        slotHeight: slotEl.getBoundingClientRect().height,
        prevTop: prevBlock.getBoundingClientRect().top,
        nextTop: nextBlock.getBoundingClientRect().top
      };
    })()`);

    assert.ok(afterSingleWheel.cmTop > 0, '单次向下滚轮后内部 cmScrollTop 必须增加');
    assert.equal(afterSingleWheel.hostTop, baselineHostTop, '内部滚动未到边界前外层 hostTop 必须完全不变');
    assert.ok(Math.abs(afterSingleWheel.slotHeight - initialMetrics.slotHeight) <= 1.0, '槽位物理高度保持固定');
    assert.ok(Math.abs(afterSingleWheel.prevTop - initialMetrics.prevTop) <= 1.0, '前置块顶距保持稳定');
    assert.ok(Math.abs(afterSingleWheel.nextTop - initialMetrics.nextTop) <= 1.0, '后置块顶距保持稳定');

    recordCheck('overflow_block_scrolls_internally_without_page_shift', true, {
      cmTop: afterSingleWheel.cmTop,
      hostTop: afterSingleWheel.hostTop
    });
  } catch (err) {
    recordCheck('overflow_block_scrolls_internally_without_page_shift', false, { error: err.message });
  }

  // =========================================================================
  // 校验点 3：同一 burst 滚动到底部后拦截并消耗剩余惯性
  // =========================================================================
  log('\n--- 校验点 3：同一 burst 滚动到底部消耗剩余惯性 ---');
  try {
    // 连续高频向下滚动至触底（间隔 20ms < 200ms）
    for (let i = 0; i < 15; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: overflowTargetX, y: overflowTargetY, deltaX: 0, deltaY: 50 });
      await new Promise(r => setTimeout(r, 20));
    }
    await settle();

    const bottomBurstState = await evaluate(`(() => {
      const scroller = editor.view.scrollDOM;
      const host = document.querySelector('.scroll-host');
      return {
        hostTop: host.scrollTop,
        cmTop: scroller.scrollTop,
        maxScroll: scroller.scrollHeight - scroller.clientHeight
      };
    })()`);

    assert.ok(bottomBurstState.cmTop >= bottomBurstState.maxScroll - 1, '内部滚动必须已到达底部');
    assert.equal(bottomBurstState.hostTop, baselineHostTop, '同一手势到边界后剩余惯性必须被拦截，外层 hostTop 不动');

    recordCheck('bottom_boundary_burst_inertia_consumed', true, {
      cmTop: bottomBurstState.cmTop,
      maxScroll: bottomBurstState.maxScroll,
      hostTop: bottomBurstState.hostTop
    });
  } catch (err) {
    recordCheck('bottom_boundary_burst_inertia_consumed', false, { error: err.message });
  }

  // =========================================================================
  // 校验点 4：空闲停顿超过 200ms 后再次同向滚轮带动页面
  // =========================================================================
  log('\n--- 校验点 4：空闲 > 200ms 后再次向下滚轮驱动页面 ---');
  try {
    // 等待 260ms 超过 200ms 空闲阈值
    await new Promise(r => setTimeout(r, 260));

    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: overflowTargetX, y: overflowTargetY, deltaX: 0, deltaY: 60 });
    await settle();

    const afterIdleDown = await evaluate(`document.querySelector('.scroll-host').scrollTop`);
    assert.ok(afterIdleDown > baselineHostTop, `停顿后再次向下滚轮必须带动页面（原 ${baselineHostTop}，后 ${afterIdleDown}）`);

    recordCheck('idle_after_boundary_scrolls_page', true, {
      baselineHostTop,
      afterIdleDown
    });
  } catch (err) {
    recordCheck('idle_after_boundary_scrolls_page', false, { error: err.message });
  }

  // =========================================================================
  // 校验点 5：滚轮方向反转立即恢复内部向上滚动
  // =========================================================================
  log('\n--- 校验点 5：反转方向后立即恢复内部向上滚动 ---');
  try {
    // 页面下移后，重新计算当前活跃槽位在视口内的实际有效坐标
    const activeTarget = await evaluate(`(() => {
      const slotEl = document.querySelector('.md-slot.is-active');
      const r = slotEl.getBoundingClientRect();
      const x = r.left + 30;
      const y = r.top + r.height / 2;
      return {
        x, y,
        inViewport: x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight,
        hit: slotEl.contains(document.elementFromPoint(x, y)),
        currentHostTop: document.querySelector('.scroll-host').scrollTop,
        currentCmTop: editor.view.scrollDOM.scrollTop
      };
    })()`);
    assert.ok(activeTarget.inViewport && activeTarget.hit, '外层移动后槽位重新测算坐标必须有效');

    // 向上滚轮 40px
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: activeTarget.x, y: activeTarget.y, deltaX: 0, deltaY: -40 });
    await settle();

    const afterReverseUp = await evaluate(`(() => {
      const scroller = editor.view.scrollDOM;
      const host = document.querySelector('.scroll-host');
      return {
        hostTop: host.scrollTop,
        cmTop: scroller.scrollTop
      };
    })()`);

    assert.ok(afterReverseUp.cmTop < activeTarget.currentCmTop, '反转方向向上滚轮必须立即驱动内部 cmTop 减小');
    assert.equal(afterReverseUp.hostTop, activeTarget.currentHostTop, '反转方向恢复内部滚动时不应带动页面');

    recordCheck('direction_reversal_reclaims_inner_scroll', true, {
      beforeCmTop: activeTarget.currentCmTop,
      afterCmTop: afterReverseUp.cmTop,
      hostTop: afterReverseUp.hostTop
    });
  } catch (err) {
    recordCheck('direction_reversal_reclaims_inner_scroll', false, { error: err.message });
  }

  // =========================================================================
  // 校验点 6：对称性验证：向上滚动到顶部同一 burst 消耗惯性，停顿后驱动页面
  // =========================================================================
  log('\n--- 校验点 6：对称性验证（到顶消耗惯性与停顿后向上驱动页面） ---');
  try {
    // 重新获取当前有效坐标
    const activeTarget = await evaluate(`(() => {
      const slotEl = document.querySelector('.md-slot.is-active');
      const r = slotEl.getBoundingClientRect();
      return { x: r.left + 30, y: r.top + r.height / 2, hostTop: document.querySelector('.scroll-host').scrollTop };
    })()`);

    // 连续向上滚轮直至到顶
    for (let i = 0; i < 15; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: activeTarget.x, y: activeTarget.y, deltaX: 0, deltaY: -50 });
      await new Promise(r => setTimeout(r, 20));
    }
    await settle();

    const topBurstState = await evaluate(`(() => {
      const scroller = editor.view.scrollDOM;
      const host = document.querySelector('.scroll-host');
      return { cmTop: scroller.scrollTop, hostTop: host.scrollTop };
    })()`);

    assert.equal(topBurstState.cmTop, 0, '内部滚动必须已到顶 (cmTop === 0)');
    assert.equal(topBurstState.hostTop, activeTarget.hostTop, '同手势到顶后剩余惯性必须被拦截，外层 hostTop 不动');

    // 停顿超过 200ms
    await new Promise(r => setTimeout(r, 260));

    // 再次向上滚轮
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: activeTarget.x, y: activeTarget.y, deltaX: 0, deltaY: -60 });
    await settle();

    const afterIdleUpHostTop = await evaluate(`document.querySelector('.scroll-host').scrollTop`);
    assert.ok(afterIdleUpHostTop < activeTarget.hostTop, '停顿后再次向上滚轮必须带动外层页面向上滚动');

    recordCheck('top_boundary_symmetry_and_page_handoff', true, {
      topBurstHostTop: topBurstState.hostTop,
      afterIdleUpHostTop
    });
  } catch (err) {
    recordCheck('top_boundary_symmetry_and_page_handoff', false, { error: err.message });
  }

  // =========================================================================
  // 校验点 7：切块重置与手势状态隔离
  // =========================================================================
  log('\n--- 校验点 7：切块重置与滚动偏移清理 ---');
  try {
    // 点击并切换至非溢出块
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('.md-block')).find(el => el.textContent.includes('非溢出普通段落文本内容'));
      b.scrollIntoView({ block: 'center', behavior: 'instant' });
    })()`);
    await settle();

    const nonOverflowPos = await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('.md-block')).find(el => el.textContent.includes('非溢出普通段落文本内容'));
      const r = b.getBoundingClientRect();
      return { x: r.left + 30, y: r.top + r.height / 2 };
    })()`);
    await click(nonOverflowPos.x, nonOverflowPos.y);

    // 切回溢出 HTML 块
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('.md-block')).find(el => el.textContent.includes('溢出内容行1'));
      b.scrollIntoView({ block: 'center', behavior: 'instant' });
    })()`);
    await settle();

    const overflowPos = await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll('.md-block')).find(el => el.textContent.includes('溢出内容行1'));
      const r = b.getBoundingClientRect();
      return { x: r.left + 30, y: r.top + r.height / 2 };
    })()`);
    await click(overflowPos.x, overflowPos.y);

    const recheckState = await evaluate(`(() => {
      const scroller = editor.view.scrollDOM;
      return { cmTop: scroller.scrollTop };
    })()`);
    assert.equal(recheckState.cmTop, 0, '重新切入槽位后 cmScrollTop 必须已干净重置为 0');

    recordCheck('slot_switch_resets_scroll_and_gesture', true, {
      cmTop: recheckState.cmTop
    });
  } catch (err) {
    recordCheck('slot_switch_resets_scroll_and_gesture', false, { error: err.message });
  }

  // 记录完整测试结果
  const jsonReport = JSON.stringify(testResults, null, 2);
  await writeFile(path.join(workDir, 'results.json'), jsonReport);
  await writeFile(path.join(workDir, 'wheel.log'), logLines.join('\n'));

  log(`\n========================================`);
  log(`滚轮手势测试完成：通过 ${testResults.passed} 项，失败 ${testResults.failed} 项。`);
  log(`结果已保存至 ${path.join(workDir, 'results.json')} 与 wheel.log`);
  log(`========================================\n`);

  if (testResults.failed > 0) {
    process.exitCode = 1;
  }

} finally {
  try { ws.close(); } catch {}
  try { chrome.kill('SIGTERM'); } catch {}
  try { server.close(); } catch {}
}
