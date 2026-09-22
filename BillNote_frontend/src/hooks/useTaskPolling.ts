import { useEffect, useRef } from 'react'
import { useTaskStore } from '@/store/taskStore'
import { get_task_status } from '@/services/note.ts'
import { useSyncStore } from '@/store/syncStore'
import toast from 'react-hot-toast'

/** 连续多少次轮询失败才提示「暂时无法获取状态」；这期间任务状态保持不变 */
const MAX_POLL_FAILURES = 3

export const useTaskPolling = (interval = 3000) => {
  const tasks = useTaskStore(state => state.tasks)
  const updateTaskContent = useTaskStore(state => state.updateTaskContent)

  const tasksRef = useRef(tasks)

  /** 本次会话里后端已经明确给出终态（SUCCESS / FAILED）的任务，不再重复查询 */
  const settledRef = useRef<Set<string>>(new Set())
  /** 每个任务连续轮询失败次数，成功响应一次就清零 */
  const failuresRef = useRef<Map<string, number>>(new Map())
  /** 已经提示过网络异常的任务，恢复正常前不再重复弹 */
  const warnedRef = useRef<Set<string>>(new Set())

  // 每次 tasks 更新，把最新的 tasks 同步进去
  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])

  useEffect(() => {
    const timer = setInterval(async () => {
      const pendingTasks = tasksRef.current.filter(task => {
        if (task.status === 'SUCCESS') return false
        // FAILED 只是本地记录：可能是持久化下来的旧结果，后端其实还在跑；
        // 只要本次会话还没从后端确认过终态，就再查一次，让页面能自己纠正回来
        if (task.status === 'FAILED') return !settledRef.current.has(task.id)
        return true
      })

      // 无活跃任务时跳过轮询
      if (pendingTasks.length === 0) return

      for (const task of pendingTasks) {
        try {
          const res = await get_task_status(task.id)
          const { status } = res

          failuresRef.current.set(task.id, 0)
          warnedRef.current.delete(task.id)

          if (status === 'SUCCESS' || status === 'FAILED') settledRef.current.add(task.id)

          if (status && status !== task.status) {
            if (status === 'SUCCESS') {
              const { markdown, transcript, audio_meta } = res.result
              toast.success('笔记生成成功')
              updateTaskContent(task.id, {
                status,
                markdown,
                transcript,
                audioMeta: audio_meta,
              })
              // 生成完成后自动同步一次，其他设备马上能看到
              void useSyncStore.getState().syncNow()
            } else if (status === 'FAILED') {
              // 后端明确返回失败，才把任务标记为失败
              updateTaskContent(task.id, {
                status,
                message: res.message,
                phase: res.phase,
                phaseDesc: res.phase_desc,
              })
              console.warn(`⚠️ 任务 ${task.id} 失败：${res.message || ''}`)
            } else {
              // 本地记的是 FAILED，后端其实还在跑或还在排队：以后端为准恢复显示
              updateTaskContent(task.id, { status })
            }
          }
        } catch (e) {
          // 后端返回失败时是 {code:500, msg, data:{status:'FAILED', phase, phase_desc}}，
          // 被 axios 拦截器 reject；网络不通则是 {code:-1, data:null}
          const err = e as
            | {
                code?: number
                msg?: string
                data?: { status?: string, phase?: string, phase_desc?: string } | null
              }
            | undefined

          if (err?.data?.status === 'FAILED') {
            // 只有后端明确说失败，才写 FAILED
            settledRef.current.add(task.id)
            failuresRef.current.delete(task.id)
            updateTaskContent(task.id, {
              status: 'FAILED',
              message: err?.msg,
              phase: err?.data?.phase,
              phaseDesc: err?.data?.phase_desc,
            })
            console.warn(`⚠️ 任务 ${task.id} 失败：${err?.msg || ''}`)
            continue
          }

          // 网络抖动 / 网关 502 / 后端重启中：任务在后端可能还在跑，
          // 保持原状态并计数重试，绝不能因为一次请求失败就把任务标成失败
          const failures = (failuresRef.current.get(task.id) || 0) + 1
          failuresRef.current.set(task.id, failures)
          console.warn(
            `⚠️ 任务 ${task.id} 暂时无法获取状态（第 ${failures} 次）：`,
            err?.msg || e
          )

          if (failures >= MAX_POLL_FAILURES && !warnedRef.current.has(task.id)) {
            warnedRef.current.add(task.id)
            toast.error('暂时无法获取任务状态，正在自动重试…')
          }
        }
      }
    }, interval)

    return () => clearInterval(timer)
  }, [interval])
}
