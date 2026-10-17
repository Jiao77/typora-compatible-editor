// 文档本地图片路径解析与改写模块

export function encodeMarkdownPath(p) {
  if (!p || typeof p !== "string") return "";
  const trimmed = p.trim();
  if (/^(?:https?|data|blob):/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("file://")) {
    return new URL(trimmed).href;
  }
  if (trimmed.startsWith("/api/") || trimmed.startsWith("/local-images/")) return trimmed;
  const parts = trimmed.split("/").map((seg, idx) => (idx === 0 && seg === "" ? "" : encodeURIComponent(seg)));
  return parts.join("/");
}

export function formatMarkdownImage(altText, rawPath) {
  const safeAlt = String(altText || "").replace(/[\[\]]/g, "");
  const encodedPath = encodeMarkdownPath(rawPath);
  return `![${safeAlt}](${encodedPath})`;
}

const PRESERVED_PREFIXES = [
  "data:",
  "blob:",
  "http://",
  "https://",
  "/theme-assets/",
  "/branding/",
  "/vendor/",
  "/dist/",
  "/favicon.ico",
  "/api/document-image"
];

function shouldPreserveSrc(src) {
  if (!src || typeof src !== "string") return true;
  const trimmed = src.trim();
  if (trimmed === "") return true;
  for (const prefix of PRESERVED_PREFIXES) {
    if (trimmed.startsWith(prefix)) return true;
  }
  return false;
}

export function toAssetUrl(rawSrc, documentPath = null) {
  if (!rawSrc || typeof rawSrc !== "string") return "";
  const trimmed = rawSrc.trim();
  if (shouldPreserveSrc(trimmed)) {
    return trimmed;
  }

  // 对已有的 /local-images 路径追加 documentPath 确保确定性定位
  if (trimmed.startsWith("/local-images/")) {
    if (documentPath && !trimmed.includes("documentPath=")) {
      const sep = trimmed.includes("?") ? "&" : "?";
      return `${trimmed}${sep}documentPath=${encodeURIComponent(documentPath)}`;
    }
    return trimmed;
  }

  // 非 file 协议的从 markdown-it 渲染出的相对或绝对路径，执行一次 decodeURIComponent 还原为文件系统真实路径
  let decodedPath = trimmed;
  if (!trimmed.startsWith("file://")) {
    try {
      decodedPath = decodeURIComponent(trimmed);
    } catch (cause) {
      const error = new URIError(`无法解析图片 URI 编码：${trimmed}`);
      error.cause = cause;
      throw error;
    }
  }

  const params = new URLSearchParams();
  params.set("path", decodedPath);
  const isAbs = decodedPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(decodedPath) || decodedPath.startsWith("file://");
  if (!isAbs && documentPath) {
    params.set("documentPath", documentPath);
  }
  return `/api/document-image?${params.toString()}`;
}

export function resolveDocumentImages(root, documentPath = null) {
  if (!root) return;
  const images = [];
  if (root.tagName && root.tagName.toLowerCase() === "img") {
    images.push(root);
  }
  if (root.querySelectorAll) {
    images.push(...root.querySelectorAll("img"));
  }

  for (const img of images) {
    const original = img.dataset.originalSrc || img.getAttribute("src") || "";
    if (!original) continue;
    if (!img.dataset.originalSrc) {
      img.dataset.originalSrc = original;
    }
    const resolved = toAssetUrl(original, documentPath);
    if (resolved && img.getAttribute("src") !== resolved) {
      img.setAttribute("src", resolved);
    }
  }
}
