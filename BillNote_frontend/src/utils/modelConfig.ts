/**
 * 笔记用哪个模型做 AI 问答 / 重新生成，统一在这里解析。
 *
 * 背景：同步到本机的笔记是从服务器「拼」出来的（见 taskStore.mergeRemoteEntries），
 * 服务器上只存了模型名，没有存供应商 id，所以这类笔记的 formData.provider_id 一直是空的。
 * 而 AI 问答必须同时拿到 provider_id 和 model_name，否则后端会报
 * 「未找到模型供应商」，前端只会弹一句「无法获取模型配置」。
 *
 * 所以这里做四级兜底，只要能查到就补上，查不到才返回 null：
 *   1. 任务自己的配置（本机生成的笔记走这条）
 *   2. 用模型名去已启用模型列表里反查供应商
 *   3. 用供应商去反查它的第一个模型（有供应商没模型名时）
 *   4. 全都失败就用模型列表的第一项（保证问答功能永远能用，而不是直接报错）
 */

/** 任务里和模型有关的那点信息，避免为了一个类型把整个 store 引进来 */
export interface TaskModelSource {
  formData?: {
    provider_id?: string
    model_name?: string
  } | null
}

/** 已启用模型列表（modelStore.modelList）里的一项 */
export interface ModelOption {
  id?: string | number
  provider_id?: string
  model_name?: string
}

export interface ResolvedModelConfig {
  providerId: string
  modelName: string
  /** 命中哪一级兜底，排查问题时用得上 */
  source: 'task' | 'model' | 'provider' | 'fallback'
}

export const resolveModelConfig = (
  task: TaskModelSource | null | undefined,
  modelList: ModelOption[] | null | undefined,
): ResolvedModelConfig | null => {
  const usable = (modelList || []).filter(m => m?.provider_id && m?.model_name)
  const providerId = (task?.formData?.provider_id || '').trim()
  const modelName = (task?.formData?.model_name || '').trim()

  if (providerId && modelName) {
    return { providerId, modelName, source: 'task' }
  }

  if (modelName) {
    const byName = usable.find(m => m.model_name === modelName)
    if (byName) {
      return { providerId: byName.provider_id as string, modelName, source: 'model' }
    }
  }

  if (providerId) {
    const byProvider = usable.find(m => m.provider_id === providerId)
    if (byProvider) {
      return {
        providerId,
        modelName: byProvider.model_name as string,
        source: 'provider',
      }
    }
  }

  const first = usable[0]
  if (first) {
    return {
      providerId: first.provider_id as string,
      modelName: first.model_name as string,
      source: 'fallback',
    }
  }

  return null
}

/**
 * 把兜底结果写回 formData，但只补空缺的字段。
 * 本机已经选好模型的笔记不能被同步来的旧配置覆盖掉。
 */
export const fillModelConfig = (
  formData: TaskModelSource['formData'],
  resolved: ResolvedModelConfig | null,
): TaskModelSource['formData'] => {
  if (!resolved) return formData
  const current = formData || {}
  if (current.provider_id && current.model_name) return current
  return {
    ...current,
    provider_id: current.provider_id || resolved.providerId,
    model_name: current.model_name || resolved.modelName,
  }
}
