/**
 * 把 oklch() / oklab() 颜色在构建时转成 sRGB 写法。
 *
 * 背景：Tailwind v4 生成的颜色（包括我们自己在 index.css 里定义的主题色变量）用的是 oklch()，
 * 只有 Chrome 111+ / Safari 15.4+ 才认识。夸克等老内核浏览器解析不了这个值，变量等于失效：
 * 边框颜色回退成黑色、弹层背景变成透明 —— 也就是手机上看到的那一堆样式问题。
 *
 * 转成 sRGB 之后所有浏览器都能正常解析，颜色观感基本不变（本项目的配色本来就在 sRGB 范围内）。
 *
 * 另外还负责修补带透明度的主题色兜底值，见文件末尾 applyAlphaFallback 的说明。
 */

const OKLCH_RE = /oklch\(([^()]*)\)/gi
const OKLAB_RE = /oklab\(([^()]*)\)/gi

const clamp = value => (value < 0 ? 0 : value > 1 ? 1 : value)

const linearToSrgb = value => {
  const v = clamp(value)
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/** oklab 坐标转 sRGB（Björn Ottosson 的矩阵） */
const oklabToSrgb = (L, a, b) => {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

/** 解析 "0.5 0.2 250 / 40%" 这类参数 */
const parseArgs = inner => {
  const [main, alphaPart] = inner.split('/')
  const parts = main.trim().split(/[\s,]+/).filter(Boolean)
  if (parts.length < 3) return null

  const toNumber = token => Number.parseFloat(String(token).replace(/(deg|grad|rad|turn)$/i, ''))

  let alpha = 1
  if (alphaPart !== undefined) {
    const raw = alphaPart.trim()
    alpha = raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw)
  }
  return { parts, toNumber, alpha }
}

const format = (rgb, alpha) => {
  const [r, g, b] = rgb.map(value => Math.round(clamp(value) * 255))
  // 用老式逗号写法，连很旧的内核也能解析
  if (!Number.isFinite(alpha) || alpha >= 1) return `rgb(${r}, ${g}, ${b})`
  return `rgba(${r}, ${g}, ${b}, ${Math.round(clamp(alpha) * 1000) / 1000})`
}

const convertOklch = inner => {
  const parsed = parseArgs(inner)
  if (!parsed) return null
  const { parts, toNumber, alpha } = parsed
  const lightness = parts[0].endsWith('%') ? Number.parseFloat(parts[0]) / 100 : toNumber(parts[0])
  const chroma = parts[1].endsWith('%')
    ? (Number.parseFloat(parts[1]) / 100) * 0.4
    : toNumber(parts[1])
  const hue = (toNumber(parts[2]) * Math.PI) / 180
  if (![lightness, chroma, hue].every(Number.isFinite)) return null
  return format(oklabToSrgb(lightness, chroma * Math.cos(hue), chroma * Math.sin(hue)), alpha)
}

const convertOklab = inner => {
  const parsed = parseArgs(inner)
  if (!parsed) return null
  const { parts, toNumber, alpha } = parsed
  const lightness = parts[0].endsWith('%') ? Number.parseFloat(parts[0]) / 100 : toNumber(parts[0])
  const a = toNumber(parts[1])
  const b = toNumber(parts[2])
  if (![lightness, a, b].every(Number.isFinite)) return null
  return format(oklabToSrgb(lightness, a, b), alpha)
}

/* ------------------------------------------------------------------
   带透明度的主题色，Tailwind 会输出两条规则，用前者当老内核的兜底：

     .bg-primary\/5 { background-color: var(--primary) }
     @supports (color: color-mix(in lab, red, red)) {
       .bg-primary\/5 { background-color: color-mix(in oklab, var(--primary) 5%, transparent) }
     }

   主题色是静态字面量时（例如 bg-black/50），Tailwind 会把 alpha 直接算进兜底值 #00000080；
   但本项目的主题色通过 @theme inline 映射到 var(--primary)、var(--background) 这类运行时变量，
   构建期算不出 alpha，兜底就退化成完全不透明的纯色。

   夸克这类老内核不支持 color-mix()，整个 @supports 块会被跳过，只剩那个纯色兜底：
   「生成历史」旁的同步按钮底色于是变成整块纯蓝，蓝色文字压在蓝底上就看不见了。
   这里在构建期把变量解析成字面量，给兜底补回正确的 rgba()。
   ------------------------------------------------------------------ */
const ALPHA_MIX_RE = /^color-mix\(in\s+oklab,\s*var\((--[A-Za-z0-9_-]+)\)\s+([0-9.]+)%\s*,\s*transparent\)$/i
const VAR_REF_RE = /^var\((--[A-Za-z0-9_-]+)\)$/

/** 解析 #rgb / #rgba / #rrggbb / #rrggbbaa 以及 rgb() / rgba() 字面量 */
const parseColor = value => {
  const raw = String(value).trim()

  const hex = /^#([0-9a-f]{3,8})$/i.exec(raw)
  if (hex) {
    let digits = hex[1]
    if (digits.length === 3 || digits.length === 4) {
      digits = [...digits].map(digit => digit + digit).join('')
    }
    if (digits.length !== 6 && digits.length !== 8) return null
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      a: digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1,
    }
  }

  const fn = /^rgba?\(([^)]*)\)$/i.exec(raw)
  if (!fn) return null
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3) return null

  const channel = token =>
    token.endsWith('%') ? (Number.parseFloat(token) / 100) * 255 : Number.parseFloat(token)
  const [r, g, b] = parts.slice(0, 3).map(channel)
  const alpha =
    parts[3] === undefined
      ? 1
      : parts[3].endsWith('%')
        ? Number.parseFloat(parts[3]) / 100
        : Number.parseFloat(parts[3])
  if (![r, g, b, alpha].every(Number.isFinite)) return null
  return { r, g, b, a: alpha }
}

