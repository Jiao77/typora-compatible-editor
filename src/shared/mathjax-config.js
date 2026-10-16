// MathJax 4 配置，浏览器预览与导出渲染共用同一份定义，保证两侧排版结果一致

// Typora 文档常用的 TeX 扩展包，均为 npm mathjax 4.1.3 真实提供的组件
export const MATHJAX_PACKAGES = [
  'ams',
  'amscd',
  'autoload',
  'bbox',
  'boldsymbol',
  'braket',
  'bussproofs',
  'cancel',
  'cases',
  'centernot',
  'color',
  'colortbl',
  'configmacros',
  'empheq',
  'enclose',
  'extpfeil',
  'gensymb',
  'mathtools',
  'mhchem',
  'newcommand',
  'noundefined',
  'physics',
  'setoptions',
  'tagformat',
  'textcomp',
  'textmacros',
  'unicode',
  'units',
  'upgreek',
  'verb'
];

// MathJax 4 必须先通过 loader.load 声明组件，tex.packages 只负责启用
// 只写 tex.packages 会得到 "Package not found" 告警且扩展语法失效
export const MATHJAX_LOAD = MATHJAX_PACKAGES.map((name) => `[tex]/${name}`);

export const MATHJAX_CONFIG = {
  loader: {
    load: MATHJAX_LOAD,
    // 全部组件从本地 vendor 加载，禁止回退到 CDN，否则离线环境会挂起
    paths: {
      mathjax: '/vendor/mathjax',
      // MathJax 4 用 fonts 前缀解析字体扩展包，默认指向 CDN，这里改到本地目录
      fonts: '/vendor/@mathjax'
    }
  },
  tex: {
    // 同时支持 $...$ 与 \(...\) 两套定界符，服务端输出使用后者
    inlineMath: [['$', '$'], ['\\(', '\\)']],
    displayMath: [['$$', '$$'], ['\\[', '\\]']],
    processEscapes: true,
    packages: { '[+]': MATHJAX_PACKAGES }
  },
  svg: { fontCache: 'local' },
  options: {
    enableMenu: false
  },
  startup: { typeset: false }
};
