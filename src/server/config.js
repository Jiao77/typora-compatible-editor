import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

// Typora 本机真实目录，作为默认值
export const TYPORA_HOME = path.join(os.homedir(), 'Library/Application Support/abnerworks.Typora');
export const DEFAULT_USER_THEME_DIR = path.join(TYPORA_HOME, 'themes');
export const DEFAULT_BUILTIN_THEME_DIR =
  '/Applications/Typora.app/Contents/Resources/TypeMark/style/themes';

export const DEFAULT_SETTINGS = {
  theme: 'Github',
  darkTheme: 'Latex',
  image_uploader: 'ipic',
  enable_inline_math: true,
  strict_mode: true,
  allowPhysicsConflict: true,
  // 界面与编辑偏好
  followSystem: true,
  fontSize: 16,
  autoSave: false,
  autoSaveDelay: 5,
  spellcheck: true,
  enable_diagrams: true,
  enable_toc: true,
  // 导出与图床偏好
  pageSize: 'A4',
  margin: 16,
  endpoint: '',
  targetDir: '',
  url: ''
};

// 设置文件写入工程自身目录，避免污染 Typora 用户配置
export function settingsPath(rootDir) {
  return path.join(rootDir, 'work', 'settings.json');
}

export async function loadSettings(rootDir) {
  try {
    const raw = await readFile(settingsPath(rootDir), 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw error;
  }
}

export async function saveSettings(rootDir, patch) {
  const current = await loadSettings(rootDir);
  const next = { ...current, ...patch };
  const target = settingsPath(rootDir);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

// 恢复默认设置并写入磁盘，返回恢复后的完整设置
export async function resetSettings(rootDir) {
  const target = settingsPath(rootDir);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, 'utf8');
  return { ...DEFAULT_SETTINGS };
}
