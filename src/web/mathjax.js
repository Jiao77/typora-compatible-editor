// 浏览器端 MathJax 4 集成，SVG 输出匹配 Typora 主题依赖的 mjx-container 选择器
// 公式统一由浏览器渲染，服务端只输出占位标记，保证预览与导出结果一致

import { MATHJAX_CONFIG, MATHJAX_PACKAGES } from '../shared/mathjax-config.js';

export { MATHJAX_CONFIG, MATHJAX_PACKAGES };

let loading = null;

// 动态加载 MathJax 浏览器 bundle，避免阻塞编辑器首屏
export function loadMathJax(basePath = '/vendor/mathjax') {
  if (window.MathJax && window.MathJax.typesetPromise) return Promise.resolve(window.MathJax);
  if (loading) return loading;

  window.MathJax = { ...MATHJAX_CONFIG, ...(window.MathJax || {}) };
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${basePath}/tex-svg.js`;
    script.async = true;
    script.onload = () => {
      if (!window.MathJax) {
        reject(new Error('MathJax 加载完成但未挂载到 window'));
        return;
      }
      window.MathJax.startup.promise.then(() => resolve(window.MathJax), reject);
    };
    script.onerror = () => reject(new Error(`MathJax 脚本加载失败：${script.src}`));
    document.head.append(script);
  });
  return loading;
}

// 对预览容器执行排版，先清除历史输出以保证重复渲染结果正确
export async function typesetMath(root, basePath) {
  const mathJax = await loadMathJax(basePath);
  await mathJax.startup.promise;
  mathJax.typesetClear([root]);
  await mathJax.typesetPromise([root]);
  return mathJax;
}
