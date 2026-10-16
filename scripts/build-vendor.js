import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 把 flowchart.js 与 js-sequence-diagrams 的浏览器资源集中到 public/vendor/diagrams
// flowchart.js 只提供 CommonJS 源码，需要打包为 IIFE 供浏览器直接加载

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = path.join(rootDir, 'public/vendor/diagrams');

await mkdir(targetDir, { recursive: true });

await build({
  stdin: {
    contents: "import flowchart from 'flowchart.js';\nwindow.TyporaFlowchart = flowchart;",
    resolveDir: rootDir,
    sourcefile: 'flowchart-entry.js',
    loader: 'js'
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  minify: true,
  outfile: path.join(targetDir, 'flowchart.js'),
  logLevel: 'warning'
});

// 这三个文件提供浏览器全局变量，js-sequence-diagrams 依赖它们
const copies = [
  ['node_modules/jquery/dist/jquery.min.js', 'jquery.js'],
  ['node_modules/underscore/underscore-min.js', 'underscore.js'],
  [
    'node_modules/@rokt33r/js-sequence-diagrams/node_modules/raphael/raphael-min.js',
    'raphael.js'
  ],
  ['node_modules/@rokt33r/js-sequence-diagrams/dist/sequence-diagram-raphael-min.js', 'sequence-diagram.js']
];

for (const [source, name] of copies) {
  await copyFile(path.join(rootDir, source), path.join(targetDir, name));
  console.log(`vendor: ${name}`);
}
