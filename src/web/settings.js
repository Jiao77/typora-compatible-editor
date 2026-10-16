// 偏好设置窗口逻辑：读写设置、主题列表、图床探测与运行环境展示

const elements = {
  nav: document.querySelectorAll('.nav-item'),
  sections: document.querySelectorAll('.settings-section'),
  theme: document.querySelector('#set-theme'),
  darkTheme: document.querySelector('#set-dark-theme'),
  followSystem: document.querySelector('#set-follow-system'),
  fontSize: document.querySelector('#set-font-size'),
  fontSizeValue: document.querySelector('#set-font-size-value'),
  autoSave: document.querySelector('#set-auto-save'),
  autoSaveDelay: document.querySelector('#set-auto-save-delay'),
  autoSaveDelayValue: document.querySelector('#set-auto-save-delay-value'),
  spellcheck: document.querySelector('#set-spellcheck'),
  strictMode: document.querySelector('#set-strict-mode'),
  inlineMath: document.querySelector('#set-inline-math'),
  allowPhysics: document.querySelector('#set-allow-physics'),
  enableDiagrams: document.querySelector('#set-enable-diagrams'),
  enableToc: document.querySelector('#set-enable-toc'),
  uploader: document.querySelector('#set-uploader'),
  picgoEndpoint: document.querySelector('#set-picgo-endpoint'),
  targetDir: document.querySelector('#set-target-dir'),
  customUrl: document.querySelector('#set-custom-url'),
  checkPicgo: document.querySelector('#check-picgo'),
  picgoStatus: document.querySelector('#picgo-status'),
  pageSize: document.querySelector('#set-page-size'),
  margin: document.querySelector('#set-margin'),
  marginValue: document.querySelector('#set-margin-value'),
  envChrome: document.querySelector('#env-chrome'),
  envPandoc: document.querySelector('#env-pandoc'),
  envThemes: document.querySelector('#env-themes'),
  envElectron: document.querySelector('#env-electron'),
  envChromium: document.querySelector('#env-chromium'),
  envNode: document.querySelector('#env-node'),
  aboutVersion: document.querySelector('#about-version'),
  save: document.querySelector('#settings-save'),
  reset: document.querySelector('#settings-reset'),
  status: document.querySelector('#settings-status')
};

function setStatus(message, kind = '') {
  elements.status.textContent = message;
  elements.status.className = `settings-status${kind ? ` is-${kind}` : ''}`;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`接口返回非 JSON 内容：${text.slice(0, 160)}`);
    }
  }
  if (!response.ok) {
    throw new Error((payload && payload.error) || `请求失败，状态码 ${response.status}`);
  }
  return payload;
}

// 分类导航切换
for (const item of elements.nav) {
  item.addEventListener('click', () => {
    const target = item.dataset.section;
    for (const nav of elements.nav) nav.classList.toggle('is-active', nav === item);
    for (const section of elements.sections) {
      section.classList.toggle('is-active', section.dataset.section === target);
    }
  });
}

// 滑块数值实时回显
elements.fontSize.addEventListener('input', () => {
  elements.fontSizeValue.textContent = `${elements.fontSize.value} px`;
});
elements.autoSaveDelay.addEventListener('input', () => {
  elements.autoSaveDelayValue.textContent = `${elements.autoSaveDelay.value} 秒`;
});
elements.margin.addEventListener('input', () => {
  elements.marginValue.textContent = `${elements.margin.value} 毫米`;
});

async function loadThemes() {
  const payload = await requestJson('/api/themes');
  const fill = (select, selected) => {
    select.innerHTML = '';
    for (const theme of payload.themes) {
      const option = document.createElement('option');
      option.value = theme.id;
      option.textContent = `${theme.id}（${theme.source === 'user' ? '用户' : '内置'}）`;
      select.append(option);
    }
    if (selected) select.value = selected;
  };
  fill(elements.theme, 'github');
  fill(elements.darkTheme, 'night');
  return payload.themes;
}

async function loadUploaders() {
  const payload = await requestJson('/api/images/uploaders');
  elements.uploader.innerHTML = '';
  for (const item of payload.uploaders) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name || item.id;
    elements.uploader.append(option);
  }
  if (payload.defaultEndpoint) elements.picgoEndpoint.placeholder = payload.defaultEndpoint;
}

// Typora 配置使用驼峰主题名，需要归一化为文件名
function normalizeThemeName(value) {
  return String(value)
    .replace(/\s*([A-Z])/g, '-$1')
    .replace(/^-/, '')
    .toLowerCase()
    .replace(/\.css$/, '');
}

