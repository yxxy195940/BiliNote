import React, { FC, useEffect, useRef, useState } from 'react'
import {
  SlidersHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  History as HistoryIcon,
  SquarePen,
  FileText,
  Loader2,
  type LucideIcon,
} from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip.tsx'

import { Link } from 'react-router-dom'
import { ResizablePanel, ResizablePanelGroup, ResizableHandle } from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area.tsx'
import type { ImperativePanelHandle } from 'react-resizable-panels'
import logo from '@/assets/icon.svg'
import { useIsMobile } from '@/hooks/useIsMobile.ts'
import { useTaskStore } from '@/store/taskStore'
import { useSyncStore } from '@/store/syncStore'

interface IProps {
  NoteForm: React.ReactNode
  Preview: React.ReactNode
  History: React.ReactNode
}

type MobileTab = 'form' | 'history' | 'note'

const MOBILE_TABS: { key: MobileTab; label: string; icon: LucideIcon }[] = [
  { key: 'form', label: '输入', icon: SquarePen },
  { key: 'history', label: '历史', icon: HistoryIcon },
  { key: 'note', label: '笔记', icon: FileText },
]

const HomeLayout: FC<IProps> = ({ NoteForm, Preview, History }) => {
  const isMobile = useIsMobile()
  const [, setShowSettings] = useState(false)
  const [isLeftCollapsed, setIsLeftCollapsed] = useState(false)
  const [isMiddleCollapsed, setIsMiddleCollapsed] = useState(false)
  const leftPanelRef = useRef<ImperativePanelHandle>(null)
  const middlePanelRef = useRef<ImperativePanelHandle>(null)

  // 移动端：三栏布局在手机上不可用，改为单栏 + 页签切换
  const [mobileTab, setMobileTab] = useState<MobileTab>('form')
  const currentTaskId = useTaskStore(state => state.currentTaskId)
  const selectionTick = useTaskStore(state => state.selectionTick)
  const tasks = useTaskStore(state => state.tasks)
  const prevTaskIdRef = useRef<string | null>(currentTaskId)
  const firstTickRef = useRef(true)

  const currentTask = tasks.find(t => t.id === currentTaskId)
  const isGenerating =
    !!currentTask && currentTask.status !== 'SUCCESS' && currentTask.status !== 'FAILED'

  // 新建任务或从历史中选中任务后，自动切到「笔记」页，省去用户再点一次
  useEffect(() => {
    if (currentTaskId && currentTaskId !== prevTaskIdRef.current) {
      setMobileTab('note')
    }
    prevTaskIdRef.current = currentTaskId
  }, [currentTaskId])

  // 点选历史里的笔记（哪怕是已经选中的那条）也切到「笔记」页签
  useEffect(() => {
    if (firstTickRef.current) {
      firstTickRef.current = false
      return
    }
    setMobileTab('note')
  }, [selectionTick])

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
            to={'/settings'}
            aria-label="全局配置"
            className="text-muted-foreground hover:text-primary rounded p-1.5 hover:bg-neutral-100"
          >
            <SlidersHorizontal className="h-5 w-5" />
          </Link>
        </header>

        <nav className="flex shrink-0 border-b border-neutral-200">
          {MOBILE_TABS.map(({ key, label, icon: Icon }) => {
            const active = mobileTab === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setMobileTab(key)
                  // 切到历史列表时顺手同步一次
                  if (key === 'history') void useSyncStore.getState().syncNow()
                }}
                className={`relative flex flex-1 items-center justify-center gap-1.5 py-3 text-sm font-medium transition-colors ${
                  active ? 'text-primary' : 'text-neutral-500'
                }`}
              >
                <Icon className="h-4 w-4" />
                <span>{label}</span>
                {key === 'note' && isGenerating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {active && (
                  <span className="bg-primary absolute inset-x-8 bottom-0 h-0.5 rounded-full" />
                )}
              </button>
            )
          })}
        </nav>

        <div className="flex flex-col">
          {/* 表单保持挂载，切换页签时不丢失已填写的链接与配置 */}
          <div className={mobileTab === 'form' ? 'block' : 'hidden'}>
            <div className="p-3">{NoteForm}</div>
          </div>
          <div className={mobileTab === 'history' ? 'block' : 'hidden'}>
            {History}
          </div>
          {/* 预览按需挂载：思维导图依赖真实尺寸，隐藏时尺寸为 0 会导致绘制异常 */}
          {mobileTab === 'note' && <div className="p-3">{Preview}</div>}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <ResizablePanelGroup direction="horizontal" className="h-full w-full">
        {/* 左边表单 */}
        <ResizablePanel
          ref={leftPanelRef}
          defaultSize={23}
          minSize={10}
          maxSize={35}
          collapsible
          collapsedSize={0}
          onCollapse={() => setIsLeftCollapsed(true)}
          onExpand={() => setIsLeftCollapsed(false)}
        >
          <aside className="flex h-full flex-col overflow-hidden border-r border-neutral-200 bg-white">
            <header className="flex h-16 items-center justify-between px-6">
              <div className="flex items-center gap-2">
                <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-2xl">
                  <img src={logo} alt="logo" className="h-full w-full object-contain" />
                </div>
                <div className="text-2xl font-bold text-gray-800">BiliNote</div>
              </div>
              <div className="flex items-center gap-1">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => leftPanelRef.current?.collapse()}
                        className="text-muted-foreground hover:text-primary cursor-pointer rounded p-1 hover:bg-neutral-100"
                      >
                        <PanelLeftClose className="h-5 w-5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <span>收起工作区</span>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger onClick={() => setShowSettings(true)}>
                      <Link to={'/settings'}>
                        <SlidersHorizontal className="text-muted-foreground hover:text-primary cursor-pointer" />
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent>
                      <span>全局配置</span>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </header>
            <ScrollArea className="flex-1 overflow-auto">
              <div className="p-4">{NoteForm}</div>
            </ScrollArea>
          </aside>
        </ResizablePanel>

        <ResizableHandle />

        {/* 左面板折叠时的展开按钮 */}
        {isLeftCollapsed && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => leftPanelRef.current?.expand()}
                  className="flex h-full w-8 shrink-0 items-center justify-center border-r border-neutral-200 bg-white hover:bg-neutral-50"
                >
                  <PanelLeftOpen className="h-4 w-4 text-muted-foreground" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <span>展开工作区</span>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        {/* 中间历史 */}
        <ResizablePanel
          ref={middlePanelRef}
          defaultSize={16}
          minSize={10}
          maxSize={30}
          collapsible
          collapsedSize={0}
          onCollapse={() => setIsMiddleCollapsed(true)}
          onExpand={() => setIsMiddleCollapsed(false)}
        >
          <aside className="flex h-full flex-col overflow-hidden border-r border-neutral-200 bg-white">
            <header className="flex h-10 shrink-0 items-center justify-between border-b border-neutral-100 px-3">
              <span className="text-sm font-medium text-gray-600">生成历史</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => middlePanelRef.current?.collapse()}
                      className="text-muted-foreground hover:text-primary cursor-pointer rounded p-1 hover:bg-neutral-100"
                    >
                      <PanelLeftClose className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <span>收起历史</span>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </header>
            <ScrollArea className="flex-1 overflow-auto">
              <div>{History}</div>
            </ScrollArea>
          </aside>
        </ResizablePanel>

        <ResizableHandle />

        {/* 中间面板折叠时的展开按钮 */}
        {isMiddleCollapsed && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => middlePanelRef.current?.expand()}
                  className="flex h-full w-8 shrink-0 items-center justify-center border-r border-neutral-200 bg-white hover:bg-neutral-50"
                >
                  <HistoryIcon className="h-4 w-4 text-muted-foreground" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <span>展开历史</span>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        {/* 右边预览 */}
        <ResizablePanel defaultSize={61} minSize={30}>
          <main className="flex h-full flex-col overflow-hidden bg-white p-6">{Preview}</main>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

export default HomeLayout
