import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { delete_task, generateNote, generateTextNote } from '@/services/note.ts'
import type { SyncEntry } from '@/services/sync.ts'
import { useModelStore } from '@/store/modelStore'
import { fillModelConfig, resolveModelConfig } from '@/utils/modelConfig'
import { resolveVideoUrl } from '@/utils/videoSource'
import { v4 as uuidv4 } from 'uuid'
import toast from 'react-hot-toast'
import { get, set, del } from 'idb-keyval'


/** 后端 TaskStatus 枚举的阶段，外加历史数据里出现过的 RUNNING / FAILD 写法 */
export type TaskStatus =
  | 'PENDING'
  | 'PARSING'
  | 'DOWNLOADING'
  | 'TRANSCRIBING'
  | 'SUMMARIZING'
  | 'FORMATTING'
  | 'SAVING'
  | 'SUCCESS'
  | 'FAILED'
  | 'RUNNING'
  | 'FAILD'

/** 阶段中文名，用于在页面上说明卡在哪一环 */
export const taskPhaseLabels: Record<string, string> = {
  PENDING: '排队中',
  PARSING: '解析链接',
  DOWNLOADING: '下载音频',
  TRANSCRIBING: '转写文字',
  SUMMARIZING: '总结内容',
  FORMATTING: '格式化',
  SAVING: '保存',
  SUCCESS: '完成',
  FAILED: '失败',
}

export interface AudioMeta {
  cover_url: string
  duration: number
  file_path: string
  platform: string
  raw_info: any
  title: string
  video_id: string
  publish_date?: number
}

export interface Segment {
  start: number
  end: number
  text: string
}

export interface Transcript {
  full_text: string
  language: string
  raw: any
  segments: Segment[]
}
export interface Markdown {
  ver_id: string
  content: string
  style: string
  model_name: string
  created_at: string
}

export interface Task {
  id: string
  markdown: string|Markdown [] //为了兼容之前的笔记
  transcript: Transcript
  status: TaskStatus
  audioMeta: AudioMeta
  platform: string
  createdAt: string
  /** 失败原因，后端返回的原始报错 */
  message?: string
  /** 失败发生的阶段，如 DOWNLOADING */
  phase?: string
  /** 失败阶段的中文描述，如「下载音频」 */
  phaseDesc?: string
  formData: {
    video_url: string
    link: undefined | boolean
    screenshot: undefined | boolean
    platform: string
    quality: string
    model_name: string
    provider_id: string
    style?: string
    extras?: string
    format?: string[]
    mode?: string
    text_content?: string
    title?: string
    transcript_only?: boolean
  }
}

/** 把任务上的失败信息整理成页面要展示的文案 */
export const taskFailureText = (task?: Task | null) => {
  const message = (task?.message || '').trim()
  const phaseDesc = task?.phaseDesc || (task?.phase ? taskPhaseLabels[task.phase] : '') || ''
  return {
    phaseDesc,
    title: phaseDesc ? `笔记生成失败（${phaseDesc}）` : '笔记生成失败',
    message,
  }
}

/** 一条任务里的全部版本；老数据的 markdown 是纯字符串，统一成版本数组 */
export const taskVersions = (task: Task): Markdown[] => {
  const markdown = task.markdown
  if (Array.isArray(markdown)) return markdown.filter(v => v && (v.content || v.ver_id))
  if (!markdown) return []
  return [
    {
      ver_id: `${task.id}-legacy`,
      content: markdown,
      style: task.formData?.style || '',
      model_name: task.formData?.model_name || '',
      created_at: task.createdAt,
    },
  ]
}

