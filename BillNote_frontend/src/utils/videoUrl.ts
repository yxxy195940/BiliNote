/**
 * 视频链接识别与清洗。
 *
 * 从手机 App 点「分享 → 复制链接」拿到的文案通常长这样：
 *   【DeepSeek V4.1 Flash对比GLM 5.3 Flash，哪个更值得用，性价比更高？】 https://www.bilibili.com/video/BV15iYv63EvA/?share_source=copy_web&vd_source=74c6bf8...
 * 整段粘进输入框会被表单校验判成非法链接（`new URL(整段文本)` 直接抛错），
 * 所以这里负责把里面的链接揪出来、洗掉纯跟踪参数，并识别它属于哪个平台。
 *
 * ⚠️ 平台判定规则需与下面两处保持一致，改动时同步：
 *   - backend/app/validators/video_url_validator.py
 *   - BillNote_extension/src/logic/platform.ts
 */

export type VideoPlatform = 'bilibili' | 'youtube' | 'douyin' | 'kuaishou'

export interface ParsedVideoInput {
  /** 清洗后的链接，用于提交 */
  url: string
  /** 文本里原始匹配到的链接（可能带跟踪参数） */
  rawUrl: string
  /** 识别到的平台，未识别为 null */
  platform: VideoPlatform | null
  /** 分享文案里被【】/「」包裹的标题，解析不到为 null */
  title: string | null
  /** 输入文本除了链接之外还有别的内容，即真的「抽」了一次 */
  extracted: boolean
}

/** 匹配 http(s) 链接；显式排除空白与常见中英文收尾标点，避免把句尾的「，」「）」吃进链接 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`，,。；;、）)】\]}「」]+/gi

/** 分享文案里的标题：由 【】 / 「」 / [] 包裹 */
const TITLE_PATTERN = /【([^】]{2,120})】|「([^」]{2,120})」|\[([^\]]{2,120})\]/

/**
 * 纯跟踪参数，删掉不影响视频定位。
 * 故意不删 `v` / `p` / `list` / `t` / `start` 这类带语义的参数（YouTube 视频号、B 站分 P、播放列表、起播时间）。
 */
const TRACKING_PARAMS = new Set([
  // 通用渠道埋点
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  // B 站分享
  'share_source',
  'share_medium',
  'share_plat',
  'share_tag',
  'share_times',
  'share_session_id',
  'share_token',
  'share_uid',
  'vd_source',
  'spm',
  'spm_id_from',
  'from_source',
  'from_spmid',
  'seid',
  'buvid',
  'up_id',
  'broadcast_type',
  'is_room_feed',
  'bbid',
  'ts',
  'unique_k',
  'msource',
  // YouTube 分享
  'si',
  'feature',
  'pp',
  'ab_channel',
  'start_radio',
])

/** 去掉链接尾部可能被误吞的英文标点（全角标点已在 URL_PATTERN 里排除） */
function trimUrlTail(url: string): string {
  return url.replace(/[.,;:!?)\]}>'"]+$/, '')
}

/**
 * 识别链接所属平台。
 * 只按域名判断（宽松），比后端正则更宽；后端不认的路径会由后端给出明确报错，
 * 但至少平台下拉框不会停在错误的选项上。
 */
export function detectPlatform(rawUrl: string): VideoPlatform | null {
  const text = rawUrl?.trim()
  if (!text) return null

  let host = ''
  try {
    host = new URL(text).hostname.toLowerCase()
  } catch {
    // 容错：调用方可能传进来一小段不带协议头的文本
    host = text.toLowerCase()
  }

  if (host === 'b23.tv' || host.includes('bilibili')) return 'bilibili'
  if (host === 'youtu.be' || host.includes('youtube')) return 'youtube'
  if (host.includes('douyin')) return 'douyin'
  if (host.includes('kuaishou')) return 'kuaishou'
  return null
}

/** 手机端分享出来的 m.bilibili.com 后端校验不认，统一成 www */
function normalizeHost(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.toLowerCase() === 'm.bilibili.com') parsed.hostname = 'www.bilibili.com'
    return parsed.toString()
  } catch {
    return url
  }
}

/** 剥离跟踪参数，失败时原样返回（不因为清洗把一条好链接弄坏） */
export function cleanVideoUrl(rawUrl: string): string {
  const normalized = normalizeHost(trimUrlTail(rawUrl?.trim() ?? ''))
  if (!normalized) return ''

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    return normalized
  }
  if (!parsed.search) return normalized

  const kept = new URLSearchParams()
  parsed.searchParams.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (!TRACKING_PARAMS.has(lower) && !lower.startsWith('utm_')) kept.append(key, value)
  })
  parsed.search = kept.toString()

  return parsed.toString()
}

/** 解析分享文案里的标题，解析不到返回 null */
export function extractShareTitle(text: string): string | null {
  const match = text?.match(TITLE_PATTERN)
  if (!match) return null
  const title = (match[1] ?? match[2] ?? match[3] ?? '').trim()
  return title || null
}

/**
 * 从任意文本里解析出一条视频链接。
 *
 * 一段文案里可能夹着多个链接（页面复制的正文常带广告/推荐链接），
 * 优先取能识别出平台的；全都识别不出来才退回第一个。
 *
 * @returns 没找到链接时返回 null
 */
export function parseVideoInput(text: string): ParsedVideoInput | null {
  const trimmed = text?.trim() ?? ''
  if (!trimmed) return null

  const candidates = trimmed.match(URL_PATTERN)?.map(trimUrlTail).filter(Boolean) ?? []
  if (!candidates.length) return null

  const chosen = candidates.find(url => detectPlatform(url) !== null) ?? candidates[0]
  const url = cleanVideoUrl(chosen)

  return {
    url,
    rawUrl: chosen,
    platform: detectPlatform(url),
    title: extractShareTitle(trimmed),
    extracted: trimmed !== chosen,
  }
}

/** 输入本来就是一条干净链接，没有额外内容要抽 */
export function isCleanUrlInput(text: string): boolean {
  const parsed = parseVideoInput(text)
  return !!parsed && !parsed.extracted && parsed.url === parsed.rawUrl
}
