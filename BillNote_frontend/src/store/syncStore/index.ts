import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { get, set, del } from 'idb-keyval'
import { taskVersions, useTaskStore, type Task } from '@/store/taskStore'
import { useModelStore } from '@/store/modelStore'
import { deleteNote, pullNotes, uploadNotes, type SyncUploadEntry } from '@/services/sync'

/** 一次上传几条笔记，避免单个请求过大 */
const PUSH_BATCH = 5

/** 版本在服务器上的唯一标识 */
const versionKey = (version: { ver_id?: string; task_id?: string }) =>
  version.ver_id || version.task_id || ''

const toUploadEntry = (task: Task): SyncUploadEntry => {
  const meta = task.audioMeta || ({} as Task['audioMeta'])
  return {
    platform: task.platform || meta.platform || '',
    // 老任务可能没有视频ID，用任务ID兜底，保证在服务器上有稳定的身份
    video_id: meta.video_id || task.id,
    title: meta.title || '',
    created_at: task.createdAt,
    publish_date: meta.publish_date,
    versions: taskVersions(task).map(version => ({
      ver_id: version.ver_id,
      task_id: task.id,
      created_at: version.created_at || task.createdAt,
      style: version.style || '',
      model_name: version.model_name || '',
      content: version.content,
      transcript: task.transcript,
      audio_meta: meta,
    })),
  }
}

export interface SyncOutcome {
  ok: boolean
  added: number
  uploaded: number
  message: string
}

interface SyncStore {
  /** 绑定的用户 ID，空字符串表示这台设备没有开启同步 */
  userId: string
  syncing: boolean
  lastSyncAt: string
  lastError: string
  /** 已经确认存在于服务器上的版本，用来避免重复上传 */
  pushedUserId: string
  pushedVersionIds: string[]
  bind: (userId: string) => Promise<SyncOutcome>
  unbind: () => void
  syncNow: () => Promise<SyncOutcome>
  deleteRemote: (task: Task) => Promise<void>
}

export const useSyncStore = create<SyncStore>()(
  persist(
    (set, get) => ({
      userId: '',
      syncing: false,
      lastSyncAt: '',
      lastError: '',
      pushedUserId: '',
      pushedVersionIds: [],

      bind: async userId => {
        const name = userId.trim()
        if (!name) {
          return { ok: false, added: 0, uploaded: 0, message: '请输入用户 ID' }
        }
        // 换用户时重新计算已上传的版本，避免把新用户当成旧用户
        set({ userId: name, pushedUserId: name, pushedVersionIds: [], lastError: '' })
        return get().syncNow()
      },

      unbind: () => set({ userId: '', pushedVersionIds: [], pushedUserId: '', lastError: '' }),

      syncNow: async () => {
        const { userId, syncing } = get()
        if (!userId) return { ok: false, added: 0, uploaded: 0, message: '未绑定用户 ID' }
        if (syncing) return { ok: false, added: 0, uploaded: 0, message: '正在同步中' }
        set({ syncing: true, lastError: '' })

        try {
          const pushed =
            get().pushedUserId === userId ? new Set(get().pushedVersionIds) : new Set<string>()
          const tasks = useTaskStore.getState().tasks

          // 1）只把服务器上还没有的版本推上去
          const pending: SyncUploadEntry[] = []
          for (const task of tasks) {
            const entry = toUploadEntry(task)
            const versions = entry.versions.filter(v => !pushed.has(versionKey(v)))
            if (!versions.length) continue
            pending.push({ ...entry, versions })
          }

          let uploaded = 0
          for (let start = 0; start < pending.length; start += PUSH_BATCH) {
            const batch = pending.slice(start, start + PUSH_BATCH)
            await uploadNotes(userId, batch)
            batch.forEach(entry => entry.versions.forEach(v => pushed.add(versionKey(v))))
            uploaded += batch.reduce((sum, entry) => sum + entry.versions.length, 0)
          }

          // 2）把服务器上的内容拉下来（本地已有一模一样的版本时服务器只回元信息）
          const known = new Set<string>()
          useTaskStore
            .getState()
            .tasks.forEach(task => taskVersions(task).forEach(v => known.add(v.ver_id)))
          const data = await pullNotes(userId, [...known])
          const entries = data?.entries || []
          // 服务器上只存模型名，合并时要用已启用模型列表反查供应商，先保证它已加载
          if (!useModelStore.getState().modelList.length) {
            await useModelStore.getState().loadEnabledModels()
          }
          const added = useTaskStore.getState().mergeRemoteEntries(entries)
          entries.forEach(entry =>
            (entry.versions || []).forEach(v => pushed.add(v.ver_id || v.task_id))
          )

          set({
            pushedUserId: userId,
            pushedVersionIds: [...pushed],
            lastSyncAt: new Date().toISOString(),
            lastError: '',
          })
          return { ok: true, added, uploaded, message: `同步完成（新增 ${added} 条）` }
        } catch (e: any) {
          const message = e?.msg || e?.message || '同步失败，请稍后再试'
          set({ lastError: message })
          return { ok: false, added: 0, uploaded: 0, message }
        } finally {
          set({ syncing: false })
        }
      },

      deleteRemote: async task => {
        const userId = get().userId
        if (!userId || !task) return
        try {
          const versionIds = taskVersions(task)
            .map(v => v.ver_id)
            .filter(Boolean)
          await deleteNote(userId, task.platform, task.audioMeta?.video_id || task.id, [
            task.id,
            ...versionIds,
          ])
        } catch (e) {
          console.error('删除云端笔记失败:', e)
        }
      },
    }),
    {
      name: 'sync-storage',
      storage: createJSONStorage(() => ({
        getItem: async (name: string): Promise<string | null> => {
          const value = await get(name)
          return value ?? null
        },
        setItem: async (name: string, value: string): Promise<void> => {
          await set(name, value)
        },
        removeItem: async (name: string): Promise<void> => {
          await del(name)
        },
      })),
    }
  )
)
