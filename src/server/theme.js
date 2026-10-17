import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';

const THEME_ASSET_PREFIX = '/theme-assets';

const includeWhenExportPlugin = {
  postcssPlugin: 'typora-include-when-export',
  AtRule: {
    'include-when-export': () => {
      // Typora 自定义 at-rule 由 PostCSS 原样保留，显式注册避免后续插件误判。
    },
  },
};

function normalizeThemeId(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .trim()
    .replace(/\.css$/i, '')
    .replace(/\s*([A-Z])/g, '-$1')
    .replace(/^-/, '')
    .toLowerCase();
}

function themeIdCandidates(value) {
  if (typeof value !== 'string') {
    return [];
  }

  const withoutSuffix = value.trim().replace(/\.css$/i, '');
  const candidates = [
    normalizeThemeId(withoutSuffix),
    withoutSuffix.replace(/\s+/g, '-').toLowerCase(),
  ];

  return [...new Set(candidates.filter((candidate) => candidate !== ''))];
}

function cssFilesInDirectory(directory) {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.css'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function isPathInside(rootDirectory, candidatePath) {
  const relativePath = path.relative(rootDirectory, candidatePath);

  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function splitRequestSuffix(requestPath) {
  const separatorIndex = requestPath.search(/[?#]/);

  if (separatorIndex === -1) {
    return { pathname: requestPath, suffix: '' };
  }

  return {
    pathname: requestPath.slice(0, separatorIndex),
    suffix: requestPath.slice(separatorIndex),
  };
}

function isExternalRequest(requestPath) {
  const trimmedPath = requestPath.trim();

  return (
    trimmedPath === '' ||
    trimmedPath.startsWith('/') ||
    trimmedPath.startsWith('//') ||
    trimmedPath.startsWith('#') ||
    /^[a-z][a-z\d+.-]*:/i.test(trimmedPath)
  );
}

function resolveExistingFileWithin(rootDirectory, baseDirectory, requestPath) {
  if (typeof requestPath !== 'string' || requestPath.includes('\0')) {
    return null;
  }

  const { pathname } = splitRequestSuffix(requestPath);
  const candidatePath = path.resolve(baseDirectory, pathname);

  if (!isPathInside(rootDirectory, candidatePath)) {
    return null;
  }

  const fileStat = statSync(candidatePath, { throwIfNoEntry: false });

  if (!fileStat?.isFile()) {
    return null;
  }

  return candidatePath;
}

function findUrlFunction(value, fromIndex) {
  const lowerValue = value.toLowerCase();
  let index = lowerValue.indexOf('url(', fromIndex);

  while (index !== -1) {
    const beforeCharacter = index === 0 ? '' : value[index - 1];

    if (beforeCharacter === '' || !/[a-z0-9_-]/i.test(beforeCharacter)) {
      return index;
    }

    index = lowerValue.indexOf('url(', index + 4);
  }

  return -1;
}

function parseUrlFunction(value, startIndex) {
  if (value.slice(startIndex, startIndex + 4).toLowerCase() !== 'url(') {
    return null;
  }

  let index = startIndex + 4;

  while (index < value.length && /\s/.test(value[index])) {
    index += 1;
  }

  if (value[index] === '"' || value[index] === "'") {
    const quote = value[index];
    const contentStart = index + 1;
    index = contentStart;

    while (index < value.length) {
      if (value[index] === '\\') {
        index += 2;
        continue;
      }

      if (value[index] === quote) {
        break;
      }

      index += 1;
    }

    if (index >= value.length) {
      return null;
    }

    const rawUrl = value.slice(contentStart, index);
    index += 1;

    while (index < value.length && /\s/.test(value[index])) {
      index += 1;
    }

    if (value[index] !== ')') {
      return null;
    }

    return { url: rawUrl, endIndex: index + 1 };
  }

  const contentStart = index;

  while (index < value.length && value[index] !== ')') {
    index += 1;
  }

  if (index >= value.length) {
    return null;
  }

  return {
    url: value.slice(contentStart, index).trim(),
    endIndex: index + 1,
  };
}

function parseImportRequest(params) {
  const trimmedParams = params.trim();

  if (trimmedParams === '') {
    return null;
  }

  if (trimmedParams.toLowerCase().startsWith('url(')) {
    return parseUrlFunction(trimmedParams, 0)?.url ?? null;
  }

  if (trimmedParams[0] === '"' || trimmedParams[0] === "'") {
    const quote = trimmedParams[0];
    let index = 1;

    while (index < trimmedParams.length) {
      if (trimmedParams[index] === '\\') {
        index += 2;
        continue;
      }

      if (trimmedParams[index] === quote) {
        return trimmedParams.slice(1, index);
      }

      index += 1;
    }

    return null;
  }

  const whitespaceIndex = trimmedParams.search(/\s/);

  return whitespaceIndex === -1
    ? trimmedParams
    : trimmedParams.slice(0, whitespaceIndex);
}

function encodeRoutePath(relativePath) {
  return relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function createThemeAssetRoute(requestUrl, { themeId, themeRoot, baseDirectory }) {
  const trimmedUrl = requestUrl.trim();

  if (isExternalRequest(trimmedUrl)) {
    return null;
  }

  const { pathname, suffix } = splitRequestSuffix(trimmedUrl);
  const filePath = resolveExistingFileWithin(themeRoot, baseDirectory, pathname);

  if (!filePath) {
    return null;
  }

  const relativePath = path.relative(themeRoot, filePath).split(path.sep).join('/');
  const routePath = encodeRoutePath(relativePath);

  return `${THEME_ASSET_PREFIX}/${themeId}/${routePath}${suffix}`;
}

function rewriteAssetUrls(value, options) {
  let output = '';
  let cursor = 0;

  while (cursor < value.length) {
    const startIndex = findUrlFunction(value, cursor);

    if (startIndex === -1) {
      output += value.slice(cursor);
      break;
    }

    output += value.slice(cursor, startIndex);
    const parsedUrl = parseUrlFunction(value, startIndex);

    if (!parsedUrl) {
      output += value.slice(startIndex);
      break;
    }

    const assetRoute = createThemeAssetRoute(parsedUrl.url, options);

    output += assetRoute
      ? `url("${assetRoute}")`
      : value.slice(startIndex, parsedUrl.endIndex);
    cursor = parsedUrl.endIndex;
  }

  return output;
}

async function renderCssFile(filePath, { themeId, themeRoot, seen }) {
  const source = await readFile(filePath, 'utf8');
  const root = postcss.parse(source, { from: filePath });
  const baseDirectory = path.dirname(filePath);

  root.walkDecls((declaration) => {
    const rewrittenValue = rewriteAssetUrls(declaration.value, {
      themeId,
      themeRoot,
      baseDirectory,
    });

    if (rewrittenValue !== declaration.value) {
      declaration.value = rewrittenValue;
    }
  });

  const importRules = [];
  root.walkAtRules('import', (atRule) => importRules.push(atRule));

  for (const atRule of importRules) {
    const requestPath = parseImportRequest(atRule.params);

    if (!requestPath || isExternalRequest(requestPath)) {
      continue;
    }

    const importedFilePath = resolveExistingFileWithin(themeRoot, baseDirectory, requestPath);

    if (!importedFilePath) {
      continue;
    }

    if (seen.has(importedFilePath)) {
      atRule.remove();
      continue;
    }

    const nextSeen = new Set(seen);
    nextSeen.add(importedFilePath);
    const importedCss = await renderCssFile(importedFilePath, {
      themeId,
      themeRoot,
      seen: nextSeen,
    });
    const importedRoot = postcss.parse(importedCss, { from: importedFilePath });
    atRule.replaceWith(importedRoot.nodes);
  }

  return root.toString();
}

export class ThemeRegistry {
  constructor({ userThemeDir, builtinThemeDir, bundledThemeDir } = {}) {
    if (userThemeDir !== undefined && typeof userThemeDir !== 'string') {
      throw new TypeError('userThemeDir 必须是目录路径字符串');
    }
    if (builtinThemeDir !== undefined && typeof builtinThemeDir !== 'string') {
      throw new TypeError('builtinThemeDir 必须是目录路径字符串');
    }
    if (bundledThemeDir !== undefined && typeof bundledThemeDir !== 'string') {
      throw new TypeError('bundledThemeDir 必须是目录路径字符串');
    }

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    this.userThemeDir = userThemeDir ? path.resolve(userThemeDir) : null;
    this.builtinThemeDir = builtinThemeDir ? path.resolve(builtinThemeDir) : null;
    this.bundledThemeDir = bundledThemeDir
      ? path.resolve(bundledThemeDir)
      : path.resolve(__dirname, '../../resources/themes');
  }

  list() {
    const themes = new Map();

    // 1. 项目自带捆绑基础主题
    if (this.bundledThemeDir && existsSync(this.bundledThemeDir)) {
      for (const theme of this.#themeEntries(this.bundledThemeDir)) {
        themes.set(theme.id, { ...theme, source: 'builtin' });
      }
    }

    // 2. 外部 Typora 内置主题（若存在）
    if (this.builtinThemeDir && this.builtinThemeDir !== this.bundledThemeDir && existsSync(this.builtinThemeDir)) {
      for (const theme of this.#themeEntries(this.builtinThemeDir)) {
        themes.set(theme.id, { ...theme, source: 'builtin' });
      }
    }

    // 3. 用户主题（最高优先级，覆盖同名内置/捆绑主题）
    if (this.userThemeDir && existsSync(this.userThemeDir)) {
      for (const theme of this.#themeEntries(this.userThemeDir)) {
        themes.set(theme.id, { ...theme, source: 'user' });
      }
    }

    const overlays = this.#userOverlayEntries();

    return [...themes.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((theme) => ({
        id: theme.id,
        name: path.basename(theme.cssPath, '.css'),
        source: theme.source,
        cssPath: theme.cssPath,
        hasUserCss: overlays.has(theme.id),
      }));
  }

  async getCss(themeId) {
    const theme = this.#resolveTheme(themeId);

    if (!theme) {
      throw new Error(`未知主题：${themeId}`);
    }

    const overlays = this.#userOverlayEntries();
    const layers = [{ cssPath: theme.cssPath, themeRoot: theme.themeDir }];
    const baseUserCss = overlays.get('base');
    const themeUserCss = overlays.get(theme.id);

    if (baseUserCss) {
      layers.push({ cssPath: baseUserCss, themeRoot: this.userThemeDir });
    }

    if (themeUserCss && themeUserCss !== theme.cssPath) {
      layers.push({ cssPath: themeUserCss, themeRoot: this.userThemeDir });
    }

    const cssChunks = [];

    for (const layer of layers) {
      cssChunks.push(
        await renderCssFile(layer.cssPath, {
          themeId: theme.id,
          themeRoot: layer.themeRoot,
          seen: new Set([layer.cssPath]),
        }),
      );
    }

    const result = await postcss([includeWhenExportPlugin]).process(cssChunks.join('\n'), {
      from: theme.cssPath,
      map: false,
    });

    return result.css;
  }

  resolveAsset(themeId, relativePath) {
    const theme = this.#resolveTheme(themeId);

    if (!theme || typeof relativePath !== 'string' || relativePath.includes('\0')) {
      return null;
    }

    const { pathname } = splitRequestSuffix(relativePath);
    const candidatePath = path.resolve(theme.themeDir, pathname);

    if (!isPathInside(theme.themeDir, candidatePath)) {
      return null;
    }

    const fileStat = statSync(candidatePath, { throwIfNoEntry: false });

    if (!fileStat?.isFile()) {
      return null;
    }

    const realThemeDirectory = realpathSync(theme.themeDir);
    const realCandidatePath = realpathSync(candidatePath);

    if (!isPathInside(realThemeDirectory, realCandidatePath)) {
      return null;
    }

    return candidatePath;
  }

  getThemeDir(themeId) {
    return this.#resolveTheme(themeId)?.themeDir ?? null;
  }

  #themeEntries(directory) {
    if (!directory || !existsSync(directory)) {
      return [];
    }

    return cssFilesInDirectory(directory)
      .filter((fileName) => !fileName.toLowerCase().endsWith('.user.css'))
      .map((fileName) => ({
        id: normalizeThemeId(fileName.slice(0, -'.css'.length)),
        cssPath: path.join(directory, fileName),
      }))
      .filter((theme) => theme.id !== '');
  }

  #userOverlayEntries() {
    const overlays = new Map();
    if (!this.userThemeDir || !existsSync(this.userThemeDir)) {
      return overlays;
    }

    for (const fileName of cssFilesInDirectory(this.userThemeDir)) {
      if (!fileName.toLowerCase().endsWith('.user.css')) {
        continue;
      }

      const themeId = normalizeThemeId(fileName.slice(0, -'.user.css'.length));

      if (themeId !== '') {
        overlays.set(themeId, path.join(this.userThemeDir, fileName));
      }
    }

    return overlays;
  }

  #resolveTheme(themeId) {
    const themeIdCandidatesList = themeIdCandidates(themeId);

    if (themeIdCandidatesList.length === 0) {
      return null;
    }

    const candidateDirs = [];
    if (this.userThemeDir && existsSync(this.userThemeDir)) {
      candidateDirs.push([this.userThemeDir, 'user']);
    }
    if (this.builtinThemeDir && this.builtinThemeDir !== this.bundledThemeDir && existsSync(this.builtinThemeDir)) {
      candidateDirs.push([this.builtinThemeDir, 'builtin']);
    }
    if (this.bundledThemeDir && existsSync(this.bundledThemeDir)) {
      candidateDirs.push([this.bundledThemeDir, 'builtin']);
    }

    for (const [directory, source] of candidateDirs) {
      const themeEntry = this.#themeEntries(directory).find(
        (entry) => themeIdCandidatesList.includes(entry.id),
      );

      if (themeEntry) {
        return {
          id: themeEntry.id,
          source,
          cssPath: themeEntry.cssPath,
          themeDir: directory,
        };
      }
    }

    return null;
  }
}
