"use client"

import { useTaskStore } from "@/store/taskStore"
import { useEffect, useState, useRef } from "react"
import { Play, Download } from "lucide-react"
import { cn } from "@/lib/utils"
import {ScrollArea} from "@/components/ui/scroll-area.tsx";
import { Button } from "@/components/ui/button"

interface Segment {
  start: number
  end: number
  text: string
  speaker?: string
}

interface Task {
  id: string
  audioMeta: {
    title: string
  }
  transcript?: {
    segments?: Segment[]
  }
}

const TranscriptViewer = () => {
  const tasks = useTaskStore((state) => state.tasks)
  const currentTaskId = useTaskStore((state) => state.currentTaskId)
  const task = tasks.find(t => t.id === currentTaskId)
  
  const [activeSegment, setActiveSegment] = useState<number | null>(null)
  const segmentRefs = useRef<(HTMLDivElement | null)[]>([])

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, "0")}`
  }

  const handleSegmentClick = (index: number) => {
    setActiveSegment(index)
  }

  const handleDownloadTranscript = () => {
    if (!task?.transcript?.segments) return
    
    const fullText = task.transcript.segments
      .map(s => `[${formatTime(s.start)}] ${s.text}`)
      .join('\n')
      
    const name = task.audioMeta?.title || 'transcript'
    const publishDate = (task.audioMeta as any)?.publish_date
      ? new Date((task.audioMeta as any).publish_date * 1000)
          .toISOString()
          .split('T')[0]
          .replace(/-/g, '')
      : ''
    const fileName = publishDate ? `${publishDate}_${name}_原文.txt` : `${name}_原文.txt`
    const blob = new Blob([fullText], { type: 'text/plain;charset=utf-8' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  return (
      <div className="transcript-viewer flex h-full w-full flex-col  rounded-md border bg-white p-4 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">转写结果</h2>
          {task?.transcript?.segments && task.transcript.segments.length > 0 && (
            <Button variant="ghost" size="sm" onClick={handleDownloadTranscript} className="h-8 px-2">
              <Download className="mr-1.5 h-4 w-4" />
              导出文本
            </Button>
          )}
        </div>
        {!task?.transcript?.segments?.length ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">暂无转写内容</div>
        ) : (
            <>


            <div className="mb-3 grid grid-cols-[80px_1fr] gap-2 border-b pb-2 text-xs font-medium text-muted-foreground">
                <div>时间</div>
                <div>内容</div>
              </div>
            <ScrollArea className="w-full overflow-y-auto">

              <div className="space-y-1">
                {task.transcript.segments.map((segment, index) => (
                    <div
                        key={index}
                        ref={(el) => (segmentRefs.current[index] = el)}
                        className={cn(
                            "group grid grid-cols-[80px_1fr] gap-2 rounded-md p-2 transition-colors hover:bg-slate-50",
                            activeSegment === index && "bg-slate-100",
                        )}
                        onClick={() => handleSegmentClick(index)}
                    >
                      <div className="flex items-center gap-1 text-xs text-slate-500">
                        <button
                            className="invisible rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 group-hover:visible"
                            onClick={(e) => {
                              e.stopPropagation()
                              // Add play functionality here
                            }}
                        >
                          {/*<Play className="h-3 w-3" />*/}
                        </button>
                        <span>{formatTime(segment.start)}</span>
                      </div>

                      <div className="text-sm leading-relaxed text-slate-700">
                        {segment.speaker && (
                            <span className="mr-2 rounded bg-slate-200 px-1.5 py-0.5 text-xs font-medium text-slate-700">
                      {segment.speaker}
                    </span>
                        )}
                        {segment.text}
                      </div>
                    </div>
                ))}
              </div>
            </ScrollArea>

            </>
        )}


        {task?.transcript?.segments?.length > 0 && (
            <div className="mt-4 flex justify-between border-t pt-3 text-xs text-slate-500">
              <span>共 {task.transcript.segments.length} 条片段</span>
              <span>总时长: {formatTime(task.transcript.segments[task.transcript.segments.length - 1]?.end || 0)}</span>
            </div>
        )}
      </div>
  )
}

export default TranscriptViewer
