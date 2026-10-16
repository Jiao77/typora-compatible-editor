import { app, BrowserWindow, Menu, dialog, shell, ipcMain, nativeTheme } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { startServer } from '../server/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const isDev = Boolean(process.env.TYPORA_DEV);

let mainWindow = null;
let settingsWindow = null;
let serverInfo = null;
// 主进程持有未保存标记，窗口关闭时据此决定是否需要确认
let hasUnsavedChanges = false;
let allowClose = false;
// 标记本次关闭来自退出应用（⌘Q 或菜单退出），确认完成后需要连同应用一起退出
let isQuitting = false;

// 启动内置 Express 服务，渲染进程与导出功能共用同一套接口
async function ensureServer() {
  if (serverInfo) return serverInfo;
  serverInfo = await startServer({ port: 0 });
  return serverInfo;
}

// 主窗口：无边框一体化标题栏 + 隐藏式标题栏按钮，贴近原生 macOS 应用
function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    title: 'Typora 兼容编辑器',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(url);

  // 关闭确认在主进程处理：有未保存内容时询问，否则直接关闭
  // 渲染进程不再使用 beforeunload，避免窗口无法关闭
  mainWindow.on('close', async (event) => {
    if (allowClose || !hasUnsavedChanges) return;
    event.preventDefault();
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['保存并关闭', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
      message: '文档有未保存的修改',
      detail: '关闭前是否保存当前文档？'
    });
    if (response === 2) return;
    if (response === 0) {
      // 交给渲染进程保存，保存成功后由它回调 window:confirmClose 关闭窗口
      // 保存失败时窗口保持打开，避免丢失内容
      mainWindow.webContents.send('menu:saveAndClose');
      return;
    }
    allowClose = true;
    mainWindow.close();
    if (isQuitting) app.quit();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 站内地址（应用自身页面）留在应用内打开，站外链接交给系统浏览器
  // 原先一律 openExternal，导致内部页面被错误地跳到浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    const isInternal = serverInfo && target.startsWith(serverInfo.url);
    if (isInternal) {
      // 内部设置页等，统一由应用自己管理窗口
      openSettingsWindow();
      return { action: 'deny' };
    }
    shell.openExternal(target);
    return { action: 'deny' };
  });

  // 阻止渲染进程把主窗口导航到站外地址
  mainWindow.webContents.on('will-navigate', (event, target) => {
    const isInternal = serverInfo && target.startsWith(serverInfo.url);
    if (isInternal) return;
    event.preventDefault();
    shell.openExternal(target);
  });

  return mainWindow;
}

