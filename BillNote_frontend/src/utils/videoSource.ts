/**
 * 从任务里推导出「能拿去重新生成」的视频链接。
 *
 * 背景：同步到本机的笔记是从服务器拼出来的（见 taskStore.mergeRemoteEntries），
 * 而同步接口本身不存链接，只存平台 + 视频 ID + audio_meta，所以这类笔记的
 * formData.video_url 一直是空字符串 —— 表单必填校验直接卡住，点「重新生成」没反应。
 *
 * 实际上链接一直都在数据里，只是没人去读：
 *   1. audio_meta.raw_info 是 yt-dlp 的原始信息，里面的 webpage_url / original_url 就是链接
 *      （B 站/YouTube 都有，抖音的 raw_info 只有 tags，需要靠 ID 拼）
 *   2. 实在没有 raw_info 时，用 平台 + video_id 拼一条标准链接也够 yt-dlp 吃
 *
 * 所以这里做三级兜底，尽量让每一条同步笔记都能重新生成。
 */

/** 重新下载只需要这几个 query 参数，其余全是分享埋点 */
const KEEP_QUERY: Record<string, string[]> = {
  bilibili: ['p'],
  youtube: ['v', 'list', 't', 'index'],
  douyin: [],
  kuaishou: [],
}

/** 只有 http(s) 才算链接；本地文件路径不在此列 */
const isHttpUrl = (text: string): boolean => /^https?:\/\//i.test(text)

/**
 * 清洗链接：丢掉分享埋点，只留重新下载需要的参数。
 * 例：`https://www.bilibili.com/video/BV1xx/?share_source=copy_web&vd_source=...`
 *   → `https://www.bilibili.com/video/BV1xx/`
 */
export function sanitizeVideoUrl(rawUrl?: string | null): string {
  const text = (rawUrl || '').trim()
  if (!text || !isHttpUrl(text)) return ''

  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return text
  }

  const platform = (parsed.hostname.includes('bilibili') || parsed.hostname === 'b23.tv')
    ? 'bilibili'
    : parsed.hostname.includes('youtube') || parsed.hostname === 'youtu.be'
      ? 'youtube'
      : parsed.hostname.includes('douyin')
        ? 'douyin'
        : parsed.hostname.includes('kuaishou')
          ? 'kuaishou'
          : ''

  // 手机端分享出来的 m.bilibili.com 后端校验不认，统一成 www
  if (parsed.hostname.toLowerCase() === 'm.bilibili.com') parsed.hostname = 'www.bilibili.com'

  if (!parsed.search && !parsed.hash) return parsed.toString()

  const kept = new URLSearchParams()
  const allow = KEEP_QUERY[platform] || []
  parsed.searchParams.forEach((value, key) => {
    if (allow.includes(key.toLowerCase())) kept.append(key, value)
  })
  parsed.search = kept.toString()
  parsed.hash = ''

  return parsed.toString()
}

/** B 站的 video_id 有时是 BV1xxx_p2 这种带分 P 的形式，拼链接要去掉后缀 */
const normalizeVideoId = (videoId?: string): string =>
  (videoId || '').trim().replace(/_[pP]\d+$/, '')

export interface VideoSource {
  /** 任务所属平台，如 bilibili / youtube / local */
  platform?: string
  /** 视频 ID（B 站 BV 号、YouTube 11 位 ID、抖音 aweme_id…） */
  videoId?: string
  /** yt-dlp 返回的原始信息，里面有 webpage_url */
  rawInfo?: Record<string, unknown> | null
  /** 任务里已经存过的链接，非空时直接用，不改动用户数据 */
  fallback?: string | null
}

/**
 * 推导视频链接，推不出来返回空字符串（调用方负责提示用户手动填）。
 *
 * 优先级：已存链接 > raw_info 里的原始链接 > 按平台拼标准链接
 */
export const resolveVideoUrl = ({ platform, videoId, rawInfo, fallback }: VideoSource): string => {
  const kind = (platform || '').trim().toLowerCase()

  // 本地视频填的就是磁盘路径，不按链接规则清洗
  if (kind === 'local') {
    const stored = (fallback || '').trim()
    if (stored) return stored
    const localInfo = rawInfo && typeof rawInfo === 'object' ? rawInfo : {}
    const path = typeof localInfo.path === 'string' ? localInfo.path.trim() : ''
    return path
  }

  const existing = sanitizeVideoUrl(fallback)
  if (existing) return existing

  const info = rawInfo && typeof rawInfo === 'object' ? rawInfo : {}

  for (const key of ['webpage_url', 'original_url']) {
    const value = info[key]
    const url = sanitizeVideoUrl(typeof value === 'string' ? value : '')
    if (url) return url
  }

  const id = normalizeVideoId(videoId)
  if (!id) return ''

  if (kind === 'bilibili' && /^[Bb][Vv][0-9A-Za-z]+$/.test(id)) {
    return `https://www.bilibili.com/video/${id}`
  }
  if (kind === 'youtube' && /^[0-9A-Za-z_-]{6,}$/.test(id)) {
    return `https://www.youtube.com/watch?v=${id}`
  }
  if (kind === 'douyin' && /^\d{6,}$/.test(id)) {
    return `https://www.douyin.com/video/${id}`
  }
  if (kind === 'kuaishou' && /^\d{6,}$/.test(id)) {
    return `https://www.kuaishou.com/short-video/${id}`
  }

  return ''
}
