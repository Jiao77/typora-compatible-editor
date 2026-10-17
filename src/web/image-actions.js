import { markdownLanguage } from "@codemirror/lang-markdown";
import MarkdownIt from "markdown-it";
import attrsUtils from "markdown-it-attrs/utils.js";

const mdParser = new MarkdownIt();
const attrsOptions = { leftDelimiter: "{", rightDelimiter: "}" };
const hasEndDelim = attrsUtils.hasDelimiters("end", attrsOptions);

export function findImageNodes(docText, blockFrom = 0, blockTo = docText.length) {
  const tree = markdownLanguage.parser.parse(docText);
  const images = [];

  tree.iterate({
    enter(node) {
      if (node.name === "Image" && node.from >= blockFrom && node.to <= blockTo) {
        let url = null;
        let urlFrom = null;
        let urlTo = null;
        let title = "";

        let cursor = node.node.cursor();
        if (cursor.firstChild()) {
          do {
            if (cursor.name === "URL") {
              urlFrom = cursor.from;
              urlTo = cursor.to;
              url = docText.slice(urlFrom, urlTo);
            } else if (cursor.name === "LinkTitle") {
              title = docText.slice(cursor.from, cursor.to);
            }
          } while (cursor.nextSibling());
        }

        let alt = "";
        const rawImage = docText.slice(node.from, node.to);
        const tokens = mdParser.parseInline(rawImage, {});
        const imgToken = tokens[0]?.children?.find((t) => t.type === "image");
        if (imgToken) {
          alt = imgToken.content || "";
        }

        let attrSpan = null;
        let fullTo = node.to;
        const rest = docText.slice(node.to);
        const lineEndIndex = rest.indexOf("\n");
        const sameLineRest = lineEndIndex === -1 ? rest : rest.slice(0, lineEndIndex);
        const leadingMatch = /^[ \t]*\{/.exec(sameLineRest);
        if (leadingMatch) {
          const startInRest = sameLineRest.indexOf("{");
          for (let i = startInRest + 1; i < sameLineRest.length; i++) {
            if (sameLineRest.charAt(i) === "}") {
              const candidate = sameLineRest.slice(startInRest, i + 1);
              if (hasEndDelim(candidate)) {
                const parsedAttrs = attrsUtils.getAttrs(candidate, 0, attrsOptions) || [];
                fullTo = node.to + i + 1;
                attrSpan = {
                  from: node.to + startInRest,
                  rawFrom: node.to,
                  to: fullTo,
                  attrs: parsedAttrs
                };
                break;
              }
            }
          }
        }

        images.push({
          from: node.from,
          to: node.to,
          fullTo,
          url,
          urlFrom,
          urlTo,
          title,
          alt,
          attrSpan
        });
      }
    }
  });

  return images;
}

export function computeNewAttrsString(existingAttrs, newWidthPercent) {
  const attrs = existingAttrs
    ? existingAttrs.filter(([k]) => k !== "width" && k !== "height")
    : [];

  for (const [k, v] of attrs) {
    if (typeof v === "string" && (v.includes(`"`) || v.includes(`\\`))) {
      throw new Error("属性值包含转义引号或反斜线，无法安全重写");
    }
  }

  if (newWidthPercent) {
    attrs.unshift(["width", newWidthPercent]);
  }

  if (attrs.length === 0) return "";

  const parts = attrs.map(([k, v]) => {
    if (k === "class") {
      if (typeof v === "string" && /\s/.test(v)) {
        return `class="${v}"`;
      }
      return "." + v;
    }
    if (k === "id") {
      if (typeof v === "string" && /\s/.test(v)) {
        return `id="${v}"`;
      }
      return "#" + v;
    }
    return `${k}="${v}"`;
  });

  return `{${parts.join(" ")}}`;
}

export function updateImageSize(view, targetImage, newWidthPercent) {
  const existingAttrs = targetImage.attrSpan ? targetImage.attrSpan.attrs : null;
  const newAttrStr = computeNewAttrsString(existingAttrs, newWidthPercent);

  let change = null;
  if (targetImage.attrSpan) {
    const from = (newAttrStr === "" && targetImage.attrSpan.rawFrom !== undefined)
      ? targetImage.attrSpan.rawFrom
      : targetImage.attrSpan.from;
    change = { from, to: targetImage.attrSpan.to, insert: newAttrStr };
  } else if (newAttrStr) {
    change = { from: targetImage.to, to: targetImage.to, insert: newAttrStr };
  }

  if (change) {
    view.dispatch({ changes: change });
  }
}

export function updateImageUrl(view, targetImage, newUrl) {
  if (!targetImage || targetImage.urlFrom === null || targetImage.urlTo === null || targetImage.url === null) {
    throw new Error("无法更新图片地址：目标节点不是具有行内 URL 的图片");
  }

  let finalUrl = newUrl;
  if (typeof targetImage.url === "string" && targetImage.url.startsWith("<") && targetImage.url.endsWith(">")) {
    if (!finalUrl.startsWith("<") || !finalUrl.endsWith(">")) {
      finalUrl = `<${finalUrl}>`;
    }
  }

  view.dispatch({
    changes: { from: targetImage.urlFrom, to: targetImage.urlTo, insert: finalUrl }
  });
}

export function extractImageBasename(imgElement, fallbackSrc = "") {
  let candidate = (imgElement && imgElement.dataset && imgElement.dataset.originalSrc) || "";
  if (!candidate) {
    candidate = fallbackSrc || (imgElement && imgElement.src) || "";
  }
  if (!candidate) {
    throw new Error("无法提取图片名称：图片源地址为空");
  }

  const parsed = new URL(candidate, "http://localhost");
  const pathParam = parsed.searchParams.get("path");
  let targetPath = pathParam ? pathParam : parsed.pathname;

  targetPath = decodeURIComponent(targetPath);

  const segments = targetPath.split(/[\\/]/).filter(Boolean);
  const basename = segments.pop() || "image.png";
  return basename;
}

let activeMenu = null;

export function closeImageContextMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
}

