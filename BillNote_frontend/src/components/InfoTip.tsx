import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { cn } from '@/lib/utils.ts'

interface InfoTipProps {
  /** 气泡里的说明文字 */
  children: ReactNode
  className?: string
  /** 无障碍标签，默认「查看说明」 */
  label?: string
}

/**
 * 表单里的 ⓘ 说明图标。
 *
 * Radix 的 Tooltip 只认「鼠标悬停 / 键盘聚焦」：它在 onPointerMove 里遇到触摸指针会直接返回，
 * 桌面端鼠标移上去能出气泡，手机上点它却毫无反应；再加上图标本身是 <svg>、不在键盘 Tab 序列里，
 * 移动端就没有任何办法把它打开。
 *
 * 所以这里改成受控的 Tooltip：触摸点按自行切换展开状态，鼠标端仍然是悬停展开，
 * 键盘用户则通过聚焦打开。图标同时换成真正的 <button>，让点击区域和语义都正确。
 */
const InfoTip = ({ children, className, label = '查看说明' }: InfoTipProps) => {
  const [open, setOpen] = useState(false)
  // 最近一次按下是否为触摸/手写笔
  const pressedByTouch = useRef(false)
  // 这次点按的「展开」是否已被 pointerdown 阶段的收起抵消
  const closedOnPress = useRef(false)

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            // 图标视觉尺寸仍是 16px；用等量内边距 + 负外边距把点击区域撑到 28px，排版不受影响
            'hover:text-primary -m-1.5 inline-flex shrink-0 items-center p-1.5 text-neutral-400',
            className
          )}
          onPointerDown={event => {
            pressedByTouch.current = event.pointerType !== 'mouse'
            // 气泡已展开时，Radix 会在 pointerdown 里先把它收起；这次点按就算「收起」，
            // 记录一下，避免紧接着的 click 又把它打开，导致点第二次关不掉。
            closedOnPress.current = pressedByTouch.current && open
          }}
          onClick={event => {
            // 鼠标端保持原样：悬停已能展开，点击即收起
            if (!pressedByTouch.current) return
            event.preventDefault()
            if (closedOnPress.current) {
              closedOnPress.current = false
              return
            }
            setOpen(true)
          }}
        >
          <Info className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="text-xs">{children}</TooltipContent>
    </Tooltip>
  )
}

export default InfoTip
