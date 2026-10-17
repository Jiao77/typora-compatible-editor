import path from "node:path";
import { fileURLToPath } from "node:url";
import { stat } from "node:fs/promises";
import express from "express";
import { getRuntimeDataDir } from "./runtime-data.js";

export const ALLOWED_MEDIA_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".ico",
  ".tiff",
  ".tif",
  ".avif",
  ".heic",
  ".heif"
]);

const MIME_MAP = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif"
};

export function isAllowedMediaExtension(filePath) {
  if (typeof filePath !== "string") return false;
  const ext = path.extname(filePath).toLowerCase();
  return ALLOWED_MEDIA_EXTENSIONS.has(ext);
}

export function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

export function parseLocalFilePath(rawInput) {
  if (typeof rawInput !== "string" || rawInput.trim() === "") {
    const error = new Error("缺少有效的图片路径");
    error.status = 400;
    throw error;
  }
  const trimmed = rawInput.trim();
  if (trimmed.startsWith("file://")) {
    try {
      return fileURLToPath(trimmed);
    } catch (cause) {
      const error = new Error(`无效的 file URL：${trimmed}`);
      error.status = 400;
      error.cause = cause;
      throw error;
    }
  }

  // HTTP query 参数已由 Express 规范解码，直接返回 trimmed，避免对字面量含百分号文件名二次解码
  return trimmed;
}

export async function resolveDocumentAsset(rawPath, { documentPath = null, documentDir = null, rootDir = process.cwd() } = {}) {
  const parsed = parseLocalFilePath(rawPath);

  let docBaseDir = null;
  if (documentDir && typeof documentDir === "string" && documentDir.trim() !== "") {
    docBaseDir = path.resolve(documentDir.trim());
  } else if (documentPath && typeof documentPath === "string" && documentPath.trim() !== "") {
    docBaseDir = path.dirname(path.resolve(documentPath.trim()));
  }

  let resolved = null;
  if (path.isAbsolute(parsed)) {
    resolved = path.normalize(parsed);
  } else if (docBaseDir) {
    resolved = path.resolve(docBaseDir, parsed);
  } else {
    const runtimeUploads = path.join(getRuntimeDataDir(rootDir), "uploads");
    resolved = path.resolve(runtimeUploads, parsed);
  }

  if (!isAllowedMediaExtension(resolved)) {
    const error = new Error(`禁止访问非媒体资源：${path.basename(resolved)}`);
    error.status = 403;
    throw error;
  }

  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) {
      const error = new Error(`路径不是文件：${resolved}`);
      error.status = 404;
      throw error;
    }
    return {
      absolutePath: resolved,
      mimeType: getMimeType(resolved),
      size: fileStat.size
    };
  } catch (err) {
    if (err.status) throw err;
    if (err.code === "ENOENT") {
      const notFound = new Error(`图片文件不存在：${resolved}`);
      notFound.status = 404;
      throw notFound;
    }
    throw err;
  }
}

export async function resolveLocalImageRoute(relativePath, { documentPath = null, documentDir = null, rootDir = process.cwd(), targetDir = "uploads" } = {}) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    const error = new Error("缺少图片子路径");
    error.status = 400;
    throw error;
  }

  let docBaseDir = null;
  if (documentDir && typeof documentDir === "string" && documentDir.trim() !== "") {
    docBaseDir = path.resolve(documentDir.trim());
  } else if (documentPath && typeof documentPath === "string" && documentPath.trim() !== "") {
    docBaseDir = path.dirname(path.resolve(documentPath.trim()));
  }

  const baseDir = docBaseDir
    ? (path.isAbsolute(targetDir) ? path.normalize(targetDir) : path.resolve(docBaseDir, targetDir))
    : path.join(getRuntimeDataDir(rootDir), "uploads");

  const resolved = path.resolve(baseDir, relativePath);

  if (!isAllowedMediaExtension(resolved)) {
    const error = new Error(`禁止访问非媒体资源：${path.basename(resolved)}`);
    error.status = 403;
    throw error;
  }

  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) {
      const error = new Error(`路径不是文件：${resolved}`);
      error.status = 404;
      throw error;
    }
    return {
      absolutePath: resolved,
      mimeType: getMimeType(resolved),
      size: fileStat.size
    };
  } catch (err) {
    if (err.status) throw err;
    if (err.code === "ENOENT") {
      const notFound = new Error(`图片文件不存在：${relativePath}`);
      notFound.status = 404;
      throw notFound;
    }
    throw err;
  }
}

export function createDocumentAssetsRouter({ rootDir = process.cwd() } = {}) {
  const router = express.Router();

  router.get("/api/document-image", async (req, res, next) => {
    try {
      const rawPath = String(req.query.path || "");
      const documentPath = req.query.documentPath ? String(req.query.documentPath) : null;
      const documentDir = req.query.documentDir ? String(req.query.documentDir) : null;

      const asset = await resolveDocumentAsset(rawPath, { documentPath, documentDir, rootDir });
      res.type(asset.mimeType).sendFile(asset.absolutePath);
    } catch (error) {
      if (error.status) {
        res.status(error.status).json({ error: error.message });
      } else {
        next(error);
      }
    }
  });

  router.get("/local-images/*assetPath", async (req, res, next) => {
    try {
      const segments = req.params.assetPath;
      const relative = Array.isArray(segments) ? segments.join("/") : String(segments || "");
      const documentPath = req.query.documentPath ? String(req.query.documentPath) : null;
      const documentDir = req.query.documentDir ? String(req.query.documentDir) : null;

      const asset = await resolveLocalImageRoute(relative, {
        documentPath,
        documentDir,
        rootDir
      });
      res.type(asset.mimeType).sendFile(asset.absolutePath);
    } catch (error) {
      if (error.status) {
        res.status(error.status).json({ error: error.message });
      } else {
        next(error);
      }
    }
  });

  return router;
}
