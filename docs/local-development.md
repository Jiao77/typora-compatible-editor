# 本机开发与部署指南

本文档记录在 macOS 环境下构建、测试、启动与打包 TYPOAR 的完整流程。

## 1. 运行环境要求

本机开发与构建依赖以下工具链：

| 软件或工具 | 规格要求 | 本机实测快照 | 用途说明 |
| :--- | :--- | :--- | :--- |
| 操作系统 | macOS | macOS 27.0.1 (Darwin 27.0.0, arm64) | 宿主系统运行环境 |
| Node.js | >=20 (`package.json` engines) | `/opt/homebrew/bin/node` (v26.11.1) | 后端服务与构建运行环境 |
| npm | 随 Node.js 安装 | `/opt/homebrew/bin/npm` (11.20.0) | 依赖管理与脚本执行 |
| Google Chrome | 已安装本机 | `/Applications/Google Chrome.app` (155.0.8059.80) | PDF 无头渲染与导出 |
| Pandoc | 已安装本机 | `/opt/homebrew/bin/pandoc` (3.12.1) | docx、epub、latex 等文档格式转换 |

## 2. 依赖安装与构建

### 2.1 安装项目依赖

项目依赖由 `package-lock.json` 文件锁定。首次接管或拉取代码后，在项目根目录执行：

```bash
npm ci
```

### 2.2 构建前端与第三方脚本

执行以下命令编译前端与静态图表资源：

```bash
npm run build
```

构建命令按顺序执行以下任务：
1. `node scripts/build-vendor.js`：通过 `esbuild` 将 `flowchart.js` 打包为浏览器 IIFE 格式，并从 `node_modules` 复制 `jquery.js`、`underscore.js`、`raphael.js` 与 `sequence-diagram.js` 到 `public/vendor/diagrams` 目录。
2. `node scripts/build-renderer.js`：通过 `esbuild` 将主编辑器界面入口 `src/web/app.js` 编译至 `dist/app.js`，将偏好设置界面入口 `src/web/settings.js` 编译至 `dist/settings.js`。

## 3. 运行方式

### 3.1 桌面应用模式

以 Electron 桌面客户端启动源码版本：

```bash
# 启动源码版桌面客户端（默认使用本机磁盘用户数据）
npm run desktop

# 启用调试参数启动源码版桌面客户端
npm run desktop:dev
```

已安装至系统的应用程序可通过以下命令启动：

```bash
env -u ELECTRON_RUN_AS_NODE open '/Applications/TYPOAR.app'
```

主进程自动拉起内部 Express 服务（端口随机分配），并创建一体化无边框桌面窗口。

### 3.2 独立 Web 模式

启动后端服务，在外部浏览器中调试页面。推荐通过环境变量指定本机磁盘数据目录：

```bash
TYPORA_DATA_DIR="$HOME/Library/Application Support/typora-compatible-editor/dev" npm start
```

服务默认监听 `http://127.0.0.1:7788`。

### 3.3 数据存储目录与磁盘实测说明

数据存储目录通过环境变量 `TYPORA_DATA_DIR` 控制：
- **桌面模式**：未设置时，默认使用本机磁盘路径 `~/Library/Application Support/typora-compatible-editor`。
- **Web 模式**：通过 `npm start` 启动时，推荐通过 `TYPORA_DATA_DIR` 指定本机磁盘独立子目录（如 `~/Library/Application Support/typora-compatible-editor/dev`）。
- **文件存储结构**：偏好设置 `settings.json`、上传临时文件 `uploads/`、导出文件 `exports/` 与导出缓存 `tmp/` 均保存在该数据目录下。
- **实测性能数据**：依据 8 组真实对照测试，Chrome 的 `user-data-dir`（profile）位于本次项目所在 QNAS 卷时，进程退出码为 2 且耗时约 24–34 秒（触发看门狗超时）；位于本机磁盘用户目录时，进程退出码为 0 且耗时约 1.3–2.3 秒。

## 4. 自动化测试

运行测试套件时，建议指定本机磁盘独立测试目录执行：

```bash
TYPORA_DATA_DIR="$HOME/Library/Application Support/typora-compatible-editor/test" npm test
```

### 测试验证结果
- **全套自动化测试回归**：共 97 项自动化测试全部通过（97 pass, 0 fail, 0 skipped，进程退出码 0，全量回归日志保存在 `work/typoar_brand_20261016/full_tests.log`）。
- **涵盖范围**：主题加载、基础样式契约、块级解析、公式与图表固化渲染、多格式导出管道、图床上传通道、偏好持久化、原生外壳接口与打包断链清理逻辑。

### 验证范围与边界说明
- **已验证范围**：安装版与源码版 Electron 行为、主题与字体资源加载、MathJax 公式与三类图表渲染、HTML/PDF/DOCX/EPUB/LaTeX 导出，以及偏好设置重启持久化。
- **未测试边界**：原生系统文件选择与保存对话框（`dialog.showOpenDialog` 与 `dialog.showSaveDialog`）依赖图形界面人工交互，本次验证未触发系统弹窗；文件读写逻辑均通过真实 API 接口完成验证。

## 5. macOS 原生应用打包与分发

### 5.1 执行打包命令

项目提供开箱即用的 macOS 客户端打包命令，打包前会自动调用 `npm run build`：

```bash
# 构建 macOS 应用程序包与便携 ZIP 压缩包
npm run package:mac

# 链式调用 package:mac 组装应用并制作 UDZO 格式磁盘镜像 DMG
npm run package:dmg

# 一次性生成完整双格式分发产物
npm run package
```

若直接复用已安装的应用包生成 DMG 镜像，跳过重新构建环节，执行以下命令：

```bash
TYPORA_APP_PATH="/Applications/TYPOAR.app" node scripts/make-dmg.js
```

脚本会自动校验指定目标的存在性、代码签名有效性（`codesign --verify --deep --strict`）、版本号与二进制架构（`lipo -archs`），核验通过后执行镜像封装。

### 5.2 产物与安装位置

- **本机安装应用**：`/Applications/TYPOAR.app`（已完成系统安装与本地代码签名验证，`codesign --verify --deep --strict` 退出码为 0，`Info.plist` 显示名称为 TYPOAR 且品牌图标哈希校验一致）。
- **分发目录产物** (`dist-package/`)：
  - `TYPOAR-1.0.0-mac-arm64.zip`：便携 ZIP 压缩包。
  - `TYPOAR-1.0.0-mac-arm64.dmg`：真实 UDZO 压缩格式磁盘镜像，内置 `/Applications` 软链接。
  - `manifest.json` 与 `SHA256SUMS.txt`：记录各分发产物的实时文件大小与 SHA256 校验码。
- **构建操作建议**：在本次项目所在 QNAS 卷执行大量文件读写耗时较长；建议通过环境变量 `TYPORA_PACKAGE_DIR` 指定本机磁盘目录执行打包，分发产物可写回 `dist-package/` 目录。