function applySettings(settings) {
  elements.theme.value = normalizeThemeName(settings.theme || 'github');
  elements.darkTheme.value = normalizeThemeName(settings.darkTheme || 'night');
  elements.followSystem.checked = settings.followSystem !== false;
  elements.fontSize.value = String(settings.fontSize || 16);
  elements.fontSizeValue.textContent = `${elements.fontSize.value} px`;
  elements.autoSave.checked = settings.autoSave === true;
  elements.autoSaveDelay.value = String(settings.autoSaveDelay || 5);
  elements.autoSaveDelayValue.textContent = `${elements.autoSaveDelay.value} 秒`;
  elements.spellcheck.checked = settings.spellcheck !== false;
  elements.strictMode.checked = settings.strict_mode !== false;
  elements.inlineMath.checked = settings.enable_inline_math !== false;
  elements.allowPhysics.checked = settings.allowPhysicsConflict !== false;
  elements.enableDiagrams.checked = settings.enable_diagrams !== false;
  elements.enableToc.checked = settings.enable_toc !== false;
  elements.uploader.value = settings.image_uploader || 'ipic';
  elements.picgoEndpoint.value = settings.endpoint || '';
  elements.targetDir.value = settings.targetDir || '';
  elements.customUrl.value = settings.url || '';
  elements.pageSize.value = settings.pageSize || 'A4';
  elements.margin.value = String(settings.margin || 16);
  elements.marginValue.textContent = `${elements.margin.value} 毫米`;
}

function collectSettings() {
  return {
    theme: elements.theme.value,
    darkTheme: elements.darkTheme.value,
    followSystem: elements.followSystem.checked,
    fontSize: Number(elements.fontSize.value),
    autoSave: elements.autoSave.checked,
    autoSaveDelay: Number(elements.autoSaveDelay.value),
    spellcheck: elements.spellcheck.checked,
    strict_mode: elements.strictMode.checked,
    enable_inline_math: elements.inlineMath.checked,
    allowPhysicsConflict: elements.allowPhysics.checked,
    enable_diagrams: elements.enableDiagrams.checked,
    enable_toc: elements.enableToc.checked,
    image_uploader: elements.uploader.value,
    endpoint: elements.picgoEndpoint.value.trim(),
    targetDir: elements.targetDir.value.trim(),
    url: elements.customUrl.value.trim(),
    pageSize: elements.pageSize.value,
    margin: Number(elements.margin.value)
  };
}

async function loadEnvironment() {
  try {
    const payload = await requestJson('/api/environment');
    elements.envChrome.textContent = payload.chrome || '未检测到';
    elements.envPandoc.textContent = payload.pandoc || '未检测到';
    elements.envThemes.textContent = `${payload.themes} 个`;
    // Chrome 路径较长，保留文件名部分便于阅读
    elements.envChrome.textContent = String(payload.chrome || '未检测到').split('/').pop();
    elements.envPandoc.textContent = String(payload.pandoc || '未检测到').split('/').pop();
  } catch (error) {
    elements.envChrome.textContent = '检测失败';
    elements.envPandoc.textContent = '检测失败';
    elements.envThemes.textContent = '检测失败';
  }

  if (window.desktop && window.desktop.appInfo) {
    try {
      const info = await window.desktop.appInfo();
      elements.envElectron.textContent = info.electron || '—';
      elements.envChromium.textContent = info.chrome || '—';
      elements.envNode.textContent = info.node || '—';
      elements.aboutVersion.textContent = `版本 ${info.version} · Electron ${info.electron}`;
    } catch (error) {
      elements.aboutVersion.textContent = '版本信息读取失败';
    }
  } else {
    elements.aboutVersion.textContent = '浏览器模式';
  }
}

elements.checkPicgo.addEventListener('click', async () => {
  elements.picgoStatus.className = 'status-note';
  elements.picgoStatus.textContent = '检测中…';
  try {
    const endpoint = elements.picgoEndpoint.value.trim() || 'http://127.0.0.1:36677/upload';
    const payload = await requestJson(`/api/images/status?endpoint=${encodeURIComponent(endpoint)}`);
    elements.picgoStatus.className = `status-note ${payload.online ? 'is-ok' : 'is-error'}`;
    elements.picgoStatus.textContent = payload.online ? '服务在线' : '服务未启动';
  } catch (error) {
    elements.picgoStatus.className = 'status-note is-error';
    elements.picgoStatus.textContent = `检测失败：${error.message}`;
  }
});

elements.save.addEventListener('click', async () => {
  setStatus('正在保存…');
  try {
    await requestJson('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectSettings())
    });
    setStatus('设置已保存', 'ok');
  } catch (error) {
    setStatus(`保存失败：${error.message}`, 'error');
  }
});

elements.reset.addEventListener('click', async () => {
  setStatus('正在恢复默认…');
  try {
    const payload = await requestJson('/api/settings/reset', { method: 'POST' });
    applySettings(payload);
    setStatus('已恢复默认设置', 'ok');
  } catch (error) {
    setStatus(`恢复失败：${error.message}`, 'error');
  }
});

async function bootstrap() {
  try {
    await Promise.all([loadThemes(), loadUploaders()]);
    const settings = await requestJson('/api/settings');
    applySettings(settings);
    loadEnvironment();
    setStatus('');
  } catch (error) {
    setStatus(`初始化失败：${error.message}`, 'error');
  }
}

bootstrap();