const toRgba = (color, alpha) => {
  const channel = value => Math.max(0, Math.min(255, Math.round(value)))
  const baseAlpha = Number.isFinite(color.a) ? color.a : 1
  const merged = Math.max(0, Math.min(1, alpha * baseAlpha))
  return `rgba(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}, ${Math.round(merged * 1000) / 1000})`
}

/** 收集亮色 / 暗色两套 CSS 变量，暗色只需记录被覆盖的那部分 */
const collectVars = root => {
  const light = new Map()
  const dark = new Map()

  root.walkRules(rule => {
    const parts = rule.selector.split(',').map(part => part.trim())
    const isDarkScope = parts.some(part => part === '.dark')
    const isLightScope = parts.some(
      part => part === '*' || part === ':root' || part === ':host' || part.startsWith(':root')
    )
    if (!isDarkScope && !isLightScope) return

    const target = isDarkScope ? dark : light
    rule.walkDecls(/^--/, decl => {
      target.set(decl.prop, decl.value.trim())
    })
  })

  return { light, dark }
}

/** 顺着 var() 引用一路解析到具体的颜色字面量 */
const resolveColor = (name, vars, seen = new Set()) => {
  if (seen.has(name)) return null
  seen.add(name)

  const raw = vars.get(name)
  if (!raw) return null

  const ref = VAR_REF_RE.exec(raw)
  if (ref) return resolveColor(ref[1], vars, seen)
  return parseColor(raw)
}

/** 在 @supports 之前找到同名选择器的兜底声明 */
const findFallbackDecl = (atRule, selector, property, varName) => {
  const container = atRule.parent
  if (!container || typeof container.index !== 'function') return null
  const start = container.index(atRule)
  if (start === undefined) return null

  for (let i = start - 1; i >= 0; i -= 1) {
    const node = container.nodes[i]
    if (node.type !== 'rule' || node.selector !== selector) continue

    let match = null
    node.walkDecls(property, decl => {
      if (decl.value.trim() === `var(${varName})`) match = decl
    })
    // 只有紧邻的那条兜底规则是目标，找不到就停，避免误改更早的同名规则
    if (match) return match
    return null
  }

  return null
}

const applyAlphaFallback = root => {
  const { light, dark } = collectVars(root)
  if (light.size === 0) return

  root.walkAtRules(atRule => {
    if (atRule.name.toLowerCase() !== 'supports') return
    if (!/color-mix\(/i.test(atRule.params)) return

    atRule.walkRules(rule => {
      const vars = /(^|[\s,>+~])\.dark($|[\s,>+~.:[]|\*)/.test(rule.selector)
        ? new Map([...light, ...dark])
        : light

      rule.walkDecls(decl => {
        const mixed = ALPHA_MIX_RE.exec(decl.value.trim())
        if (!mixed) return

        const color = resolveColor(mixed[1], vars)
        if (!color) return

        const fallback = findFallbackDecl(atRule, rule.selector, decl.prop, mixed[1])
        if (!fallback) return

        fallback.value = toRgba(color, Number.parseFloat(mixed[2]) / 100)
      })
    })
  })
}

module.exports = () => ({
  postcssPlugin: 'postcss-oklch-fallback',
  Declaration(decl) {
    if (!decl.value || !/okl(ch|ab)\(/i.test(decl.value)) return
    decl.value = decl.value
      .replace(OKLCH_RE, (match, inner) => convertOklch(inner) || match)
      .replace(OKLAB_RE, (match, inner) => convertOklab(inner) || match)
  },
  OnceExit(root) {
    applyAlphaFallback(root)
  },
})

module.exports.postcss = true