/** 版本列表合并：按 ver_id 去重，按生成时间倒序 */
const mergeVersions = (base: Markdown[], extra: Markdown[]): Markdown[] => {
  const map = new Map<string, Markdown>()
  // 同一份正文可能在不同设备上用不同的 ver_id 存过，只保留一条
  const contents = new Set<string>()
  const contentKeys = new Map<string, string>()

  const put = (version: Markdown, keepDuplicateContent: boolean) => {
    if (!version) return
    const content = (version.content || '').trim()
    const key = version.ver_id || `${version.created_at}-${content.length}`
    if (content) {
      if (contents.has(content) && !keepDuplicateContent) {
        // 同内容的版本改用服务器那份的 ver_id，下次同步就不会再重复传一遍
        const existingKey = contentKeys.get(content)
        const existing = existingKey ? map.get(existingKey) : undefined
        if (existing && existingKey !== key && !map.has(key)) {
          map.delete(existingKey)
          map.set(key, {
            ...existing,
            ver_id: version.ver_id || existing.ver_id,
            style: existing.style || version.style,
            model_name: existing.model_name || version.model_name,
          })
          contentKeys.set(content, key)
        }
        return
      }
      contents.add(content)
      contentKeys.set(content, key)
    }
    const previous = map.get(key)
    if (!previous) {
      map.set(key, version)
      return
    }
    map.set(key, {
      ...previous,
      ...version,
      content: version.content || previous.content,
      created_at: version.created_at || previous.created_at,
    })
  }

  base.forEach(version => put(version, true))
  extra.forEach(version => put(version, false))
  return [...map.values()].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
}

/** 本地任务和服务器条目是不是同一条笔记：优先看视频ID，其次看任务ID */
const matchesEntry = (task: Task, entry: SyncEntry) => {
  const videoId = task.audioMeta?.video_id
  if (videoId && entry.video_id) return videoId === entry.video_id
  return (entry.task_ids || []).includes(task.id)
}

interface TaskStore {
  tasks: Task[]
  currentTaskId: string | null
  /** 每次从列表里点选笔记都会 +1，移动端用它来切到「笔记」页签 */
  selectionTick: number
  addPendingTask: (taskId: string, platform: string, formData?: any) => void
  updateTaskContent: (id: string, data: Partial<Omit<Task, 'id' | 'createdAt'>>) => void
  mergeRemoteEntries: (entries: SyncEntry[]) => number
  removeTask: (id: string) => void
  clearTasks: () => void
  setCurrentTask: (taskId: string | null) => void
  getCurrentTask: () => Task | null
  retryTask: (id: string) => void
}

