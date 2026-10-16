import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 主编辑器与偏好设置窗口分别打包，共享同一套依赖
const targets = [
  { entry: 'src/web/app.js', out: 'dist/app.js' },
  { entry: 'src/web/settings.js', out: 'dist/settings.js' }
];

for (const target of targets) {
  await build({
    entryPoints: [path.join(rootDir, target.entry)],
    bundle: true,
    format: 'esm',
    target: ['chrome120'],
    platform: 'browser',
    minify: true,
    sourcemap: true,
    outfile: path.join(rootDir, target.out),
    logLevel: 'info'
  });
}
