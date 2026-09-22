import request from '@/utils/request'

/** 服务器上的一个笔记版本 */
export interface SyncVersion {
  ver_id?: string
  task_id: string
  created_at?: string
  style?: string
  model_name?: string
  content?: string
  transcript?: any
  audio_meta?: any
}

/** 服务器上的一条笔记（同一视频的多个版本挂在一条下面） */
export interface SyncEntry {
  platform: string
  video_id: string
  title?: string
  created_at?: string
  publish_date?: number
  task_ids?: string[]
  versions?: SyncVersion[]
}

/** 上传时一条笔记只带需要新增的版本 */
export interface SyncUploadEntry {
  platform: string
  video_id: string
  title?: string
  created_at?: string
  publish_date?: number
  versions: SyncVersion[]
}

// 首次同步可能要传十几 MB 的历史内容，单独放宽超时（默认只有 10 秒）
const LONG_TIMEOUT = 180000

export const pullNotes = (user_id: string, have: string[]): Promise<{ entries: SyncEntry[] }> =>
  request.post('/sync/pull', { user_id, have }, { timeout: LONG_TIMEOUT })

export const uploadNotes = (
  user_id: string,
  entries: SyncUploadEntry[]
): Promise<{ entries: SyncEntry[] }> =>
  request.post('/sync/upload', { user_id, entries }, { timeout: LONG_TIMEOUT })

export const deleteNote = (
  user_id: string,
  platform: string,
  video_id: string,
  task_ids: string[]
): Promise<{ task_ids: string[]; deleted_files: number }> =>
  request.post('/sync/delete', { user_id, platform, video_id, task_ids }, { timeout: LONG_TIMEOUT })
