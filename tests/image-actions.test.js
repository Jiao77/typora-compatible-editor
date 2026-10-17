import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import {
  findImageNodes,
  computeNewAttrsString,
  updateImageSize,
  updateImageUrl,
  extractImageBasename
} from "../src/web/image-actions.js";

test("定位与重复相同图片精准关联", () => {
  const doc = "前文 ![同名图片](same.png) 中间文本 ![同名图片](same.png){width=\"50%\"} 结尾";
  const imgs = findImageNodes(doc);
  assert.equal(imgs.length, 2);

  // 第一张图
  assert.equal(imgs[0].url, "same.png");
  assert.equal(imgs[0].alt, "同名图片");
  assert.equal(imgs[0].attrSpan, null);

  // 第二张图带属性
  assert.equal(imgs[1].url, "same.png");
  assert.equal(imgs[1].alt, "同名图片");
  assert.notEqual(imgs[1].attrSpan, null);
  assert.deepEqual(imgs[1].attrSpan.attrs, [["width", "50%"]]);
});

test("修改重复图片中指定的一张尺寸，其余图片保持不变", () => {
  const doc = "段落 ![cat](cat.png) 和 ![cat](cat.png){width=\"50%\"} 结束";
  const imgs = findImageNodes(doc);

  let state = EditorState.create({ doc });
  const viewMock = {
    state,
    dispatch(tr) {
      state = state.update(tr).state;
    }
  };

  // 缩放第一张为 25%
  updateImageSize(viewMock, imgs[0], "25%");
  assert.equal(
    state.doc.toString(),
    "段落 ![cat](cat.png){width=\"25%\"} 和 ![cat](cat.png){width=\"50%\"} 结束"
  );
});

test("恢复默认尺寸完全移除 width 属性并保留其他属性", () => {
  const doc = "![img](test.png){width=\"75%\" .featured}";
  const imgs = findImageNodes(doc);

  let state = EditorState.create({ doc });
  const viewMock = {
    state,
    dispatch(tr) {
      state = state.update(tr).state;
    }
  };

  updateImageSize(viewMock, imgs[0], null);
  assert.equal(state.doc.toString(), "![img](test.png){.featured}");
});

test("恢复默认尺寸完全移除纯 width 属性块", () => {
  const doc = "![img](test.png){width=\"100%\"}";
  const imgs = findImageNodes(doc);

  let state = EditorState.create({ doc });
  const viewMock = {
    state,
    dispatch(tr) {
      state = state.update(tr).state;
    }
  };

  updateImageSize(viewMock, imgs[0], null);
  assert.equal(state.doc.toString(), "![img](test.png)");
});

test("上传图床成功替换 URL 并严格保留原尺寸与标题", () => {
  const doc = "![图](local.png \"图标题\"){width=\"50%\"}";
  const imgs = findImageNodes(doc);

  let state = EditorState.create({ doc });
  const viewMock = {
    state,
    dispatch(tr) {
      state = state.update(tr).state;
    }
  };

  updateImageUrl(viewMock, imgs[0], "https://r2.example.com/hosted.png");
  assert.equal(
    state.doc.toString(),
    "![图](https://r2.example.com/hosted.png \"图标题\"){width=\"50%\"}"
  );
});

test("属性保留：多class、id、title正确保留，并移除height属性", () => {
  const doc = "![图](test.png){class=\"foo bar\" #main-img title=\"hello world\" height=\"200px\" width=\"100%\"}";
  const imgs = findImageNodes(doc);
  assert.equal(imgs.length, 1);

  let state = EditorState.create({ doc });
  const viewMock = {
    state,
    dispatch(tr) {
      state = state.update(tr).state;
    }
  };

  updateImageSize(viewMock, imgs[0], "50%");
  assert.equal(
    state.doc.toString(),
    "![图](test.png){width=\"50%\" class=\"foo bar\" #main-img title=\"hello world\"}"
  );
});

