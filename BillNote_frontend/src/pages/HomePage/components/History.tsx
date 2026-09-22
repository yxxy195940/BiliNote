import NoteHistory from '@/pages/HomePage/components/NoteHistory.tsx'
import SyncPanel from '@/pages/HomePage/components/SyncPanel.tsx'
import { useTaskStore } from '@/store/taskStore'
import { Info, Clock, Loader2 } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area.tsx'
import { useIsMobile } from '@/hooks/useIsMobile.ts'
const History = () => {
  const currentTaskId = useTaskStore(state => state.currentTaskId)
  const setCurrentTask = useTaskStore(state => state.setCurrentTask)
  const isMobile = useIsMobile()
  return (
    <>
      <div className={`w-full flex-col gap-4 px-2.5 py-1.5 ${isMobile ? 'flex' : 'flex h-full'}`}>
        {/*生成历史    */}
        <div className="my-4 flex h-[40px] items-center justify-between gap-2 max-md:my-2">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-neutral-500" />
            <h2 className="text-base font-medium text-neutral-900">生成历史</h2>
          </div>
          <SyncPanel />
        </div>
        <ScrollArea className="w-full max-md:min-h-0 max-md:flex-1 sm:h-[480px] md:h-[720px] lg:h-[92%]">
          {/*<div className="w-full flex-1 overflow-y-auto">*/}
          <NoteHistory onSelect={setCurrentTask} selectedId={currentTaskId} />
          {/*</div>*/}
        </ScrollArea>
      </div>
    </>
  )
}

export default History
