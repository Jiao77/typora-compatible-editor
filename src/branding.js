import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

export const PRODUCT_NAME = 'TYPOAR';
export const BUNDLE_ID = 'com.jiao77.typora.editor';
export const LEGACY_DATA_DIR_NAME = 'typora-compatible-editor';

export const ICON_PNG_NAME = 'typo-ar.png';
export const ICON_ICNS_NAME = 'typo-ar.icns';

export const ICON_PNG_PATH = path.join(ROOT_DIR, 'resources', 'branding', ICON_PNG_NAME);
export const ICON_ICNS_PATH = path.join(ROOT_DIR, 'resources', 'branding', ICON_ICNS_NAME);

export function assertBrandAssetsExist(customRootDir = ROOT_DIR) {
  const pngPath = path.join(customRootDir, 'resources', 'branding', ICON_PNG_NAME);
  const icnsPath = path.join(customRootDir, 'resources', 'branding', ICON_ICNS_NAME);
  if (!existsSync(pngPath)) {
    throw new Error(`缺少品牌 PNG 图标文件：${pngPath}`);
  }
  if (!existsSync(icnsPath)) {
    throw new Error(`缺少品牌 ICNS 图标文件：${icnsPath}`);
  }
  return { pngPath, icnsPath };
}
