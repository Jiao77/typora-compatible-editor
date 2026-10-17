import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_PICGO_ENDPOINT = 'http://127.0.0.1:36677/upload';

export const UPLOADERS = Object.freeze([
  Object.freeze({
    id: 'ipic',
    name: 'iPic',
    transport: 'command',
    command: 'ipic',
    args: [],
    default: true,
  }),
  Object.freeze({
    id: 'picgo-app',
    name: 'PicGo (App)',
    transport: 'picgo',
    endpoint: DEFAULT_PICGO_ENDPOINT,
  }),
  Object.freeze({
    id: 'piclist-app',
    name: 'PicList (App)',
    transport: 'picgo',
    endpoint: DEFAULT_PICGO_ENDPOINT,
  }),
  Object.freeze({
    id: 'upic',
    name: 'uPic',
    transport: 'command',
    command: '/Applications/uPic.app/Contents/MacOS/uPic',
    args: ['-o', 'url', '-u'],
  }),
  Object.freeze({
    id: 'picsee',
    name: 'Picsee',
    transport: 'command',
    command: '/Applications/Picsee.app/Contents/MacOS/Picsee',
    args: ['-u'],
  }),
  Object.freeze({
    id: 'picgo-cli',
    name: 'PicGo (CLI)',
    transport: 'command',
    command: 'picgo',
    args: ['u'],
  }),
  Object.freeze({
    id: 'custom',
    name: 'Custom (自定义/Cloudflare R2)',
    transport: 'custom',
  }),
]);

const UPLOADER_BY_ID = new Map(UPLOADERS.map((item) => [item.id, item]));
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

function errorReason(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function withUploaderContext(uploader, error) {
  const reason = errorReason(error);
  return new Error(`[${uploader}] ${reason}`, {
    cause: error instanceof Error ? error : undefined,
  });
}

function normalizeFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new TypeError('files 必须是非空数组');
  }
  return files.map((file) => {
    if (!file || typeof file !== 'object') {
      throw new TypeError('files 中的每一项必须是文件描述对象');
    }
    if (typeof file.path !== 'string' || file.path.trim() === '') {
      throw new TypeError('文件描述对象必须包含非空 path');
    }
    return file;
  });
}

function resolveFilePath(file, documentDir) {
  const inputPath = file.path;
  return path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.resolve(documentDir, inputPath);
}

function resolveFilename(file, filepath) {
  if (typeof file.filename === 'string' && file.filename.trim() !== '') {
    return path.basename(file.filename);
  }
  return path.basename(filepath);
}

function getValueAtPath(value, fieldPath) {
  if (typeof fieldPath !== 'string' || fieldPath.trim() === '') {
    return undefined;
  }
  return fieldPath.split('.').filter(Boolean).reduce((current, key) => {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    return current[key];
  }, value);
}

function parseJson(text) {
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch (error) {
    return { parsed: false, error };
  }
}

function resolveHeaders(configuredHeaders, body, isMultipart = false) {
  const headers = { ...(configuredHeaders || {}) };
  if (isMultipart) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-type') {
        delete headers[key];
      }
    }
    return headers;
  }
  if (body !== undefined) {
    const hasContentType = Object.keys(headers).some(
      (key) => key.toLowerCase() === 'content-type',
    );
    if (!hasContentType) {
      headers['Content-Type'] = 'application/json';
    }
  }
  return headers;
}

function renderTemplateValue(value, variables) {
  if (typeof value === 'string') {
    return renderCustomTemplate(value, variables);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderTemplateValue(item, variables));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        renderTemplateValue(item, variables),
      ]),
    );
  }
  return value;
}

function looksLikeJson(text) {
  const first = text.trim()[0];
  return first === '{' || first === '[' || first === '"';
}

function isUrlText(value) {
  return /^(?:https?|ftp|file):\/\/\S+$/i.test(value);
}

function extractCommandUrl(stdout, stderr) {
  const combined = `${stdout || ''}\n${stderr || ''}`;
  const parsed = parseJson(combined.trim());
  if (parsed.parsed) {
    if (typeof parsed.value === 'string' && isUrlText(parsed.value.trim())) {
      return parsed.value.trim();
    }
    const candidate = getValueAtPath(parsed.value, 'url')
      ?? getValueAtPath(parsed.value, 'data.url');
    if (typeof candidate === 'string' && isUrlText(candidate.trim())) {
      return candidate.trim();
    }
  }

  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isUrlText(lines[index])) {
      return lines[index];
    }
  }
  return null;
}

export function renderCustomTemplate(template, { filepath, filename } = {}) {
  const filepathValue = filepath === undefined || filepath === null ? '' : String(filepath);
  const filenameValue = filename === undefined || filename === null ? '' : String(filename);
  return String(template)
    .replaceAll('${filepath}', filepathValue)
    .replaceAll('${filename}', filenameValue);
}

