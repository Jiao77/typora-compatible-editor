// Electron 预加载脚本必须使用 CommonJS
// package.json 为 type: module，因此本文件使用 .cjs 后缀
const { contextBridge, ipcRenderer } = require('electron');

// 通过 contextBridge 暴露受控的原生能力，渲染进程不直接访问 Node
contextBridge.exposeInMainWorld('desktop', {
  // 原生文件对话框
  openMarkdown: () => ipcRenderer.invoke('dialog:openMarkdown'),
  saveMarkdown: (defaultPath) => ipcRenderer.invoke('dialog:saveMarkdown', defaultPath),
  saveExport: (payload) => ipcRenderer.invoke('dialog:saveExport', payload),
  chooseImages: () => ipcRenderer.invoke('dialog:chooseImages'),

  // 应用信息与偏好设置窗口
  appInfo: () => ipcRenderer.invoke('app:info'),
  openSettings: () => ipcRenderer.invoke('app:openSettings'),

  // 系统集成
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  showItemInFolder: (target) => ipcRenderer.invoke('shell:showItem', target),
  openThemeFolder: () => ipcRenderer.invoke('shell:openThemeFolder'),

  // 窗口关闭前保存确认
  confirmClose: (hasUnsaved) => ipcRenderer.invoke('window:confirmClose', hasUnsaved),
  reportDirtyState: (dirty) => ipcRenderer.send('window:dirty', Boolean(dirty)),

  // 菜单事件订阅；返回取消订阅函数
  onMenu: (handler) => {
    const channels = [
      'menu:open',
      'menu:save',
      'menu:saveAndClose',
      'menu:export',
      'menu:search',
      'menu:format',
      'menu:wrap',
      'menu:image',
      'menu:insert',
      'menu:source',
      'menu:font',
      'menu:themes'
    ];
    const listeners = channels.map((channel) => {
      const listener = (event, payload) => handler(channel.replace('menu:', ''), payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    });
    return () => listeners.forEach((off) => off());
  }
});
