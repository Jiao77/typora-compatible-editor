import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import valueParser from "postcss-value-parser";

import { ThemeRegistry } from "../src/server/theme.js";
import { DEFAULT_BUNDLED_THEME_DIR } from "../src/server/config.js";
import { startServer } from "../src/server/index.js";
import { renderMarkdown } from "../src/server/render.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const refThemesDir = path.join(rootDir, "reference", "remote-20261016", "user-themes");

const EXPECTED_THEMES = [
  "github",
  "gothic",
  "latex",
  "latex-dark",
  "newsprint",
  "night",
  "pixyll",
  "whitey"
];

const EXPECTED_HASHES = {
  "github.css": { size: 8272, sha256: "0225b3c456252023b46d71b05c7ae592ac247207d5e4aabd99a1f07ef70d02a0" },
  "gothic.css": { size: 7719, sha256: "bfdc69b8ea083ca1e52c5be9cac658953d96617bbca1e9f92f630f3f96b4a758" },
  "latex.css": { size: 19019, sha256: "b6160309aa7a6fed477c10e840c5ac941ed0173487e2117e36242839927626b7" },
  "latex-dark.css": { size: 25670, sha256: "d5b156e422f510f6a1995f5ab99f055255ce386db3d0f34c412ed88b1255bc4a" },
  "newsprint.css": { size: 10586, sha256: "74f8e327abb48ac331dc1096c1e244d20ff9f5b05beb1204e9867b919cdecade" },
  "night.css": { size: 16973, sha256: "8a88f1e138d30240234cdfd50fe7e7efc393dda4de4ff4284e6fa2aedb6b5f25" },
  "pixyll.css": { size: 10568, sha256: "90e27bc256d6ce61802e7f643bdc7bd9956b04013b3b36b00e1a4b191ff4fe8d" },
  "whitey.css": { size: 4651, sha256: "93b2c21baa15b08f6b355d0d2e422b7d1e75562f9f36dcf90d0796234d1202ab" }
};

test("主题迁移套件：所有现行主题文件哈希与远程归档字节完全一致", async () => {
  for (const [filename, expected] of Object.entries(EXPECTED_HASHES)) {
    const filePath = path.join(DEFAULT_BUNDLED_THEME_DIR, filename);
    const content = await readFile(filePath);
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    assert.equal(content.length, expected.size, `${filename} 字节大小不匹配`);
    assert.equal(sha256, expected.sha256, `${filename} SHA-256 哈希不匹配`);
  }
});

test("主题迁移套件：ThemeRegistry 能够自动发现全部 8 个捆绑主题并解析", () => {
  const registry = new ThemeRegistry({
    bundledThemeDir: DEFAULT_BUNDLED_THEME_DIR
  });

  const list = registry.list();
  const ids = list.map((item) => item.id);

  for (const expectedId of EXPECTED_THEMES) {
    assert.ok(ids.includes(expectedId), `缺少主题：${expectedId}`);
  }

  const latex = list.find((item) => item.id === "latex");
  assert.equal(latex.source, "builtin");
  assert.ok(latex.cssPath.endsWith("latex.css"));

  const latexDark = list.find((item) => item.id === "latex-dark");
  assert.equal(latexDark.source, "builtin");
  assert.ok(latexDark.cssPath.endsWith("latex-dark.css"));
});

test("主题迁移套件：latex 与 latex-dark 的 CSS 内容包含完整学术排版定义", async () => {
  const registry = new ThemeRegistry({
    bundledThemeDir: DEFAULT_BUNDLED_THEME_DIR
  });

  const latexCss = await registry.getCss("latex");
  assert.ok(latexCss.includes("--base-latin-font"));
  assert.ok(latexCss.includes("max-width: 21cm"));
  assert.ok(latexCss.includes("box-shadow: 0 0 24px 12px #cccccc"));

  const darkCss = await registry.getCss("latex-dark");
  assert.ok(darkCss.includes("--base-latin-font"));
  assert.ok(darkCss.includes("max-width: 21cm"));
  assert.ok(darkCss.includes("box-shadow: 0 0 24px 12px #101010"));
  assert.ok(darkCss.includes("background-color: #1e1e1e"));
});

test("主题迁移套件：全部 8 个主题的所有相对静态资源均通过 HTTP 接口可达", async () => {
  const serverInfo = await startServer({ port: 0 });
  try {
    for (const themeId of EXPECTED_THEMES) {
      const res = await fetch(`${serverInfo.url}/api/themes/${themeId}/css`);
      assert.equal(res.status, 200, `主题 ${themeId} CSS 加载失败`);
      const css = await res.text();
      const root = postcss.parse(css);

      const urls = [];
      root.walkDecls((decl) => {
        if (decl.value && decl.value.includes("url(")) {
          const parsed = valueParser(decl.value);
          parsed.walk((node) => {
            if (node.type === "function" && node.value.toLowerCase() === "url") {
              const item = node.nodes.find((n) => n.type === "string" || n.type === "word");
              if (item) urls.push(item.value);
            }
          });
        }
      });

      for (const u of urls) {
        if (u.startsWith("/theme-assets/")) {
          const assetRes = await fetch(`${serverInfo.url}${u}`);
          assert.equal(
            assetRes.status,
            200,
            `主题 ${themeId} 资源 ${u} 请求失败，状态码：${assetRes.status}`
          );
        }
      }
    }
  } finally {
    serverInfo.server.close();
  }
});

test("主题迁移套件：night 主题内嵌子模块并展开 @import", async () => {
  const registry = new ThemeRegistry({
    bundledThemeDir: DEFAULT_BUNDLED_THEME_DIR
  });

  const css = await registry.getCss("night");
  assert.ok(!css.includes("@import"));
  assert.ok(css.includes("--mermaid-theme: night"));
  assert.ok(css.includes(".cm-s-inner"));
});

test("主题迁移套件：Markdown 渲染管线配合 latex 主题产出符合结构的内容", () => {
  const sample = "# 学术标题\\n\\n正文测试公式：$E=mc^2$";
  const result = renderMarkdown(sample);
  assert.ok(result.body.includes("md-heading"));
  assert.ok(result.body.includes("md-inline-math"));
});
