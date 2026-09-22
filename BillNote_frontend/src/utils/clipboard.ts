/**
 * 复制文本到剪贴板。
 *
 * 浏览器只在「安全上下文」（https 或 localhost）下提供 navigator.clipboard，
 * 手机上用局域网 / 公网 IP 通过 http 打开时这个 API 根本不存在，
 * 直接调用就会一直提示「复制失败」。所以这里在拿不到 API 时回退到
 * textarea + execCommand 的老办法，并在同一个点击手势里同步执行，
 * 保证 iPhone / Android 浏览器都能复制成功。
 *
 * @returns 是否复制成功
 */
export function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && window.isSecureContext && navigator.clipboard?.writeText) {
    return navigator.clipboard
      .writeText(text)
      .then(() => true)
      .catch(() => copyWithTextarea(text))
  }
  return Promise.resolve(copyWithTextarea(text))
}

function copyWithTextarea(text: string): boolean {
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '0'
    textarea.style.width = '1px'
    textarea.style.height = '1px'
    textarea.style.padding = '0'
    textarea.style.border = 'none'
    textarea.style.outline = 'none'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)

    const selection = document.getSelection()
    const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

    textarea.focus()
    textarea.select()
    // iOS 上只调 select() 有时选不中，需要显式设置选区范围
    textarea.setSelectionRange(0, textarea.value.length)

    const succeeded = document.execCommand('copy')
    document.body.removeChild(textarea)

    // 还原用户原本的选区，避免复制动作影响页面上的选择
    if (selection) {
      selection.removeAllRanges()
      if (previousRange) selection.addRange(previousRange)
    }
    return succeeded
  } catch {
    return false
  }
}
