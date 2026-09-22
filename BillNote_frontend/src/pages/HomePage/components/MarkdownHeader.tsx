'use client'

import { useEffect, useState } from 'react'
import { Copy, Download, BrainCircuit, MessageSquare, FileText, ScrollText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Badge } from '@/components/ui/badge'

interface VersionNote {
  ver_id: string
  model_name?: string
  style?: string
  created_at?: string
}

interface NoteHeaderProps {
  currentTask?: {
    markdown: VersionNote[] | string
  }
  isMultiVersion: boolean
  currentVerId: string
  setCurrentVerId: (id: string) => void
  modelName: string
  style: string
  noteStyles: { value: string; label: string }[]
  onCopy: () => void
  onDownload: () => void
  createAt?: string | Date
  setShowTranscribe: (show: boolean) => void
  showChat?: false | 'half' | 'full'
  setShowChat?: (mode: false | 'half' | 'full') => void
  viewMode: 'map' | 'preview'
  setViewMode: (mode: 'map' | 'preview') => void
  isMobile?: boolean
}

export function MarkdownHeader({
  currentTask,
  isMultiVersion,
  currentVerId,
  setCurrentVerId,
  modelName,
  style,
  noteStyles,
  onCopy,
  onDownload,
  createAt,
  showTranscribe,
  setShowTranscribe,
  showChat,
  setShowChat,
  viewMode,
  setViewMode,
  isMobile,
}: NoteHeaderProps) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let timer: NodeJS.Timeout
    if (copied) {
      timer = setTimeout(() => setCopied(false), 2000)
    }
    return () => clearTimeout(timer)
  }, [copied])

  const handleCopy = () => {
    onCopy()
    setCopied(true)
  }

  const styleName = noteStyles.find(v => v.value === style)?.label || style

  const reversedMarkdown: VersionNote[] = Array.isArray(currentTask?.markdown)
    ? [...currentTask!.markdown].reverse()
    : []

  const formatDate = (date: string | Date | undefined) => {
    if (!date) return ''
    const d = typeof date === 'string' ? new Date(date) : date
    if (isNaN(d.getTime())) return ''
    return d
      .toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
      .replace(/\//g, '-')
  }

  // 手机上「原文参照」和「AI 问答」都是切换逻辑：按钮蓝底 = 当前正在看的内容，
  // 再点一次回到 Markdown 笔记；两个面板互斥，打开一个会自动收起另一个。
  const transcriptActive = viewMode === 'preview' && showTranscribe
  const chatActive = viewMode === 'preview' && !!showChat
  // 手机上原文参照 / AI 问答 会盖住笔记本身，所以同一时刻只让一个按钮蓝底：
  // 面板打开时 Markdown 按钮不再是「当前内容」，点它就直接回到笔记。
  const markdownActive = viewMode === 'preview' && !(isMobile && (showTranscribe || !!showChat))

  const showMarkdown = () => {
    setViewMode('preview')
    if (isMobile) {
      setShowTranscribe(false)
      setShowChat?.(false)
    }
  }

  const toggleTranscribe = () => {
    const next = !transcriptActive
    setViewMode('preview')
    setShowTranscribe(next)
    setShowChat?.(false)
  }

  const toggleChat = () => {
    const next = !chatActive
    setViewMode('preview')
    setShowChat?.(next ? 'half' : false)
    setShowTranscribe(false)
  }

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b bg-white/95 px-2 py-2 backdrop-blur-sm md:gap-3 md:px-4">
      {/* 左侧区域：版本 + 标签 + 创建时间 */}
      <div className="flex flex-wrap items-center gap-2 md:gap-3">
        {isMultiVersion && (
          <Select value={currentVerId} onValueChange={setCurrentVerId}>
            <SelectTrigger className="h-8 w-[160px] text-sm">
              <div className="flex items-center">
                {(() => {
                  const idx = currentTask?.markdown.findIndex(v => v.ver_id === currentVerId)
                  return idx !== -1 ? `版本（${currentVerId.slice(-6)}）` : ''
                })()}
              </div>
            </SelectTrigger>

            <SelectContent>
              {(currentTask?.markdown || []).map((v, idx) => {
                const shortId = v.ver_id.slice(-6)
                return (
                  <SelectItem key={v.ver_id} value={v.ver_id}>
                    {`版本（${shortId}）`}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        )}

        <Badge variant="secondary" className="bg-pink-100 text-pink-700 hover:bg-pink-200">
          {modelName}
        </Badge>
        <Badge variant="secondary" className="bg-cyan-100 text-cyan-700 hover:bg-cyan-200">
          {styleName}
        </Badge>

        {createAt && (
          <div className="text-muted-foreground hidden text-sm md:block">
            创建时间: {formatDate(createAt)}
          </div>
        )}
      </div>

      {/* 右侧操作按钮 */}
      <div className="flex items-center gap-1">
        {/* 视图切换：Markdown 笔记 / 思维导图 二选一，当前视图用蓝底高亮 */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={showMarkdown}
                variant={markdownActive ? 'default' : 'ghost'}
                size="sm"
                className="h-8 px-2"
                aria-pressed={markdownActive}
              >
                <FileText className="h-4 w-4 sm:mr-1.5" />
                <span className="hidden text-sm sm:inline">Markdown</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Markdown 笔记</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() => setViewMode('map')}
                variant={viewMode === 'map' ? 'default' : 'ghost'}
                size="sm"
                className="h-8 px-2"
                aria-pressed={viewMode === 'map'}
              >
                <BrainCircuit className="h-4 w-4 sm:mr-1.5" />
                <span className="hidden text-sm sm:inline">思维导图</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>思维导图</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button onClick={handleCopy} variant="ghost" size="sm" className="h-8 px-2">
                <Copy className="h-4 w-4 sm:mr-1.5" />
                <span className="hidden text-sm sm:inline">{copied ? '已复制' : '复制'}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>复制内容</TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button onClick={onDownload} variant="ghost" size="sm" className="h-8 px-2">
                <Download className="h-4 w-4 sm:mr-1.5" />
                <span className="hidden text-sm sm:inline">导出 Markdown</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>下载为 Markdown 文件</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={toggleTranscribe}
                variant={transcriptActive ? 'default' : 'ghost'}
                size="sm"
                className="h-8 px-2"
                aria-pressed={transcriptActive}
              >
                <ScrollText className="h-4 w-4 sm:mr-1.5" />
                <span className="hidden text-sm sm:inline">原文参照</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>原文参照</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {setShowChat && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={toggleChat}
                  variant={chatActive ? 'default' : 'ghost'}
                  size="sm"
                  className="h-8 px-2"
                  aria-pressed={chatActive}
                >
                  <MessageSquare className="h-4 w-4 sm:mr-1.5" />
                  <span className="hidden text-sm sm:inline">AI 问答</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>基于笔记内容的 AI 问答</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </div>
  )
}