export async function checkPicGoService(endpoint = DEFAULT_PICGO_ENDPOINT) {
  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
    });
    return response.status < 500;
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class ImageHost {
  constructor({ uploader, settings = {}, documentDir = process.cwd() } = {}) {
    const selectedUploader = uploader
      || settings.image_uploader
      || settings.uploader
      || 'ipic';
    if (typeof selectedUploader !== 'string' || selectedUploader.trim() === '') {
      throw new TypeError('uploader 必须是非空字符串');
    }
    if (typeof documentDir !== 'string' || documentDir.trim() === '') {
      throw new TypeError('documentDir 必须是非空字符串');
    }
    this.uploader = selectedUploader;
    this.settings = settings || {};
    this.documentDir = path.resolve(documentDir);
  }

  getSettings(uploader = this.uploader) {
    const nestedSources = [
      this.settings.uploaderSettings,
      this.settings.uploaders,
      this.settings.uploaderConfig,
    ];
    const nested = nestedSources.find(
      (source) => source && typeof source === 'object' && !Array.isArray(source),
    );
    const definition = UPLOADER_BY_ID.get(uploader);
    return {
      ...(definition || {}),
      ...this.settings,
      ...(nested?.[uploader] || {}),
      ...(this.settings[uploader] || {}),
    };
  }

  async upload(files) {
    const normalizedFiles = normalizeFiles(files);
    try {
      if (this.uploader === 'picgo-app' || this.uploader === 'piclist-app') {
        return await this.uploadPicGo(normalizedFiles);
      }
      return await Promise.all(
        normalizedFiles.map((file) => this.uploadOneInternal(file)),
      );
    } catch (error) {
      throw withUploaderContext(this.uploader, error);
    }
  }

  async uploadOne(file) {
    const [normalizedFile] = normalizeFiles([file]);
    try {
      return await this.uploadOneInternal(normalizedFile);
    } catch (error) {
      throw withUploaderContext(this.uploader, error);
    }
  }

  async uploadOneInternal(file) {
    if (this.uploader === 'picgo-app' || this.uploader === 'piclist-app') {
      const results = await this.uploadPicGo([file]);
      return results[0];
    }
    if (this.uploader === 'custom') {
      return this.uploadCustom(file);
    }
    if (this.uploader === 'local') {
      return this.uploadLocal(file);
    }
    if (UPLOADER_BY_ID.has(this.uploader)) {
      return this.uploadCommand(file);
    }
    throw new Error(`未知上传器: ${this.uploader}`);
  }

  async uploadPicGo(files) {
    const settings = this.getSettings();
    const endpoint = settings.endpoint || DEFAULT_PICGO_ENDPOINT;
    const filepaths = files.map((file) => resolveFilePath(file, this.documentDir));
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list: filepaths }),
      signal: AbortSignal.timeout(settings.timeout ?? DEFAULT_TIMEOUT_MS),
    });
    const responseText = await response.text();

    if (response.status !== 200) {
      const detail = responseText.trim() ? `: ${responseText.trim()}` : '';
      throw new Error(`HTTP ${response.status}${detail}`);
    }

    const payloadResult = parseJson(responseText);
    if (!payloadResult.parsed) {
      throw new Error(`响应不是有效 JSON: ${errorReason(payloadResult.error)}`);
    }
    const payload = payloadResult.value;
    if (!payload || payload.success !== true || !Array.isArray(payload.result)) {
      throw new Error(`响应缺少 success=true 或 result 数组: ${responseText.trim()}`);
    }
    if (payload.result.length !== files.length) {
      throw new Error(
        `返回 URL 数量 ${payload.result.length} 与文件数量 ${files.length} 不一致`,
      );
    }

    return files.map((file, index) => {
      const url = payload.result[index];
      if (typeof url !== 'string' || url.trim() === '') {
        throw new Error(`result[${index}] 不是有效 URL 字符串`);
      }
      const filepath = filepaths[index];
      return {
        url: url.trim(),
        filename: resolveFilename(file, filepath),
        uploader: this.uploader,
      };
    });
  }

  async uploadCustom(file) {
    const settings = this.getSettings('custom');
    const endpoint = settings.url;
    if (typeof endpoint !== 'string' || endpoint.trim() === '') {
      throw new Error('custom 上传器缺少 settings.url');
    }

    const filepath = resolveFilePath(file, this.documentDir);
    const filename = resolveFilename(file, filepath);
    const variables = { filepath, filename };
    const method = String(settings.method || 'POST').toUpperCase();

    const rawHeaders = { ...(settings.headers || {}) };
    const token = typeof settings.token === 'string' && settings.token.trim() !== ''
      ? settings.token.trim()
      : (typeof settings.custom_token === 'string' && settings.custom_token.trim() !== '' ? settings.custom_token.trim() : '');
    if (token && !Object.keys(rawHeaders).some((key) => key.toLowerCase() === 'authorization')) {
      rawHeaders.Authorization = `Bearer ${token}`;
    }

    const isExplicitJson = settings.bodyType !== 'multipart';
    let body;
    let headers;

    if (!isExplicitJson && method !== 'GET' && method !== 'HEAD') {
      const fileBuffer = await readFile(filepath);
      const mimeType = file.mime || 'application/octet-stream';
      const fileBlob = new Blob([fileBuffer], { type: mimeType });
      const formData = new FormData();
      const fileFieldName = (typeof settings.fileField === 'string' && settings.fileField.trim() !== '')
        ? settings.fileField.trim()
        : 'file';
      formData.append(fileFieldName, fileBlob, filename);

      if (settings.body && typeof settings.body === 'object' && !Array.isArray(settings.body)) {
        for (const [key, val] of Object.entries(settings.body)) {
          const renderedVal = renderTemplateValue(val, variables);
          formData.append(key, typeof renderedVal === 'string' ? renderedVal : JSON.stringify(renderedVal));
        }
      }

      body = formData;
      headers = resolveHeaders(rawHeaders, body, true);
    } else {
      const configuredBody = settings.body === undefined
        ? { filepath: '${filepath}', filename: '${filename}' }
        : settings.body;
      const renderedBody = renderTemplateValue(configuredBody, variables);
      body = method === 'GET' || method === 'HEAD'
        ? undefined
        : typeof renderedBody === 'string'
          ? renderedBody
          : JSON.stringify(renderedBody);
      headers = resolveHeaders(rawHeaders, body, false);
    }

    const response = await fetch(endpoint, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(settings.timeout ?? DEFAULT_TIMEOUT_MS),
    });
    const responseText = await response.text();
    if (!response.ok) {
      const detail = responseText.trim() ? `: ${responseText.trim()}` : '';
      throw new Error(`HTTP ${response.status}${detail}`);
    }
    if (responseText.trim() === '') {
      throw new Error('响应内容为空，无法解析 URL');
    }

    let url;
    const parsed = parseJson(responseText);
    const contentType = response.headers.get('content-type') || '';
    if (parsed.parsed) {
      if (typeof parsed.value === 'string') {
        url = parsed.value;
      } else {
        const urlPath = settings.urlPath || 'url';
        url = getValueAtPath(parsed.value, urlPath);
      }
    } else if (contentType.toLowerCase().includes('json') || looksLikeJson(responseText)) {
      throw new Error(`响应不是有效 JSON: ${errorReason(parsed.error)}`);
    } else {
      url = responseText.trim();
    }

    if (typeof url !== 'string' || url.trim() === '') {
      throw new Error('响应中未找到有效 URL 字符串');
    }
    return { url: url.trim(), filename, uploader: 'custom' };
  }

  async uploadLocal(file) {
    const settings = this.getSettings('local');
    const targetSetting = (typeof settings.targetDir === 'string' && settings.targetDir.trim() !== '')
      ? settings.targetDir.trim()
      : 'uploads';

    const filepath = resolveFilePath(file, this.documentDir);
    const filename = resolveFilename(file, filepath);
    const targetDir = path.isAbsolute(targetSetting)
      ? path.normalize(targetSetting)
      : path.resolve(this.documentDir, targetSetting);
    await mkdir(targetDir, { recursive: true });

    const copied = await this.copyWithUniqueName(filepath, targetDir, filename);
    return {
      url: `/api/document-image?path=${encodeURIComponent(copied.absolutePath)}`,
      filename: copied.filename,
      uploader: 'local',
      absolutePath: copied.absolutePath,
    };
  }

  async copyWithUniqueName(sourcePath, targetDir, filename) {
    const parsed = path.parse(filename);
    for (let index = 0; ; index += 1) {
      const candidate = index === 0
        ? filename
        : `${parsed.name}-${index}${parsed.ext}`;
      const absolutePath = path.join(targetDir, candidate);
      try {
        await copyFile(sourcePath, absolutePath, constants.COPYFILE_EXCL);
        return { filename: candidate, absolutePath };
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          continue;
        }
        throw error;
      }
    }
  }

  async uploadCommand(file) {
    const definition = UPLOADER_BY_ID.get(this.uploader);
    const settings = this.getSettings();
    const command = settings.command || definition.command;
    const configuredArgs = Array.isArray(settings.args) ? settings.args : [];
    const filepath = resolveFilePath(file, this.documentDir);
    const args = [
      ...(definition.args || []),
      ...configuredArgs,
      filepath,
    ];

    const { stdout, stderr } = await execFileAsync(command, args, {
      maxBuffer: settings.maxBuffer ?? 2 * 1024 * 1024,
      timeout: settings.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    const url = extractCommandUrl(stdout, stderr);
    if (!url) {
      const detail = stderr && stderr.trim() ? `: ${stderr.trim()}` : '';
      throw new Error(`命令未返回 URL${detail}`);
    }
    return {
      url,
      filename: resolveFilename(file, filepath),
      uploader: this.uploader,
    };
  }
}
