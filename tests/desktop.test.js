import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 桌面外壳的结构契约：主进程、预加载脚本与两个窗口页面必须齐备
test('Electron 主进程与预加载脚本存在且导出必要能力', async () => {
  const main = await readFile(path.join(rootDir, 'src/electron/main.js'), 'utf8');
  const preload = await readFile(path.join(rootDir, 'src/electron/preload.cjs'), 'utf8');

  assert.match(main, /new BrowserWindow/, '主进程必须创建 BrowserWindow');
  assert.match(main, /titleBarStyle: 'hiddenInset'/, '应使用无边框一体化标题栏');
  assert.match(main, /Menu\.buildFromTemplate/, '应构建原生菜单');
  assert.match(main, /dialog\.showOpenDialog/, '应提供原生打开对话框');
  assert.match(main, /dialog\.showSaveDialog/, '应提供原生保存对话框');
  assert.match(main, /openSettingsWindow/, '应提供独立的偏好设置窗口');

  assert.match(preload, /contextBridge\.exposeInMainWorld/, '必须通过 contextBridge 暴露能力');
  assert.match(preload, /ipcRenderer\.invoke/, '原生能力必须通过 IPC 调用');
  assert.ok(!preload.includes('nodeIntegration: true'), '预加载脚本不应启用 Node 集成');
});

test('预加载脚本使用 CommonJS，避免加载失败导致原生能力丢失', async () => {
  const preload = await readFile(path.join(rootDir, 'src/electron/preload.cjs'), 'utf8');
  // package.json 为 type: module，预加载若用 ESM 会静默失败，界面将回退到浏览器跳转
  assert.match(preload, /require\('electron'\)/, '预加载必须使用 require');
  assert.ok(!/^import\s/m.test(preload), '预加载不得使用 ESM import');
});

test('主进程接管关闭确认，渲染进程不阻塞窗口关闭', async () => {
  const main = await readFile(path.join(rootDir, 'src/electron/main.js'), 'utf8');
  const app = await readFile(path.join(rootDir, 'src/web/app.js'), 'utf8');

  assert.match(main, /mainWindow\.on\('close'/, '主进程必须处理窗口关闭');
  assert.match(main, /showMessageBox/, '有未保存内容时必须使用原生确认对话框');
  assert.match(main, /window:confirmClose/, '渲染进程保存完成后需要关闭窗口的通道');

  // beforeunload 只能上报状态，不能阻止关闭
  assert.ok(!/returnValue/.test(app), 'beforeunload 不得通过 returnValue 阻止关闭');
  assert.ok(!/preventDefault/.test(app.split('beforeunload')[1] || ''), 'beforeunload 内不得调用 preventDefault');
});

test('站内页面留在应用内打开，站外链接才交给浏览器', async () => {
  const main = await readFile(path.join(rootDir, 'src/electron/main.js'), 'utf8');
  assert.match(main, /setWindowOpenHandler/, '必须限制窗口打开行为');
  assert.match(main, /will-navigate/, '必须限制主窗口导航');
  assert.match(main, /isInternal/, '必须区分站内与站外地址');
});

test('桌面外壳启用进程隔离并禁用 Node 集成', async () => {
  const main = await readFile(path.join(rootDir, 'src/electron/main.js'), 'utf8');
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
});

test('package.json 配置桌面启动入口与脚本', async () => {
  const pkg = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'src/electron/main.js');
  assert.ok(pkg.scripts.desktop, '应提供 desktop 启动脚本');
  assert.ok(pkg.devDependencies.electron, '应声明 electron 依赖');
});

test('编辑器页面提供优雅界面所需的全部结构', async () => {
  const html = await readFile(path.join(rootDir, 'public/index.html'), 'utf8');
  for (const id of [
    'document', 'sidebar', 'outline', 'doc-title', 'word-count',
    'btn-sidebar', 'btn-source', 'btn-settings', 'btn-search',
    'btn-theme', 'btn-export', 'btn-image',
    'theme-menu', 'export-menu', 'search-bar'
  ]) {
    assert.ok(html.includes(`id="${id}"`), `界面缺少 ${id} 元素`);
  }
  assert.ok(html.includes('worker-src'), 'CSP 必须允许 blob worker，否则图表渲染会挂起');
});

test('偏好设置页面按分类组织并覆盖全部设置项', async () => {
  const html = await readFile(path.join(rootDir, 'public/settings.html'), 'utf8');
  for (const section of ['appearance', 'editor', 'markdown', 'image', 'export', 'about']) {
    assert.ok(html.includes(`data-section="${section}"`), `缺少设置分类 ${section}`);
  }
  for (const id of [
    'set-theme', 'set-dark-theme', 'set-font-size', 'set-auto-save',
    'set-inline-math', 'set-uploader', 'set-picgo-endpoint',
    'set-page-size', 'set-margin', 'settings-save', 'settings-reset'
  ]) {
    assert.ok(html.includes(`id="${id}"`), `设置页面缺少 ${id} 控件`);
  }
});

test('设置重置接口恢复默认值', async () => {
  const server = await import('../src/server/index.js');
  const http = await import('node:http');
  const instance = http.createServer(server.app);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const { port } = instance.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    // 先写入非默认值
    await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fontSize: 22, autoSave: true })
    });
    const modified = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(modified.fontSize, 22);

    // 再恢复默认
    const reset = await fetch(`${base}/api/settings/reset`, { method: 'POST' });
    assert.equal(reset.status, 200);
    const payload = await reset.json();
    assert.equal(payload.fontSize, 16);
    assert.equal(payload.autoSave, false);

    const after = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(after.fontSize, 16, '恢复后磁盘上的设置应为默认值');
  } finally {
    await new Promise((resolve) => instance.close(resolve));
  }
});
