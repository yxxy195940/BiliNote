module.exports = {
  plugins: {
    '@tailwindcss/postcss': {},
    autoprefixer: {},
    // 放在最后：把 Tailwind 生成的颜色从 oklch() 降级成 sRGB，兼容夸克等老内核浏览器
    './postcss-oklch-fallback.cjs': {},
  },
}
