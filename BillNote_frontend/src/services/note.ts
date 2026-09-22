import request from '@/utils/request'
import toast from 'react-hot-toast'

export const generateNote = async (data: {
  video_url: string
  platform: string
  quality: string
  model_name: string
  provider_id: string
  task_id?: string
  format: Array<string>
  style: string
  extras?: string
  video_understand?: boolean
  video_interval?: number
  grid_size: Array<number>
  transcript_only?: boolean
}) => {
  try {
    console.log('generateNote', data)
    const response = await request.post('/generate_note', data)

    if (!response) {
      if (response.data.msg) {
        toast.error(response.data.msg)
      }
      return null
    }
    toast.success('笔记生成任务已提交！')

    console.log('res', response)
    // 成功提示

    return response
  } catch (e: any) {
    console.error('❌ 请求出错', e)

    // 错误提示
    // toast.error('笔记生成失败，请稍后重试')

    throw e // 抛出错误以便调用方处理
  }
}

export const generateTextNote = async (data: {
  text_content: string
  title?: string
  model_name: string
  provider_id: string
  style?: string
  extras?: string
  task_id?: string
  transcript_only?: boolean
}) => {
  try {
    console.log('generateTextNote', data)
    const response = await request.post('/generate_text_note', data)

    if (!response) {
      toast.error(response?.data?.msg || '提交失败')
      return null
    }
    toast.success('文本整理任务已提交！')

    console.log('res', response)
    return response
  } catch (e: any) {
    console.error('❌ 请求出错', e)
    throw e // 抛出错误以便调用方处理
  }
}

export const delete_task = async ({ video_id, platform }) => {
  try {
    const data = {
      video_id,
      platform,
    }
    const res = await request.post('/delete_task', data)


      toast.success('任务已成功删除')
      return res
  } catch (e) {
    toast.error('请求异常，删除任务失败')
    console.error('❌ 删除任务失败:', e)
    throw e
  }
}

export interface TaskStatusResponse {
  status: string
  message?: string
  /** 失败发生的阶段，如 DOWNLOADING */
  phase?: string
  /** 失败阶段的中文描述，如「下载音频」 */
  phase_desc?: string
  task_id?: string
  result?: { markdown: any, transcript: any, audio_meta: any }
}

export const get_task_status = async (task_id: string) => {
  // 轮询接口：失败原因由调用方展示在页面上，这里不弹 toast，避免每次轮询都刷屏
  return await request.get<TaskStatusResponse, TaskStatusResponse>('/task_status/' + task_id, {
    skipErrorToast: true,
  })
}