export const useTaskStore = create<TaskStore>()(
  persist(
    (set, get) => ({
      tasks: [],
      currentTaskId: null,
      selectionTick: 0,

      addPendingTask: (taskId: string, platform: string, formData: any) =>

        set(state => ({
          tasks: [
            {
              formData: formData,
              id: taskId,
              status: 'PENDING',
              markdown: '',
              platform: platform,
              transcript: {
                full_text: '',
                language: '',
                raw: null,
                segments: [],
              },
              createdAt: new Date().toISOString(),
              audioMeta: {
                cover_url: '',
                duration: 0,
                file_path: '',
                platform: '',
                raw_info: null,
                title: '',
                video_id: '',
              },
            },
            ...state.tasks,
          ],
          currentTaskId: taskId, // 默认设置为当前任务
        })),

      updateTaskContent: (id, data) =>
          set(state => ({
            tasks: state.tasks.map(task => {
              if (task.id !== id) return task

              if (task.status === 'SUCCESS' && data.status === 'SUCCESS') return task

              // 如果是 markdown 字符串，封装为版本
              if (typeof data.markdown === 'string') {
                const prev = task.markdown
                const newVersion: Markdown = {
                  ver_id: `${task.id}-${uuidv4()}`,
                  content: data.markdown,
                  style: task.formData.style || '',
                  model_name: task.formData.model_name || '',
                  created_at: new Date().toISOString(),
                }

                let updatedMarkdown: Markdown[]
                if (Array.isArray(prev)) {
                  updatedMarkdown = [newVersion, ...prev]
                } else {
                  updatedMarkdown = [
                    newVersion,
                    ...(typeof prev === 'string' && prev
                        ? [{
                          ver_id: `${task.id}-${uuidv4()}`,
                          content: prev,
                          style: task.formData.style || '',
                          model_name: task.formData.model_name || '',
                          created_at: new Date().toISOString(),
                        }]
                        : []),
                  ]
                }

                return {
                  ...task,
                  ...data,
                  markdown: updatedMarkdown,
                }
              }

              return { ...task, ...data }
            }),
          })),


      mergeRemoteEntries: entries => {
        if (!entries?.length) return 0
        let added = 0

        set(state => {
          // 服务器上只存了模型名，没存供应商；用已启用模型列表把配置补齐
          const modelList = useModelStore.getState().modelList
          const tasks = [...state.tasks]
          // 服务器上新出现、本机没有的笔记
          const created: Task[] = []
          // 同一个视频在本机被生成过多次时，合并成一个任务后要清掉多余的那几个
          const dropped = new Set<string>()
          let currentTaskId = state.currentTaskId

          for (const entry of entries) {
            const remote = entry.versions || []
            const incoming: Markdown[] = remote.map(version => ({
              ver_id: version.ver_id || version.task_id,
              content: version.content || '',
              style: version.style || '',
              model_name: version.model_name || '',
              created_at: version.created_at || '',
            }))
            const meta = (remote[0]?.audio_meta || {}) as Partial<AudioMeta>
            const transcript: Transcript | undefined = remote[0]?.transcript?.full_text
              ? remote[0].transcript
              : undefined

            const matched: number[] = []
            tasks.forEach((task, index) => {
              if (!dropped.has(task.id) && matchesEntry(task, entry)) matched.push(index)
            })

            if (!matched.length) {
              if (!incoming.length) continue
              const newest = incoming[0]
              const resolved = resolveModelConfig(
                { formData: { provider_id: '', model_name: newest.model_name } },
                modelList,
              )
              const videoUrl = resolveVideoUrl({
                platform: entry.platform,
                videoId: entry.video_id,
                rawInfo: meta.raw_info as Record<string, unknown> | null,
              })
              created.push({
                id: entry.task_ids?.[0] || newest.ver_id,
                markdown: incoming,
                transcript: transcript || { full_text: '', language: '', raw: null, segments: [] },
                status: 'SUCCESS',
                audioMeta: {
                  cover_url: meta.cover_url || '',
                  duration: meta.duration || 0,
                  file_path: meta.file_path || '',
                  platform: entry.platform,
                  raw_info: meta.raw_info ?? null,
                  title: entry.title || meta.title || '',
                  video_id: entry.video_id,
                  publish_date: entry.publish_date ?? meta.publish_date,
                },
                platform: entry.platform,
                createdAt: entry.created_at || newest.created_at || new Date().toISOString(),
                formData: {
                  video_url: videoUrl,
                  link: undefined,
                  screenshot: undefined,
                  platform: entry.platform,
                  quality: '',
                  // 优先用兜底出来的配置，保证同步来的笔记也能直接用 AI 问答
                  model_name: resolved?.modelName || newest.model_name || '',
                  provider_id: resolved?.providerId || '',
                  style: newest.style || '',
                },
              })
              added += 1
              continue
            }

            const primary = tasks[matched[0]]
            // 正在生成的任务先不碰，等生成结束再合并
            if (primary.status !== 'SUCCESS' && primary.status !== 'FAILED') continue

            const merged = mergeVersions(
              matched.flatMap(index => taskVersions(tasks[index])),
              incoming
            )
            // 同步来的笔记（或者本机早期版本）formData 里没链接，按平台+视频 ID 补一条，
            // 否则表单必填校验过不去，点「重新生成」是没反应的
            const mergedVideoUrl = resolveVideoUrl({
              platform: entry.platform || primary.platform,
              videoId: entry.video_id || primary.audioMeta.video_id,
              rawInfo: (meta.raw_info || primary.audioMeta.raw_info) as Record<string, unknown> | null,
              fallback: primary.formData.video_url,
            })
            tasks[matched[0]] = {
              ...primary,
              markdown: merged,
              status: 'SUCCESS',
              platform: entry.platform || primary.platform,
              createdAt: entry.created_at || primary.createdAt,
              // 本机这条笔记要是缺模型配置（比如它本身就是同步来的），一并补上
              formData: {
                ...(fillModelConfig(
                  primary.formData,
                  resolveModelConfig(primary, modelList),
                ) as Task['formData']),
                video_url: mergedVideoUrl,
              },
              transcript: transcript || primary.transcript,
              audioMeta: {
                ...primary.audioMeta,
                ...meta,
                platform: entry.platform || primary.platform,
                video_id: entry.video_id || primary.audioMeta.video_id,
                title: entry.title || primary.audioMeta.title || meta.title || '',
                publish_date: entry.publish_date ?? primary.audioMeta.publish_date,
              },
            }
            for (const index of matched.slice(1)) {
              dropped.add(tasks[index].id)
              if (currentTaskId === tasks[index].id) currentTaskId = primary.id
            }
          }

          const next = [...created, ...tasks.filter(task => !dropped.has(task.id))]
          next.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
          return { tasks: next, currentTaskId }
        })

        return added
      },

      getCurrentTask: () => {
        const currentTaskId = get().currentTaskId
        return get().tasks.find(task => task.id === currentTaskId) || null
      },
      retryTask: async (id: string, payload?: any) => {

        if (!id){
          toast.error('任务不存在')
          return
        }
        const task = get().tasks.find(task => task.id === id)
        console.log('retry',task)
        if (!task) return

        const newFormData = payload || task.formData
        // 同步来的笔记 formData 里没有供应商，重新生成前用同一套兜底补上
        let modelList = useModelStore.getState().modelList
        if (!modelList.length) {
          await useModelStore.getState().loadEnabledModels()
          modelList = useModelStore.getState().modelList
        }
        const resolved = resolveModelConfig({ formData: newFormData }, modelList)
        const modelName = resolved?.modelName || ''
        const providerId = resolved?.providerId || ''
        // 以 mode / platform 判定文本任务，避免残留 text_content 导致视频任务被误判为文本整理
        const isText = newFormData?.mode === 'text' || newFormData?.platform === 'text'
        if (isText) {
          await generateTextNote({
            text_content: newFormData.text_content,
            title: newFormData.title,
            model_name: modelName,
            provider_id: providerId,
            style: newFormData.style,
            extras: newFormData.extras,
            task_id: id,
            transcript_only: newFormData.transcript_only,
          })
        } else {
          await generateNote({
            ...newFormData,
            model_name: modelName,
            provider_id: providerId,
            task_id: id,
          })
        }

        set(state => ({
          tasks: state.tasks.map(t =>
              t.id === id
                  ? {
                    ...t,
                    formData: newFormData, // ✅ 显式更新 formData
                    status: 'PENDING',
                    // 清掉上一次的失败信息，避免重试时旧报错还留在页面上
                    message: undefined,
                    phase: undefined,
                    phaseDesc: undefined,
                  }
                  : t
          ),
        }))
      },


      removeTask: async id => {
        const task = get().tasks.find(t => t.id === id)

        // 更新 Zustand 状态
        set(state => ({
          tasks: state.tasks.filter(task => task.id !== id),
          currentTaskId: state.currentTaskId === id ? null : state.currentTaskId,
        }))

        if (!task) return

        // 绑定了用户 ID：连服务器上的所有版本和素材一起删
        const { useSyncStore } = await import('@/store/syncStore')
        const syncStore = useSyncStore.getState()
        if (syncStore.userId) {
          await syncStore.deleteRemote(task)
          toast.success('笔记已删除')
          return
        }

        // 没绑定时保持原来的行为
        await delete_task({
          video_id: task.audioMeta.video_id,
          platform: task.platform,
        })
      },

      clearTasks: () => set({ tasks: [], currentTaskId: null }),

      setCurrentTask: taskId =>
        set(state => ({
          currentTaskId: taskId,
          selectionTick: taskId ? state.selectionTick + 1 : state.selectionTick,
        })),
    }),
    {
      name: 'task-storage',
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