// 偏好设置窗口：独立窗口承载配置界面，避免占用主编辑区域
function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return settingsWindow;
  }
  if (!mainWindow) return null;

  settingsWindow = new BrowserWindow({
    width: 660,
    height: 620,
    minWidth: 560,
    minHeight: 480,
    parent: mainWindow,
    modal: false,
    title: '偏好设置',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f5f5f7',
    show: false,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadURL(`${serverInfo.url}/settings.html`);
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  return settingsWindow;
}

// 构建原生菜单，快捷键与 Typora 保持一致
function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { label: '关于本应用', role: 'about' },
        { type: 'separator' },
        {
          label: '偏好设置…',
          accelerator: 'Command+,',
          click: () => openSettingsWindow()
        },
        { type: 'separator' },
        { label: '隐藏', role: 'hide' },
        { label: '隐藏其它', role: 'hideOthers' },
        { label: '显示全部', role: 'unhide' },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '文件',
      submenu: [
        {
          label: '打开…',
          accelerator: 'Command+O',
          click: () => mainWindow?.webContents.send('menu:open')
        },
        {
          label: '保存',
          accelerator: 'Command+S',
          click: () => mainWindow?.webContents.send('menu:save')
        },
        { type: 'separator' },
        {
          label: '导出为 PDF…',
          click: () => mainWindow?.webContents.send('menu:export', 'pdf')
        },
        {
          label: '导出为 HTML…',
          click: () => mainWindow?.webContents.send('menu:export', 'html')
        },
        {
          label: '导出为 Word (docx)…',
          click: () => mainWindow?.webContents.send('menu:export', 'docx')
        },
        { type: 'separator' },
        { label: '关闭窗口', role: 'close' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
        { type: 'separator' },
        {
          label: '查找…',
          accelerator: 'Command+F',
          click: () => mainWindow?.webContents.send('menu:search')
        }
      ]
    },
    {
      label: '段落',
      submenu: [
        { label: '标题 1', click: () => mainWindow?.webContents.send('menu:format', '# ') },
        { label: '标题 2', click: () => mainWindow?.webContents.send('menu:format', '## ') },
        { label: '标题 3', click: () => mainWindow?.webContents.send('menu:format', '### ') },
        { type: 'separator' },
        { label: '加粗', click: () => mainWindow?.webContents.send('menu:wrap', ['**', '**']) },
        { label: '斜体', click: () => mainWindow?.webContents.send('menu:wrap', ['*', '*']) },
        { label: '删除线', click: () => mainWindow?.webContents.send('menu:wrap', ['~~', '~~']) },
        { label: '行内代码', click: () => mainWindow?.webContents.send('menu:wrap', ['`', '`']) },
        { type: 'separator' },
        { label: '插入图片…', click: () => mainWindow?.webContents.send('menu:image') },
        { label: '插入表格', click: () => mainWindow?.webContents.send('menu:insert', 'table') },
        { label: '插入公式块', click: () => mainWindow?.webContents.send('menu:insert', 'math') },
        { label: '插入代码围栏', click: () => mainWindow?.webContents.send('menu:insert', 'code') }
      ]
    },
    {
      label: '格式',
      submenu: [
        { label: '源码模式', accelerator: 'Command+/', click: () => mainWindow?.webContents.send('menu:source') },
        { type: 'separator' },
        { label: '增大字号', click: () => mainWindow?.webContents.send('menu:font', 1) },
        { label: '减小字号', click: () => mainWindow?.webContents.send('menu:font', -1) }
      ]
    },
    {
      label: '主题',
      submenu: [
        { label: '刷新主题列表', click: () => mainWindow?.webContents.send('menu:themes') },
        { type: 'separator' },
        {
          label: '打开主题文件夹',
          click: () => shell.openPath(path.join(app.getPath('home'), 'Library/Application Support/abnerworks.Typora/themes'))
        }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '缩放', role: 'zoom' },
        { type: 'separator' },
        { label: '前置全部窗口', role: 'front' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: 'Markdown 参考', click: () => shell.openExternal('https://support.typora.io/Markdown-Reference/') },
        { label: '开发者工具', accelerator: 'Alt+Command+I', role: 'toggleDevTools' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 渲染进程通过 IPC 请求原生对话框，实现真实的文件选择与保存
function registerIpc() {
  ipcMain.handle('dialog:openMarkdown', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '打开 Markdown 文件',
      properties: ['openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'mmd', 'mdown', 'mkd', 'mdx', 'qmd', 'txt'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:saveMarkdown', async (event, defaultPath) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存 Markdown 文件',
      defaultPath: defaultPath || '未命名文档.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    return result.canceled ? null : result.filePath;
  });

  ipcMain.handle('dialog:saveExport', async (event, { format, defaultPath } = {}) => {
    const filtersByFormat = {
      pdf: [{ name: 'PDF', extensions: ['pdf'] }],
      html: [{ name: 'HTML', extensions: ['html'] }],
      docx: [{ name: 'Word 文档', extensions: ['docx'] }],
      odt: [{ name: 'OpenDocument', extensions: ['odt'] }],
      rtf: [{ name: 'RTF', extensions: ['rtf'] }],
      epub: [{ name: 'EPUB', extensions: ['epub'] }],
      latex: [{ name: 'LaTeX', extensions: ['tex'] }],
      mediawiki: [{ name: 'MediaWiki', extensions: ['wiki'] }]
    };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出文档',
      defaultPath: defaultPath || `导出文件.${format === 'mediawiki' ? 'wiki' : format}`,
      filters: filtersByFormat[format] || [{ name: '全部文件', extensions: ['*'] }]
    });
    return result.canceled ? null : result.filePath;
  });

  ipcMain.handle('dialog:chooseImages', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }]
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('app:openSettings', () => {
    openSettingsWindow();
    return true;
  });

  // 渲染进程上报未保存状态，主进程据此决定关闭行为
  ipcMain.on('window:dirty', (event, dirty) => {
    hasUnsavedChanges = Boolean(dirty);
  });

  // 渲染进程保存完成后调用，真正关闭窗口
  // 若本次关闭源自退出应用，需要继续完成退出流程
  ipcMain.handle('window:confirmClose', () => {
    allowClose = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    if (isQuitting) app.quit();
    return true;
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    serverUrl: serverInfo ? serverInfo.url : null
  }));

  ipcMain.handle('shell:openExternal', (event, url) => shell.openExternal(url));
  ipcMain.handle('shell:showItem', (event, target) => shell.showItemInFolder(target));
}

app.whenReady().then(async () => {
  const info = await ensureServer();
  registerIpc();
  buildMenu();
  createMainWindow(info.url);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(info.url);
  });
});

// 退出前记录意图，窗口关闭确认完成后需要连同应用一起退出
app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
