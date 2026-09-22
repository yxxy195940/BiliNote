import { useEffect, useState } from 'react'

/** 小于此宽度的视口按移动端处理（对应 Tailwind 的 md 断点） */
const MOBILE_QUERY = '(max-width: 767px)'

/**
 * 监听媒体查询。移动端需要渲染完全不同的布局结构，只靠 CSS 隐藏会同时挂载两套组件，
 * 因此这里用 JS 判断后按需渲染其中一套。
 * 初始值直接读取 matchMedia，避免首帧先渲染桌面布局再跳变。
 */
export const useMediaQuery = (query: string = MOBILE_QUERY): boolean => {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches
  )

  useEffect(() => {
    const mql = window.matchMedia(query)
    setMatches(mql.matches)

    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

export const useIsMobile = (): boolean => useMediaQuery(MOBILE_QUERY)