test("括号内带引号的quoted }正确解析，不发生提前截断", () => {
  const doc = "![cat](cat.png){title=\"a } b\" width=\"75%\"}";
  const imgs = findImageNodes(doc);
  assert.equal(imgs.length, 1);
  assert.deepEqual(imgs[0].attrSpan.attrs, [
    ["title", "a } b"],
    ["width", "75%"]
  ]);

  let state = EditorState.create({ doc });
  const viewMock = {
    state,
    dispatch(tr) {
      state = state.update(tr).state;
    }
  };

  updateImageSize(viewMock, imgs[0], "50%");
  assert.equal(
    state.doc.toString(),
    "![cat](cat.png){width=\"50%\" title=\"a } b\"}"
  );
});

test("属性值含转义引号或反斜线时安全拒绝缩放并保持文档不变", () => {
  const doc = "![图](test.png){title=\"say \\\"hi\\\"\" width=\"100%\"}";
  const imgs = findImageNodes(doc);
  assert.equal(imgs.length, 1);

  let state = EditorState.create({ doc });
  const viewMock = {
    state,
    dispatch(tr) {
      state = state.update(tr).state;
    }
  };

  assert.throws(
    () => updateImageSize(viewMock, imgs[0], "50%"),
    /无法安全重写/
  );
  assert.equal(state.doc.toString(), doc);
});

test("新行属性不被吞入图片，原段落属性保持不变", () => {
  const doc = "![img](test.png)\n{.featured}";
  const imgs = findImageNodes(doc);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].attrSpan, null);

  let state = EditorState.create({ doc });
  const viewMock = {
    state,
    dispatch(tr) {
      state = state.update(tr).state;
    }
  };

  updateImageSize(viewMock, imgs[0], "50%");
  assert.equal(
    state.doc.toString(),
    "![img](test.png){width=\"50%\"}\n{.featured}"
  );
});

test("尖括号URL替换后严格保留尖括号包裹", () => {
  const doc = "![img](<path with space/image.png>)";
  const imgs = findImageNodes(doc);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].url, "<path with space/image.png>");

  let state = EditorState.create({ doc });
  const viewMock = {
    state,
    dispatch(tr) {
      state = state.update(tr).state;
    }
  };

  updateImageUrl(viewMock, imgs[0], "https://r2.example.com/hosted.png");
  assert.equal(
    state.doc.toString(),
    "![img](<https://r2.example.com/hosted.png>)"
  );
});

test("不支持引用式图片更新URL时直接抛出明确错误", () => {
  const doc = "![img][ref_image]";
  const imgs = findImageNodes(doc);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].url, null);
  assert.equal(imgs[0].urlFrom, null);

  let state = EditorState.create({ doc });
  const viewMock = {
    state,
    dispatch(tr) {
      state = state.update(tr).state;
    }
  };

  assert.throws(
    () => updateImageUrl(viewMock, imgs[0], "https://r2.example.com/hosted.png"),
    /无法更新图片地址/
  );
});

test("extractImageBasename 从不同来源正确提取文件名，异常编码抛出错误", () => {
  // 1. dataset.originalSrc 含查询参数 path
  const name1 = extractImageBasename({
    dataset: { originalSrc: "/api/images/read?path=%2FUsers%2Ftest%2Fphoto.png" }
  });
  assert.equal(name1, "photo.png");

  // 2. 普通远程 URL 含 query 和 hash
  const name2 = extractImageBasename({
    src: "https://example.com/assets/banner.png?v=2#hash"
  });
  assert.equal(name2, "banner.png");

  // 3. 本地回退 src
  const name3 = extractImageBasename({ src: "http://localhost/image.png" });
  assert.equal(name3, "image.png");

  // 4. 非法 URI 编码 Fast-fail 抛出异常
  assert.throws(
    () => extractImageBasename({ src: "http://localhost/?path=%E0%A4%A" }),
    URIError
  );

  // 5. 空源地址抛出异常
  assert.throws(
    () => extractImageBasename({}),
    /无法提取图片名称/
  );
});
