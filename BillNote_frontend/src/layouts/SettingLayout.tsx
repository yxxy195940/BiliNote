import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip.tsx'
import { Link, Outlet } from 'react-router-dom'
import { ArrowLeft, SlidersHorizontal } from 'lucide-react'
import React from 'react'
import logo from '@/assets/icon.svg'
import { useIsMobile } from '@/hooks/useIsMobile.ts'

interface ISettingLayoutProps {
  Menu: React.ReactNode
}
const SettingLayout = ({ Menu }: ISettingLayoutProps) => {
  const isMobile = useIsMobile()

  // 移动端：固定 300px 的侧边栏在手机上不可用，改为「顶部菜单条 + 下方内容」
  if (isMobile) {
    return (
      <div className="flex min-h-screen flex-col overflow-visible bg-white">
        <header className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-3 py-2">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-xl">
              <img src={logo} alt="logo" className="h-full w-full object-contain" />
            </div>
            <div className="text-lg font-bold text-gray-800">BiliNote</div>
          </div>
          <Link
            to={'/'}
            aria-label="返回首页"
            className="text-muted-foreground hover:text-primary flex items-center gap-1 rounded p-1.5 text-sm hover:bg-neutral-100"
          >
            <ArrowLeft className="h-4 w-4" />
            返回
          </Link>
        </header>

        <div className="shrink-0 border-b border-neutral-200 bg-white">{Menu}</div>

        <main className="overflow-visible">
          <Outlet />
        </main>
      </div>
    )
  }

  return (
    <div
      className="h-full w-full"
      style={{
        backgroundColor: 'var(--color-muted)',
      }}
    >
      <div className="flex flex-1">
        {/* 左侧部分：Header + 表单 */}
        <aside className="flex w-[300px] flex-col border-r border-neutral-200 bg-white">
          {/* Header */}
          <header className="flex h-16 items-center justify-between px-6">
            <div className="flex items-center gap-2">
              <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-2xl">
                <img src={logo} alt="logo" className="h-full w-full object-contain" />
              </div>
              <div className="text-2xl font-bold text-gray-800">BiliNote</div>
            </div>
            <div>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <Link to={'/'}>
                      <SlidersHorizontal className="text-muted-foreground hover:text-primary cursor-pointer" />
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent>
                    <span>返回首页</span>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </header>

          {/* 表单内容 */}
          <div className="flex-1 overflow-auto p-4">
            {/*<NoteForm />*/}
            {Menu}
          </div>
        </aside>

        {/* 右侧预览区域 */}
        <main className="h-screen flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
export default SettingLayout
