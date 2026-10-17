import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import { toAssetUrl, formatMarkdownImage, encodeMarkdownPath } from "../src/web/document-images.js";
import { markdownIt } from "../src/server/render.js";
import { startServer, ROOT_DIR } from "../src/server/index.js";

const TEST_WORK_ROOT = path.join(ROOT_DIR, "work", "editor_image_fix_20261016", "images");
process.env.TYPORA_DATA_DIR = path.join(TEST_WORK_ROOT, "runtime-test");

const FIXTURE_PNG = path.join(ROOT_DIR, "resources", "branding", "typo-ar.png");

async function createTestDirectory() {
  const dir = path.join(TEST_WORK_ROOT, `tests-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function extractFirstImageSrc(markdown) {
  const tokens = markdownIt.parse(markdown, {});
  function findImage(items) {
    for (const item of items) {
      if (item.type === "image") {
        return item.attrGet("src");
      }
      if (item.children) {
        const found = findImage(item.children);
        if (found) return found;
      }
    }
    return null;
  }
  return findImage(tokens);
}

test("toAssetUrl 纯函数解析：保留免处理协议，将本地路径转换为标准化查询参数，对非法编码抛错", () => {
  assert.equal(toAssetUrl("https://example.com/pic.png"), "https://example.com/pic.png");
  assert.equal(toAssetUrl("http://example.com/pic.png"), "http://example.com/pic.png");
  assert.equal(toAssetUrl("data:image/png;base64,abc"), "data:image/png;base64,abc");
  assert.equal(toAssetUrl("blob:http://localhost/abc"), "blob:http://localhost/abc");
  assert.equal(toAssetUrl("/theme-assets/github/logo.png"), "/theme-assets/github/logo.png");
  assert.equal(toAssetUrl("/branding/typo-ar.png"), "/branding/typo-ar.png");
  assert.equal(toAssetUrl("/vendor/mathjax/es5/tex-chtml.js"), "/vendor/mathjax/es5/tex-chtml.js");
  assert.equal(toAssetUrl("/api/document-image?path=%2Fa.png"), "/api/document-image?path=%2Fa.png");

  // 绝对路径（无需携带 documentPath）
  const absPath = "/Volumes/QNAS-1TB/Downloads/屋顶与云端的静谧时光.png";
  const absUrl = toAssetUrl(absPath, "/Users/jiao77/docs/report.md");
  assert.ok(absUrl.startsWith("/api/document-image?"));
  const absParams = new URLSearchParams(absUrl.replace("/api/document-image?", ""));
  assert.equal(absParams.get("path"), absPath);
  assert.equal(absParams.get("documentPath"), null);

  // file 协议
  const fileUrl = "file:///Users/jiao77/Pictures/wallpaper/屋顶与云端的静谧时光.png";
  const fileResult = toAssetUrl(fileUrl);
  assert.ok(fileResult.startsWith("/api/document-image?"));
  const fileParams = new URLSearchParams(fileResult.replace("/api/document-image?", ""));
  assert.equal(fileParams.get("path"), fileUrl);

  // 相对路径（带文档路径）
  const relPath = "./images/架构 图 (1).png";
  const docPath = "/Users/jiao77/docs/report.md";
  const relUrl = toAssetUrl(relPath, docPath);
  const relParams = new URLSearchParams(relUrl.replace("/api/document-image?", ""));
  assert.equal(relParams.get("path"), "./images/架构 图 (1).png");
  assert.equal(relParams.get("documentPath"), docPath);

  // 非法百分号编码明确抛错
  assert.throws(() => toAssetUrl("/bad%XX"), (err) => err instanceof URIError && /无法解析图片 URI 编码/.test(err.message));
});

test("formatMarkdownImage 格式化：保护既有服务 URL 与 file 协议，不产生二次多重编码", () => {
  // 服务 URL 保留原样
  const serviceUrl = "/api/document-image?path=%2FVolumes%2Ftest.png";
  assert.equal(formatMarkdownImage("测试", serviceUrl), `![测试](${serviceUrl})`);
  assert.equal(encodeMarkdownPath(serviceUrl), serviceUrl);

  // local-images 路由保留原样
  const localImgUrl = "/local-images/uploads/demo.png";
  assert.equal(formatMarkdownImage("本地", localImgUrl), `![本地](${localImgUrl})`);

  // file 协议保留原样
  const fileProtocol = "file:///Volumes/test.png";
  assert.equal(formatMarkdownImage("协议", fileProtocol), `![协议](${fileProtocol})`);

  // 真实本地含百分号文件名格式化为百分号保护编码
  assert.equal(formatMarkdownImage("比例", "/data/100%20.png"), "![比例](/data/100%2520.png)");

  // 非法 file 协议构造失败必须遵循 Fast-fail 直接抛出错误
  assert.throws(() => encodeMarkdownPath("file://[invalid]"), TypeError);
});

test("端到端渲染链路：Markdown 经 markdownIt 解析出 token 经 toAssetUrl 解码再通过 HTTP 获取准确图片字节", async (t) => {
  const directory = await createTestDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const expectedBytes = await readFile(FIXTURE_PNG);
  const { server, url } = await startServer({ port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // 1. 中文绝对路径（未转义 Markdown 与转义 Markdown）
  const chineseFile = path.join(directory, "屋顶与云端的静谧时光.png");
  await copyFile(FIXTURE_PNG, chineseFile);

  const rawChineseMd = `![测试](${chineseFile})`;
  const rawChineseSrc = extractFirstImageSrc(rawChineseMd);
  assert.ok(rawChineseSrc, "markdownIt 必须解析出 img token 的 src");
  const rawChineseAssetUrl = toAssetUrl(rawChineseSrc);
  const rawChineseRes = await fetch(`${url}${rawChineseAssetUrl}`);
  assert.equal(rawChineseRes.status, 200);
  assert.deepEqual(Buffer.from(await rawChineseRes.arrayBuffer()), expectedBytes);

  // 2. 空格与括号路径
  const spaceFile = path.join(directory, "测试 截图 (1).png");
  await copyFile(FIXTURE_PNG, spaceFile);
  const spaceMd = formatMarkdownImage("空格图", spaceFile);
  const spaceSrc = extractFirstImageSrc(spaceMd);
  assert.ok(spaceSrc);
  const spaceAssetUrl = toAssetUrl(spaceSrc);
  const spaceRes = await fetch(`${url}${spaceAssetUrl}`);
  assert.equal(spaceRes.status, 200);
  assert.deepEqual(Buffer.from(await spaceRes.arrayBuffer()), expectedBytes);

  // 3. 文件名字面量含百分号
  const percentFile = path.join(directory, "100%20比例.png");
  await copyFile(FIXTURE_PNG, percentFile);
  const percentMd = formatMarkdownImage("百分比", percentFile);
  const percentSrc = extractFirstImageSrc(percentMd);
  assert.ok(percentSrc);
  const percentAssetUrl = toAssetUrl(percentSrc);
  const percentRes = await fetch(`${url}${percentAssetUrl}`);
  assert.equal(percentRes.status, 200);
  assert.deepEqual(Buffer.from(await percentRes.arrayBuffer()), expectedBytes);

  // 4. 相对路径渲染（Markdown 中带空格和中文）
  const docDir = path.join(directory, "子文档");
  const subImgDir = path.join(docDir, "资源 目录");
  await mkdir(subImgDir, { recursive: true });
  const subImgFile = path.join(subImgDir, "结构 示意.png");
  await copyFile(FIXTURE_PNG, subImgFile);
  const docPath = path.join(docDir, "chapter.md");

  const relMd = formatMarkdownImage("相对图", "资源 目录/结构 示意.png");
  const relSrc = extractFirstImageSrc(relMd);
  assert.ok(relSrc);
  const relAssetUrl = toAssetUrl(relSrc, docPath);
  const relRes = await fetch(`${url}${relAssetUrl}`);
  assert.equal(relRes.status, 200);
  assert.deepEqual(Buffer.from(await relRes.arrayBuffer()), expectedBytes);

  // 5. file:// 协议全链路（包含中文与空格）
  const fileProtoFile = path.join(directory, "协议 测试 图 (2).png");
  await copyFile(FIXTURE_PNG, fileProtoFile);
  const fileUrlStr = pathToFileURL(fileProtoFile).href;
  const fileMd = formatMarkdownImage("协议图", fileUrlStr);
  const fileSrc = extractFirstImageSrc(fileMd);
  assert.ok(fileSrc, "markdownIt 必须解析出 file 协议图片 token");
  const fileAssetUrl = toAssetUrl(fileSrc);
  const fileRes = await fetch(`${url}${fileAssetUrl}`);
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await fileRes.arrayBuffer()), expectedBytes);
});

test("未保存文档真实上传全链路：upload -> formatMarkdownImage -> markdownIt token src -> toAssetUrl -> HTTP 200 字节一致", async (t) => {
  const directory = await createTestDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const { server, url } = await startServer({ port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const realBytes = await readFile(FIXTURE_PNG);
  const testFilename = `未保存测试-${randomUUID()}.png`;
  const formData = new FormData();
  formData.append("uploader", "local");
  formData.append("documentDir", "");
  formData.append("files", new Blob([realBytes], { type: "image/png" }), testFilename);

  const uploadRes = await fetch(`${url}/api/images/upload`, {
    method: "POST",
    body: formData
  });
  assert.equal(uploadRes.status, 200);
  const uploadData = await uploadRes.json();
  assert.ok(Array.isArray(uploadData.results) && uploadData.results.length === 1);
  const result = uploadData.results[0];
  assert.equal(result.filename, testFilename);
  assert.ok(result.url.startsWith("/api/document-image?path="));

  // 验证完整接入链：formatMarkdownImage -> markdownIt token -> toAssetUrl -> HTTP
  const md = formatMarkdownImage(result.filename, result.url);
  const tokenSrc = extractFirstImageSrc(md);
  assert.equal(tokenSrc, result.url, "formatMarkdownImage 必须保留返回的有效服务 URL 结构");
  const assetUrl = toAssetUrl(tokenSrc);
  assert.equal(assetUrl, result.url, "toAssetUrl 必须保持 /api/document-image 路由 URL 不被二次编码");

  const imgRes = await fetch(`${url}${assetUrl}`);
  assert.equal(imgRes.status, 200);
  assert.equal(imgRes.headers.get("content-type"), "image/png");
  const receivedBytes = Buffer.from(await imgRes.arrayBuffer());
  assert.deepEqual(receivedBytes, realBytes);
});

test("安全边界：非媒体文件拒绝访问 403，文件不存在 404，非法 file 协议 400", async (t) => {
  const directory = await createTestDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const textFile = path.join(directory, "secret.txt");
  await writeFile(textFile, "forbidden text content");

  const { server, url } = await startServer({ port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // 1. 尝试访问文本文件（非媒体扩展名）-> 403 Forbidden
  const forbiddenRes = await fetch(`${url}/api/document-image?path=${encodeURIComponent(textFile)}`);
  assert.equal(forbiddenRes.status, 403);
  const forbiddenJson = await forbiddenRes.json();
  assert.match(forbiddenJson.error, /禁止访问非媒体资源/);

  // 2. 尝试访问不存在的图片 -> 404 Not Found
  const notFoundRes = await fetch(`${url}/api/document-image?path=${encodeURIComponent(path.join(directory, "missing.png"))}`);
  assert.equal(notFoundRes.status, 404);
  const notFoundJson = await notFoundRes.json();
  assert.match(notFoundJson.error, /图片文件不存在/);

  // 3. 非法 file URL 协议 -> 400 Bad Request
  const badUrlRes = await fetch(`${url}/api/document-image?path=${encodeURIComponent("file://invalid url@@@")}`);
  assert.equal(badUrlRes.status, 400);
});

test("多文档切换与另存为：相对图片基准路径严格隔离", async (t) => {
  const directory = await createTestDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const docDirA = path.join(directory, "docA");
  const docDirB = path.join(directory, "docB");
  await mkdir(path.join(docDirA, "images"), { recursive: true });
  await mkdir(path.join(docDirB, "images"), { recursive: true });

  const realBytesA = await readFile(FIXTURE_PNG);
  const realBytesB = Buffer.from(realBytesA);
  realBytesB[realBytesB.length - 1] = realBytesB[realBytesB.length - 1] ^ 0xff;

  const imgA = path.join(docDirA, "images", "chart.png");
  const imgB = path.join(docDirB, "images", "chart.png");
  await writeFile(imgA, realBytesA);
  await writeFile(imgB, realBytesB);

  const docA = path.join(docDirA, "docA.md");
  const docB = path.join(docDirB, "docB.md");

  const { server, url } = await startServer({ port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // DocA 相对图片
  const resA = await fetch(`${url}/api/document-image?path=images/chart.png&documentPath=${encodeURIComponent(docA)}`);
  assert.equal(resA.status, 200);
  assert.deepEqual(Buffer.from(await resA.arrayBuffer()), realBytesA);

  // DocB 相对图片
  const resB = await fetch(`${url}/api/document-image?path=images/chart.png&documentPath=${encodeURIComponent(docB)}`);
  assert.equal(resB.status, 200);
  assert.deepEqual(Buffer.from(await resB.arrayBuffer()), realBytesB);
});

test("隔离性校验：在不导入 index 与 document-assets 的独立子进程中 parseBlocks 仍正确生成 file 协议 img DOM", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const script = `
    import("./src/server/blocks.js").then(({ parseBlocks }) => {
      const md = "![测试图片](file:///Volumes/QNAS-1TB/Downloads/%E5%B1%8B%E9%A1%B6%E4%B8%8E%E4%BA%91%E7%AB%AF%E7%9A%84%E9%9D%99%E8%B0%A7%E6%97%B6%E5%85%89.png)";
      const res = parseBlocks(md);
      if (!res || !res.blocks || res.blocks.length === 0) {
        console.error("未能解析出块结构");
        process.exit(1);
      }
      const html = res.blocks[0].html;
      if (!html.includes('<img src="file:///')) {
        console.error("块内未包含 file 协议 img 节点:", html);
        process.exit(1);
      }
      console.log("OK");
    });
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT_DIR
  });
  assert.equal(stdout.trim(), "OK");
});
