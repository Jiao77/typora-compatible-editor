import express from 'express';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/server/render.js';
import { ThemeRegistry } from '../src/server/theme.js';

const workDir = path.resolve('work/render_highlight_20261017');
const profileDir = path.join(workDir, 'profile');
await mkdir(profileDir, { recursive: true });

const pythonRaw = `def hello(name: str) -> int:
    # greeting comment
    return 42`;

const jsRaw = `const name = "Typoar";
let active = true;`;

const jsonRaw = `{
  "project": "typoar",
  "count": 1
}`;

const unknownRaw = `<script>alert("safe")</script>`;

const mdContent = `
\`\`\`python
${pythonRaw}
\`\`\`

\`\`\`js
${jsRaw}
\`\`\`

\`\`\`json
${jsonRaw}
\`\`\`

\`\`\`unknownlang
${unknownRaw}
\`\`\`
`;

const { body: renderedHtml } = renderMarkdown(mdContent);

// 使用 ThemeRegistry 加载真实主题 CSS
const themes = new ThemeRegistry({
  bundledThemeDir: path.resolve('resources/themes')
});
const githubThemeCss = await themes.getCss('github');
const nightThemeCss = await themes.getCss('night');

const testPageHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style id="theme-style">${githubThemeCss}</style>
<link rel="stylesheet" href="/style/app.css">
</head>
<body data-theme="github" data-shell="light">
  <div id="write">
    ${renderedHtml}
  </div>
</body>
</html>`;

await writeFile(path.join(workDir, 'index.html'), testPageHtml);

const app = express();
app.use(express.static(workDir));
app.use('/style', express.static(path.resolve('public/style')));

const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const port = server.address().port;
const testUrl = `http://127.0.0.1:${port}/`;

// 启动无头 Chrome，profile 位于 work 目录下
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

  // 先注册 Page.loadEventFired 监听器，再执行导航
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

  const evalResult = await send('Runtime.evaluate', {
    expression: `(() => {
      const fences = document.querySelectorAll('.md-fences');
      const pythonFence = fences[0];
      const jsFence = fences[1];
      const jsonFence = fences[2];
      const unknownFence = fences[3];

      const defaultCodeColor = getComputedStyle(pythonFence.querySelector('.md-fence-code')).color;
      const keyword = pythonFence.querySelector('.hljs-keyword');
      const comment = pythonFence.querySelector('.hljs-comment');
      const number = pythonFence.querySelector('.hljs-number');
      const title = pythonFence.querySelector('.hljs-title');
      const string = jsFence.querySelector('.hljs-string');
      const attr = jsonFence.querySelector('.hljs-attr');

      const lightStyles = {
        defaultCodeColor,
        keyword: getComputedStyle(keyword).color,
        comment: getComputedStyle(comment).color,
        number: getComputedStyle(number).color,
        title: getComputedStyle(title).color,
        string: getComputedStyle(string).color,
        attr: getComputedStyle(attr).color
      };

      // 切换至暗色主题与真实 night.css
      document.querySelector('#theme-style').textContent = ${JSON.stringify(nightThemeCss)};
      document.body.dataset.shell = 'dark';
      document.body.dataset.theme = 'night';

      const darkStyles = {
        keyword: getComputedStyle(keyword).color,
        comment: getComputedStyle(comment).color,
        number: getComputedStyle(number).color,
        title: getComputedStyle(title).color,
        string: getComputedStyle(string).color,
        attr: getComputedStyle(attr).color
      };

      return {
        lightStyles,
        darkStyles,
        pythonText: pythonFence.querySelector('.md-fence-code').textContent.trim(),
        jsText: jsFence.querySelector('.md-fence-code').textContent.trim(),
        jsonText: jsonFence.querySelector('.md-fence-code').textContent.trim(),
        unknownText: unknownFence.querySelector('.md-fence-code').textContent.trim(),
        hasScriptTag: unknownFence.querySelector('script') !== null
      };
    })()`,
    returnByValue: true
  });

  if (evalResult.exceptionDetails) {
    throw new Error('Runtime.evaluate 执行异常：' + JSON.stringify(evalResult.exceptionDetails));
  }

  const results = evalResult.result.value;

  // 1. 颜色计算值断言
  assert.notEqual(results.lightStyles.keyword, results.lightStyles.defaultCodeColor, 'Light keyword color must differ from default');
  assert.notEqual(results.lightStyles.comment, results.lightStyles.defaultCodeColor, 'Light comment color must differ from default');
  assert.notEqual(results.lightStyles.number, results.lightStyles.defaultCodeColor, 'Light number color must differ from default');
  assert.notEqual(results.lightStyles.title, results.lightStyles.defaultCodeColor, 'Light title color must differ from default');
  assert.notEqual(results.lightStyles.string, results.lightStyles.defaultCodeColor, 'Light string color must differ from default');
  assert.notEqual(results.lightStyles.attr, results.lightStyles.defaultCodeColor, 'Light attr color must differ from default');

  // 2. 暗色主题断言（确认 title/type/section 离开浅色组 #032f62，且与亮色值不同）
  assert.notEqual(results.darkStyles.title, results.lightStyles.title, 'Dark title color must differ from light');
  assert.notEqual(results.darkStyles.string, results.lightStyles.string, 'Dark string color must differ from light');
  assert.notEqual(results.darkStyles.keyword, results.lightStyles.keyword, 'Dark keyword color must differ from light');
  assert.notEqual(results.darkStyles.comment, results.lightStyles.comment, 'Dark comment color must differ from light');
  assert.notEqual(results.darkStyles.number, results.lightStyles.number, 'Dark number color must differ from light');

  // 3. 源码 textContent 与原始代码精确一致
  assert.equal(results.pythonText, pythonRaw, 'Python textContent exactly matches raw source');
  assert.equal(results.jsText, jsRaw, 'JS textContent exactly matches raw source');
  assert.equal(results.jsonText, jsonRaw, 'JSON textContent exactly matches raw source');

  // 4. 未知语言安全转义与 raw code 一致
  assert.equal(results.hasScriptTag, false, 'No script element executed or injected');
  assert.equal(results.unknownText, unknownRaw, 'Unknown language preserves raw text safely');

  await writeFile(path.join(workDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log('Browser highlight test passed! Results:', JSON.stringify(results, null, 2));
} finally {
  if (ws) {
    ws.close();
  }
  chrome.kill('SIGTERM');
  server.close();
}
