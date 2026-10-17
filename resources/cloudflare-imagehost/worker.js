const ALLOWED_MIME_TYPES = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/avif", ".avif"],
]);

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_BODY_SIZE = MAX_FILE_SIZE + 64 * 1024;

async function readBoundedBody(request, limit) {
  const contentLengthHeader = request.headers.get("Content-Length");
  if (contentLengthHeader !== null) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > limit) {
      return { ok: false, status: 413, error: "请求体体积超出限制（最大 20MiB + 64KiB）" };
    }
  }
  if (!request.body) return { ok: true, request };
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > limit) {
      await reader.cancel();
      return { ok: false, status: 413, error: "请求体体积超出限制（最大 20MiB + 64KiB）" };
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    ok: true,
    request: new Request(request.url, { method: request.method, headers: request.headers, body: merged }),
  };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

const SECURITY_HEADERS = {
  ...CORS_HEADERS,
  "X-Content-Type-Options": "nosniff",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  const maxLen = Math.max(bufA.byteLength, bufB.byteLength);
  let diff = bufA.byteLength ^ bufB.byteLength;
  for (let i = 0; i < maxLen; i += 1) {
    const byteA = i < bufA.byteLength ? bufA[i] : 0;
    const byteB = i < bufB.byteLength ? bufB[i] : 0;
    diff |= byteA ^ byteB;
  }
  return diff === 0;
}

function renderHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TYPOAR 图床服务</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --accent-hover: #0284c7;
      --border: #334155;
      --success: #4ade80;
      --error: #f87171;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 24px;
    }
    .container {
      width: 100%;
      max-width: 520px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 32px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 8px;
      letter-spacing: -0.025em;
    }
    p.desc {
      color: var(--text-muted);
      font-size: 14px;
      margin-bottom: 24px;
      line-height: 1.5;
    }
    .field {
      margin-bottom: 20px;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    input[type="password"],
    input[type="file"] {
      width: 100%;
      padding: 10px 12px;
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-size: 14px;
      outline: none;
      transition: border-color 0.15s;
    }
    input[type="password"]:focus {
      border-color: var(--accent);
    }
    .drop-zone {
      border: 2px dashed var(--border);
      border-radius: 8px;
      padding: 24px;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.2s, background-color 0.2s;
      background: rgba(15, 23, 42, 0.6);
    }
    .drop-zone.dragover {
      border-color: var(--accent);
      background: rgba(56, 189, 248, 0.08);
    }
    .drop-zone:focus {
      border-color: var(--accent);
      outline: none;
    }
    .drop-zone-text {
      color: var(--text-muted);
      font-size: 13px;
    }
    .drop-zone-preview {
      max-height: 140px;
      max-width: 100%;
      margin-top: 12px;
      border-radius: 4px;
      display: none;
    }
    button.submit-btn {
      width: 100%;
      padding: 12px;
      background: var(--accent);
      color: #0f172a;
      font-weight: 600;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
      transition: background-color 0.15s, opacity 0.15s;
    }
    button.submit-btn:hover:not(:disabled) {
      background: var(--accent-hover);
    }
    button.submit-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .result-box {
      margin-top: 24px;
      padding: 16px;
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 8px;
      display: none;
    }
    .result-status {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 8px;
    }
    .result-status.success { color: var(--success); }
    .result-status.error { color: var(--error); }
    .url-row {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    .url-display {
      flex: 1;
      font-family: monospace;
      font-size: 12px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px 10px;
      color: var(--accent);
      word-break: break-all;
      user-select: all;
    }
    .copy-btn {
      padding: 8px 14px;
      background: var(--border);
      color: var(--text);
      font-size: 12px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
    }
    .copy-btn:hover {
      background: #475569;
    }
    .preview-container {
      margin-top: 12px;
      text-align: center;
    }
    .preview-container img {
      max-width: 100%;
      max-height: 220px;
      border-radius: 6px;
      border: 1px solid var(--border);
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>TYPOAR 图床服务</h1>
    <p class="desc">基于 Cloudflare Workers 与 R2 的专属图像托管服务，支持 png、jpeg、gif、webp、avif 格式，单图限制 20MiB。</p>
    <form id="uploadForm">
      <div class="field">
        <label for="tokenInput">上传授权令牌 (Token)</label>
        <input type="password" id="tokenInput" placeholder="请输入 Bearer 令牌" autocomplete="off" required>
      </div>
      <div class="field">
        <label>选择图片文件</label>
        <input type="file" id="fileInput" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" style="display: none;">
        <div class="drop-zone" id="dropZone" tabindex="0" role="button" aria-label="上传图片拖拽区域">
          <div class="drop-zone-text" id="dropZonePrompt">点击或拖拽图片文件到此区域</div>
          <img id="localPreview" class="drop-zone-preview" alt="本地预览">
        </div>
      </div>
      <button type="submit" class="submit-btn" id="submitBtn">立即上传</button>
    </form>
    <div class="result-box" id="resultBox">
      <div class="result-status" id="resultStatus"></div>
      <div class="url-row" id="urlRow" style="display: none;">
        <div class="url-display" id="urlDisplay"></div>
        <button type="button" class="copy-btn" id="copyBtn">复制链接</button>
      </div>
      <div class="preview-container" id="previewContainer" style="display: none;">
        <img id="remotePreview" alt="上传结果图">
      </div>
    </div>
  </div>
  <script>
    (function() {
      var dropZone = document.getElementById("dropZone");
      var fileInput = document.getElementById("fileInput");
      var dropZonePrompt = document.getElementById("dropZonePrompt");
      var localPreview = document.getElementById("localPreview");
      var form = document.getElementById("uploadForm");
      var tokenInput = document.getElementById("tokenInput");
      var submitBtn = document.getElementById("submitBtn");
      var resultBox = document.getElementById("resultBox");
      var resultStatus = document.getElementById("resultStatus");
      var urlRow = document.getElementById("urlRow");
      var urlDisplay = document.getElementById("urlDisplay");
      var copyBtn = document.getElementById("copyBtn");
      var previewContainer = document.getElementById("previewContainer");
      var remotePreview = document.getElementById("remotePreview");
      dropZone.addEventListener("click", function(e) {
        if (e.target !== fileInput) fileInput.click();
      });
      dropZone.addEventListener("keydown", function(e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          fileInput.click();
        }
      });
      fileInput.addEventListener("change", function() {
        if (fileInput.files && fileInput.files[0]) {
          handleFileSelected(fileInput.files[0]);
        }
      });
      dropZone.addEventListener("dragover", function(e) {
        e.preventDefault();
        dropZone.classList.add("dragover");
      });
      dropZone.addEventListener("dragleave", function() {
        dropZone.classList.remove("dragover");
      });
      dropZone.addEventListener("drop", function(e) {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
          fileInput.files = e.dataTransfer.files;
          handleFileSelected(e.dataTransfer.files[0]);
        }
      });
      function handleFileSelected(file) {
        dropZonePrompt.textContent = file.name + " (" + (file.size / 1024).toFixed(1) + " KB)";
        if (file.type.startsWith("image/")) {
          var reader = new FileReader();
          reader.onload = function(evt) {
            localPreview.src = evt.target.result;
            localPreview.style.display = "inline-block";
          };
          reader.readAsDataURL(file);
        } else {
          localPreview.style.display = "none";
        }
      }
      form.addEventListener("submit", async function(e) {
        e.preventDefault();
        var token = tokenInput.value.trim();
        var file = fileInput.files && fileInput.files[0];
        if (!token) {
          showResult(false, "请填写上传授权令牌");
          return;
        }
        if (!file) {
          showResult(false, "请先选择需要上传的图片文件");
          return;
        }
        submitBtn.disabled = true;
        submitBtn.textContent = "上传中...";
        showResult(null, "正在上传至 R2 存储...");
        try {
          var formData = new FormData();
          formData.append("file", file);
          var response = await fetch("/upload", {
            method: "POST",
            headers: {
              "Authorization": "Bearer " + token
            },
            body: formData
          });
          var data = await response.json();
          if (!response.ok) {
            showResult(false, "上传失败: " + (data.error || ("HTTP " + response.status)));
          } else {
            showResult(true, "上传成功！", data.url);
          }
        } catch (err) {
          showResult(false, "网络请求异常: " + err.message);
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = "立即上传";
        }
      });
      function showResult(success, message, url) {
        resultBox.style.display = "block";
        resultStatus.textContent = message;
        resultStatus.className = "result-status " + (success === true ? "success" : (success === false ? "error" : ""));
        if (success && url) {
          urlRow.style.display = "flex";
          urlDisplay.textContent = url;
          previewContainer.style.display = "block";
          remotePreview.src = url;
        } else {
          urlRow.style.display = "none";
          previewContainer.style.display = "none";
        }
      }
      copyBtn.addEventListener("click", function() {
        var text = urlDisplay.textContent;
        if (!text) return;
        navigator.clipboard.writeText(text).then(function() {
          copyBtn.textContent = "已复制";
          setTimeout(function() { copyBtn.textContent = "复制链接"; }, 2000);
        }).catch(function() {
          copyBtn.textContent = "复制失败";
        });
      });
    })();
  </script>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }
    if (url.pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonResponse({ error: "Method Not Allowed" }, 405);
      }
      const hasToken = typeof env.UPLOAD_TOKEN === "string" && env.UPLOAD_TOKEN.trim().length > 0;
      const hasImages = Boolean(env.IMAGES && typeof env.IMAGES.put === "function");
      if (!hasToken || !hasImages) {
        return jsonResponse({ status: "degraded", service: "typoar-imagehost", ready: false }, 503);
      }
      return jsonResponse({ status: "ok", service: "typoar-imagehost", ready: true });
    }
    if (url.pathname === "/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonResponse({ error: "Method Not Allowed" }, 405);
      }
      return new Response(renderHtml(), {
        status: 200,
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data: https://file.jiao77.com; connect-src 'self' https://img.jiao77.com https://typoar-imagehost.jiaotiansheng.workers.dev;",
        },
      });
    }
    if (url.pathname === "/upload") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method Not Allowed" }, 405);
      }
      const expectedToken = env.UPLOAD_TOKEN;
      if (typeof expectedToken !== "string" || expectedToken.trim().length === 0) {
        return jsonResponse({ error: "服务端未配置有效的上传令牌" }, 500);
      }
      const authHeader = request.headers.get("Authorization") || "";
      const [scheme, token] = authHeader.split(" ");
      if (scheme !== "Bearer" || !token || !safeCompare(token, expectedToken.trim())) {
        return jsonResponse({ error: "未授权：无效或缺失的 Authorization Bearer 令牌" }, 401);
      }
      const contentType = request.headers.get("Content-Type") || "";
      if (!contentType.toLowerCase().includes("multipart/form-data")) {
        return jsonResponse({ error: "请求格式错误，必须为 multipart/form-data" }, 400);
      }
      const bounded = await readBoundedBody(request, MAX_BODY_SIZE);
      if (!bounded.ok) return jsonResponse({ error: bounded.error }, bounded.status);
      let formData;
      try {
        formData = await bounded.request.formData();
      } catch (err) {
        return jsonResponse({ error: "解析 multipart 表单数据失败" }, 400);
      }
      const file = formData.get("file");
      if (!file || typeof file === "string") {
        return jsonResponse({ error: "缺少名为 file 的上传文件" }, 400);
      }
      if (file.size === 0) {
        return jsonResponse({ error: "上传文件内容为空" }, 400);
      }
      if (file.size > MAX_FILE_SIZE) {
        return jsonResponse({ error: "文件体积超出限制（最大 20MiB）" }, 413);
      }
      const mimeType = (file.type || "").toLowerCase();
      const ext = ALLOWED_MIME_TYPES.get(mimeType);
      if (!ext) {
        return jsonResponse({ error: "不支持的文件类型，仅允许 png/jpeg/gif/webp/avif 图片" }, 415);
      }
      if (!env.IMAGES || typeof env.IMAGES.put !== "function") {
        return jsonResponse({ error: "服务端未绑定 R2 存储桶 (IMAGES)" }, 500);
      }
      const arrayBuffer = await file.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
      const sha256 = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const now = new Date();
      const year = String(now.getUTCFullYear());
      const month = String(now.getUTCMonth() + 1).padStart(2, "0");
      const uuid = crypto.randomUUID();
      const key = `typoar/${year}/${month}/${uuid}${ext}`;
      let putResult;
      try {
        putResult = await env.IMAGES.put(key, arrayBuffer, {
          httpMetadata: {
            contentType: mimeType,
            cacheControl: "public, max-age=31536000, immutable",
          },
          customMetadata: {
            sha256,
            originalFilename: file.name ? encodeURIComponent(Array.from(file.name).slice(0, 100).join("")) : "",
            uploadedAt: now.toISOString(),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "R2 存储写入异常";
        return jsonResponse({ error: `写入存储对象失败: ${message}` }, 500);
      }
      if (putResult === null || typeof putResult !== "object") {
        return jsonResponse({ error: "写入存储对象失败：R2 存储返回空结果" }, 500);
      }
      const baseUrl = (env.PUBLIC_BASE_URL || "https://file.jiao77.com").replace(/\/+$/, "");
      const publicUrl = `${baseUrl}/${key}`;
      return jsonResponse({
        url: publicUrl,
        filename: file.name || `${uuid}${ext}`,
        size: arrayBuffer.byteLength,
        key,
      }, 200);
    }
    return jsonResponse({ error: "Not Found" }, 404);
  },
};