export function openImageContextMenu({
  event,
  imgElement,
  editor,
  getEditor,
  isCurrentEditor,
  settings = {},
  onStatus = () => {},
  onOpenSettings = () => {}
}) {
  event.preventDefault();
  event.stopPropagation();
  closeImageContextMenu();

  const wrap = imgElement.closest(".md-block");
  const currentEditor = typeof getEditor === "function" ? getEditor() : editor;
  if (!wrap || !currentEditor || !currentEditor.view) return;

  const lineStart = Number(wrap.dataset.lineStart);
  const lineEnd = Number(wrap.dataset.lineEnd);
  const doc = currentEditor.view.state.doc;
  const docLines = doc.lines;
  if (lineStart < 1 || lineStart > docLines) return;

  const blockFrom = doc.line(lineStart).from;
  const blockTo = doc.line(Math.min(lineEnd, docLines)).to;
  const allImgs = Array.from(wrap.querySelectorAll("img"));
  const imgIndex = allImgs.indexOf(imgElement);
  if (imgIndex < 0) return;

  const docText = doc.toString();
  const blockImages = findImageNodes(docText, blockFrom, blockTo);
  const targetImage = blockImages[imgIndex];
  if (!targetImage) return;

  const menu = document.createElement("div");
  menu.className = "image-context-menu";
  menu.setAttribute("role", "menu");
  menu.tabIndex = -1;

  const scales = [
    { label: "缩放 25%", value: "25%" },
    { label: "缩放 50%", value: "50%" },
    { label: "缩放 75%", value: "75%" },
    { label: "缩放 100%", value: "100%" },
    { label: "恢复默认大小", value: null }
  ];

  for (const item of scales) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "image-menu-item";
    btn.setAttribute("role", "menuitem");
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      closeImageContextMenu();
      try {
        updateImageSize(currentEditor.view, targetImage, item.value);
        onStatus(item.value ? `图片尺寸已调整为 ${item.value}` : "图片已恢复默认尺寸", "ok");
      } catch (err) {
        onStatus(`调整图片尺寸失败：${err.message}`, "error");
      }
    });
    menu.appendChild(btn);
  }

  const divider1 = document.createElement("div");
  divider1.className = "image-menu-divider";
  menu.appendChild(divider1);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "image-menu-item";
  copyBtn.setAttribute("role", "menuitem");
  copyBtn.textContent = "复制图片链接";
  copyBtn.addEventListener("click", async () => {
    closeImageContextMenu();
    const link = targetImage.url || imgElement.src || "";
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(link);
        onStatus("图片链接已复制到剪贴板", "ok");
      } else {
        throw new Error("剪贴板接口不可用");
      }
    } catch (err) {
      onStatus(`复制图片链接失败：${err.message}`, "error");
    }
  });
  menu.appendChild(copyBtn);

  const uploadBtn = document.createElement("button");
  uploadBtn.type = "button";
  uploadBtn.className = "image-menu-item";
  uploadBtn.setAttribute("role", "menuitem");
  uploadBtn.textContent = "上传到图床";
  uploadBtn.addEventListener("click", async () => {
    closeImageContextMenu();
    if (targetImage.urlFrom === null || targetImage.url === null || !targetImage.url) {
      onStatus("不支持引用式图片上传，仅支持普通行内图片", "error");
      return;
    }

    const uploader = settings.image_uploader;
    if (!uploader) {
      onStatus("未配置图床，请前往偏好设置设置", "warn");
      onOpenSettings();
      return;
    }

    const initialEditor = typeof getEditor === "function" ? getEditor() : editor;
    if (!initialEditor || !initialEditor.view) return;
    const initialDoc = initialEditor.view.state.doc.toString();
    const initialPath = initialEditor.documentPath || "";
    const initialView = initialEditor.view;

    try {
      onStatus("正在上传图片到图床 …", "info");
      const imageSrc = imgElement.src;
      const res = await fetch(imageSrc);
      if (!res.ok) throw new Error(`读取图片失败：状态码 ${res.status}`);
      const blob = await res.blob();
      const filename = extractImageBasename(imgElement, imageSrc);

      const formData = new FormData();
      formData.append("files", blob, filename);
      formData.append("uploader", uploader);
      formData.append("documentDir", initialPath);

      const uploadRes = await fetch("/api/images/upload", {
        method: "POST",
        body: formData
      });
      const data = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(data.error || "图床上传接口返回错误");
      if (!data.results || data.results.length === 0 || !data.results[0].url) {
        throw new Error("未获取到有效的远程图片地址");
      }

      const remoteUrl = data.results[0].url;

      const activeEditor = typeof getEditor === "function" ? getEditor() : editor;
      const isSameInstance = typeof isCurrentEditor === "function" ? isCurrentEditor(initialEditor) : (activeEditor === initialEditor);
      const currentDoc = activeEditor && activeEditor.view ? activeEditor.view.state.doc.toString() : null;
      const currentPath = (activeEditor && activeEditor.documentPath) || "";

      if (!isSameInstance || !activeEditor || activeEditor.view !== initialView || currentDoc !== initialDoc || currentPath !== initialPath) {
        onStatus(`文档已更改或切换，已取消自动替换，远程图片地址：${remoteUrl}`, "warn");
        return;
      }

      updateImageUrl(activeEditor.view, targetImage, remoteUrl);
      onStatus("图片已成功上传至图床", "ok");
    } catch (err) {
      onStatus(`上传图床失败：${err.message}`, "error");
    }
  });
  menu.appendChild(uploadBtn);

  document.body.appendChild(menu);
  activeMenu = menu;

  const menuWidth = menu.offsetWidth || 160;
  const menuHeight = menu.offsetHeight || 220;
  let posX = event.clientX;
  let posY = event.clientY;

  if (posX + menuWidth > window.innerWidth - 8) {
    posX = window.innerWidth - menuWidth - 8;
  }
  if (posY + menuHeight > window.innerHeight - 8) {
    posY = window.innerHeight - menuHeight - 8;
  }
  menu.style.left = `${Math.max(8, posX)}px`;
  menu.style.top = `${Math.max(8, posY)}px`;

  const items = Array.from(menu.querySelectorAll(".image-menu-item"));
  let focusedIndex = 0;
  if (items[0]) items[0].focus();

  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeImageContextMenu();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusedIndex = (focusedIndex + 1) % items.length;
      items[focusedIndex].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusedIndex = (focusedIndex - 1 + items.length) % items.length;
      items[focusedIndex].focus();
    }
  });
}

export function bindImageContextMenu({ container, editor, getEditor, isCurrentEditor, getSettings, onStatus, onOpenSettings }) {
  container.addEventListener("contextmenu", (event) => {
    const img = event.target.closest("img");
    if (img && container.contains(img)) {
      const currentEditor = typeof getEditor === "function" ? getEditor() : editor;
      openImageContextMenu({
        event,
        imgElement: img,
        editor: currentEditor,
        getEditor,
        isCurrentEditor,
        settings: typeof getSettings === "function" ? getSettings() : (getSettings || {}),
        onStatus,
        onOpenSettings
      });
    }
  });

  document.addEventListener("click", (event) => {
    if (activeMenu && !activeMenu.contains(event.target)) {
      closeImageContextMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activeMenu) {
      closeImageContextMenu();
    }
  });
}
