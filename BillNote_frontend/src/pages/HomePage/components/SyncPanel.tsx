import { FC, useState } from 'react'
import { CloudDownload, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import { useSyncStore } from '@/store/syncStore'

const formatTime = (iso: string) => {
  if (!iso) return '还没有同步过'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '还没有同步过'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 生成历史标题旁的同步入口：绑定用户 ID 后多设备共用同一份笔记 */
const SyncPanel: FC = () => {
  const userId = useSyncStore(state => state.userId)
  const syncing = useSyncStore(state => state.syncing)
  const lastSyncAt = useSyncStore(state => state.lastSyncAt)
  const lastError = useSyncStore(state => state.lastError)
  const bind = useSyncStore(state => state.bind)
  const unbind = useSyncStore(state => state.unbind)
  const syncNow = useSyncStore(state => state.syncNow)

  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const bound = Boolean(userId)

  const handleBind = async () => {
    const result = await bind(draft)
    if (result.ok) {
      toast.success(result.message)
      setOpen(false)
    } else {
      toast.error(result.message)
    }
  }

  const handleSync = async () => {
    const result = await syncNow()
    if (result.ok) {
      toast.success(result.message)
    } else if (result.message !== '正在同步中') {
      toast.error(result.message)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDraft(userId)
          setOpen(true)
        }}
        title={bound ? `已绑定：${userId}` : '绑定用户 ID，多设备同步'}
        className={`flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
          bound
            ? 'border-primary/30 bg-primary/5 text-primary'
            : 'text-neutral-500 hover:text-primary border-neutral-200'
        }`}
      >
        {syncing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : bound ? (
          <ShieldCheck className="h-3.5 w-3.5" />
        ) : (
          <CloudDownload className="h-3.5 w-3.5" />
        )}
        <span>{bound ? userId : '同步'}</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[92vw] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>笔记同步</DialogTitle>
            <DialogDescription>
              {bound
                ? '已开启同步，手机和电脑上会自动保持一致。'
                : '输入一个用户 ID，就能在手机、电脑等设备上看到同一份生成历史。'}
            </DialogDescription>
          </DialogHeader>

          {bound ? (
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2">
                <span className="text-neutral-500">当前用户</span>
                <span className="font-medium">{userId}</span>
              </div>
              <div className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2">
                <span className="text-neutral-500">上次同步</span>
                <span>{syncing ? '同步中…' : formatTime(lastSyncAt)}</span>
              </div>
              {lastError && <p className="text-xs text-red-500">{lastError}</p>}
              <p className="text-muted-foreground text-xs">
                退出同步只影响这台设备，本地笔记不会删除；已经同步到云端的内容也不会删除。
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <Input
                value={draft}
                autoFocus
                placeholder="输入用户 ID，例如 test1"
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void handleBind()
                }}
              />
              <p className="text-muted-foreground text-xs">
                第一次绑定会把本机的生成历史合并上传，之后每台设备用同一个 ID 就能看到同样的笔记。
              </p>
              {lastError && <p className="text-xs text-red-500">{lastError}</p>}
            </div>
          )}

          <DialogFooter>
            {bound ? (
              <>
                <Button variant="outline" onClick={() => unbind()} disabled={syncing}>
                  退出同步
                </Button>
                <Button onClick={handleSync} disabled={syncing}>
                  <RefreshCw className={syncing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                  {syncing ? '同步中…' : '立即同步'}
                </Button>
              </>
            ) : (
              <Button onClick={handleBind} disabled={syncing || !draft.trim()}>
                {syncing ? '同步中…' : '绑定并同步'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default SyncPanel
