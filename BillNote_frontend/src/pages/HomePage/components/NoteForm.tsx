/* NoteForm.tsx ---------------------------------------------------- */
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from '@/components/ui/form.tsx'
import { useEffect,useState } from 'react'
import type { ClipboardEvent } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

import { Loader2, Plus } from 'lucide-react'
import { generateNote } from '@/services/note.ts'
import { uploadFile } from '@/services/upload.ts'
import { useTaskStore } from '@/store/taskStore'
import { useModelStore } from '@/store/modelStore'
import { resolveModelConfig } from '@/utils/modelConfig'
import InfoTip from '@/components/InfoTip.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { ScrollArea } from '@/components/ui/scroll-area.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { noteStyles, noteFormats, videoPlatforms } from '@/constant/note.ts'
import { fetchModels } from '@/services/model.ts'
import { useNavigate } from 'react-router-dom'
import { parseVideoInput } from '@/utils/videoUrl.ts'
import type { ParsedVideoInput } from '@/utils/videoUrl.ts'
import { resolveVideoUrl } from '@/utils/videoSource.ts'
import toast from 'react-hot-toast'

/* -------------------- 校验 Schema -------------------- */
const formSchema = z
  .object({
    video_url: z.string().optional(),
    platform: z.string().nonempty('请选择平台'),
    quality: z.enum(['fast', 'medium', 'slow']),
    screenshot: z.boolean().optional(),
    link: z.boolean().optional(),
    model_name: z.string().nonempty('请选择模型'),
    format: z.array(z.string()).default([]),
    style: z.string().nonempty('请选择笔记生成风格'),
    extras: z.string().optional(),
    video_understanding: z.boolean().optional(),
    video_interval: z.coerce.number().min(1).max(30).default(6).optional(),
    grid_size: z
      .tuple([z.coerce.number().min(1).max(10), z.coerce.number().min(1).max(10)])
      .default([2, 2])
      .optional(),
  })
  .superRefine(({ video_url, platform }, ctx) => {
    if (platform === 'local') {
      if (!video_url) {
        ctx.addIssue({ code: 'custom', message: '本地视频路径不能为空', path: ['video_url'] })
      }
    }
    else {
      if (!video_url) {
        ctx.addIssue({ code: 'custom', message: '视频链接不能为空', path: ['video_url'] })
      }
      else {
        try {
          const url = new URL(video_url)
          if (!['http:', 'https:'].includes(url.protocol))
            throw new Error()
        }
        catch {
          ctx.addIssue({ code: 'custom', message: '请输入正确的视频链接', path: ['video_url'] })
        }
      }
    }
  })

export type NoteFormValues = z.infer<typeof formSchema>

/* -------------------- 可复用子组件 -------------------- */
const SectionHeader = ({ title, tip }: { title: string; tip?: string }) => (
  <div className="my-3 flex items-center justify-between">
    <h2 className="block">{title}</h2>
    {tip && <InfoTip>{tip}</InfoTip>}
  </div>
)

const CheckboxGroup = ({
  value = [],
  onChange,
  disabledMap,
}: {
  value?: string[]
  onChange: (v: string[]) => void
  disabledMap: Record<string, boolean>
}) => (
  <div className="flex flex-wrap space-x-1.5">
    {noteFormats.map(({ label, value: v }) => (
      <label key={v} className="flex items-center space-x-2">
        <Checkbox
          checked={value.includes(v)}
          disabled={disabledMap[v]}
          onCheckedChange={checked =>
            onChange(checked ? [...value, v] : value.filter(x => x !== v))
          }
        />
        <span>{label}</span>
      </label>
    ))}
  </div>
)

/* -------------------- 主组件 -------------------- */
const NoteForm = () => {
  const navigate = useNavigate();
  const [isUploading, setIsUploading] = useState(false)
  const [uploadSuccess, setUploadSuccess] = useState(false)
  /* ---- 全局状态 ---- */
  const { addPendingTask, currentTaskId, setCurrentTask, getCurrentTask, retryTask } =
    useTaskStore()
  const { loadEnabledModels, modelList, showFeatureHint, setShowFeatureHint } = useModelStore()

  /* ---- 表单 ---- */
  const form = useForm<NoteFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      platform: 'bilibili',
      quality: 'medium',
      model_name: modelList[0]?.model_name || '',
      style: 'minimal',
      video_interval: 6,
      grid_size: [2, 2],
      format: ['toc', 'link', 'summary'],
    },
  })
  const currentTask = getCurrentTask()

  /* ---- 派生状态（只 watch 一次，提高性能） ---- */
  const platform = useWatch({ control: form.control, name: 'platform' }) as string
  const editing = currentTask && currentTask.id

  /* ---- 链接自动识别 ---- */
  // 上一次从「分享文案」里抽出来的结果，仅用于在输入框下方给个反馈
  const [recognized, setRecognized] = useState<ParsedVideoInput | null>(null)

  const platformLabel = (value: ParsedVideoInput['platform']) =>
    videoPlatforms.find(p => p.value === (value as string))?.label ?? '视频'

  /** 把识别结果写回表单：链接 + 自动切平台 */
  const applyParsedInput = (parsed: ParsedVideoInput) => {
    form.setValue('video_url', parsed.url, { shouldValidate: true, shouldDirty: true })
    if (parsed.platform && parsed.platform !== form.getValues('platform')) {
      form.setValue('platform', parsed.platform)
    }
    setRecognized(parsed)
  }

  /**
   * 粘贴时拦截：拿到的是「【标题】+ 链接」这种分享文案就直接抽链接，
   * 本来就是一条干净链接则放行走浏览器默认粘贴（保留在中间插入的能力）。
   */
  const handleUrlPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    if (platform === 'local') return

    const parsed = parseVideoInput(e.clipboardData?.getData('text') ?? '')
    if (!parsed || (!parsed.extracted && parsed.url === parsed.rawUrl)) return

    e.preventDefault()
    applyParsedInput(parsed)
  }

  /** 失焦兜底：覆盖拖拽、输入法等绕过 paste 事件的场景，顺手把跟踪参数洗掉 */
  const handleUrlBlur = () => {
    if (platform === 'local') return

    const current = form.getValues('video_url') ?? ''
    const parsed = parseVideoInput(current)
    if (parsed && (parsed.url !== current || parsed.url !== parsed.rawUrl)) applyParsedInput(parsed)
  }

  const goModelAdd = () => {
    navigate("/settings/model");
  };
  /* ---- 副作用 ---- */
  useEffect(() => {
    loadEnabledModels()

    return
  }, [])
  useEffect(() => {
    if (!currentTask) return
    const { formData } = currentTask

    console.log('currentTask.formData.platform:', formData.platform)

    form.reset({
      platform: formData.platform || 'bilibili',
      // 同步来的笔记 formData 里没有链接，从 audio_meta 里推一条出来，
      // 否则「重新生成」会被必填校验拦下且看不出原因
      video_url: resolveVideoUrl({
        platform: formData.platform,
        videoId: currentTask.audioMeta?.video_id,
        rawInfo: currentTask.audioMeta?.raw_info as Record<string, unknown> | null,
        fallback: formData.video_url,
      }),
      model_name: formData.model_name || modelList[0]?.model_name || '',
      style: formData.style || 'minimal',
      quality: formData.quality || 'medium',
      extras: formData.extras || '',
      screenshot: formData.screenshot ?? false,
      link: formData.link ?? false,
      video_understanding: formData.video_understanding ?? false,
      video_interval: formData.video_interval ?? 6,
      grid_size: formData.grid_size ?? [2, 2],
      format: formData.format ?? [],
    })
  }, [
    // 当下面任意一个变了，就重新 reset
    currentTaskId,
    // modelList 用来兜底 model_name
    modelList.length,
    // 还要加上 formData 的各字段，或者直接 currentTask
    currentTask?.formData,
  ])

  /* ---- 帮助函数 ---- */
  const isGenerating = () => !['SUCCESS', 'FAILED', undefined].includes(getCurrentTask()?.status)
  const generating = isGenerating()
  const handleFileUpload = async (file: File, cb: (url: string) => void) => {
    const formData = new FormData()
    formData.append('file', file)
    setIsUploading(true)
    setUploadSuccess(false)

    try {
  
      const  data  = await uploadFile(formData)
        cb(data.url)
        setUploadSuccess(true)
    } catch (err) {
      console.error('上传失败:', err)
      // message.error('上传失败，请重试')
    } finally {
      setIsUploading(false)
    }
  }

  const onSubmit = async (values: NoteFormValues) => {
    console.log('Not even go here')
    const resolved = resolveModelConfig({ formData: values }, modelList)
    const payload: NoteFormValues = {
      ...values,
      // 选中的模型可能已经不在启用列表里（比如同步来的笔记），用兜底避免直接崩；
      // 模型名和供应商要一起取兜底结果，否则会拿 A 供应商去调 B 模型
      model_name: resolved?.modelName || values.model_name,
      provider_id: resolved?.providerId || '',
      task_id: currentTaskId || '',
    }
    if (currentTaskId) {
      // 改了链接就明确告诉用户：这次是按新视频重跑，避免以为还是原来那条
      const previousUrl = currentTask?.formData?.video_url || ''
      if (payload.video_url && payload.video_url !== previousUrl) {
        toast.success(previousUrl ? '视频地址已更新，按新链接重新生成' : '已补上视频链接，开始重新生成')
      }
      retryTask(currentTaskId, payload)
      return
    }

    // message.success('已提交任务')
    const  data  = await generateNote(payload)
    addPendingTask(data.task_id, values.platform, payload)
  }
  const onInvalid = (errors: FieldErrors<NoteFormValues>) => {
    console.warn('表单校验失败：', errors)
    // 字段错误文案是隐藏的（布局原因），校验失败必须给个 toast，
    // 否则用户只会看到「点了没反应」—— 同步来的笔记缺链接时最容易踩到
    const firstError = Object.values(errors).find(Boolean) as { message?: string } | undefined
    toast.error(firstError?.message || '请检查表单是否填写完整')
  }
  const handleCreateNew = () => {
    // 🔁 这里清空当前任务状态
    // 比如调用 resetCurrentTask() 或者 navigate 到一个新页面
    setCurrentTask(null)
  }
  const FormButton = () => {
    const label = generating ? '正在生成…' : editing ? '重新生成' : '生成笔记'

    return (
      <div className="flex gap-2">
        <Button
          type="submit"
          className={!editing ? 'w-full' : 'w-2/3' + ' bg-primary'}
          disabled={generating}
        >
          {generating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {label}
        </Button>

        {editing && (
          <Button type="button" variant="outline" className="w-1/3" onClick={handleCreateNew}>
            <Plus className="mr-2 h-4 w-4" />
            新建笔记
          </Button>
        )}
      </div>
    )
  }

  /* -------------------- 渲染 -------------------- */
  return (
    <div className="h-full w-full">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit, onInvalid)} className="space-y-4">
          {/* 顶部按钮 */}
          <FormButton></FormButton>

          {/* 视频链接 & 平台 */}
          <SectionHeader title="视频链接" tip="支持 B 站、YouTube 等平台" />
          <div className="flex gap-2">
            {/* 平台选择 */}

            <FormField
              control={form.control}
              name="platform"
              render={({ field }) => (
                <FormItem>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {videoPlatforms?.map(p => (
                        <SelectItem key={p.value} value={p.value}>
                          <div className="flex items-center justify-center gap-2">
                            <div className="h-4 w-4">{p.logo()}</div>
                            <span>{p.label}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage style={{ display: 'none' }} />
                </FormItem>
              )}
            />
            {/* 链接输入 / 上传框 */}
            <FormField
              control={form.control}
              name="video_url"
              render={({ field }) => (
                <FormItem className="flex-1">
                  {platform === 'local' ? (
                    <>
                      <Input
                        placeholder={
                          editing && !field.value
                            ? '这条笔记没有存路径，填写视频文件路径后即可重新生成'
                            : '请输入本地视频路径'
                        }
                        {...field}
                      />
                    </>
                  ) : (
                    <Input
                      placeholder={
                        editing && !field.value
                          ? '这条笔记没有存链接，粘贴原视频链接后即可重新生成'
                          : '粘贴视频链接，或直接粘贴 App 的分享文案'
                      }
                      {...field}
                      onChange={e => {
                        // 重新编辑就撤掉上一次的识别反馈
                        setRecognized(null)
                        field.onChange(e)
                      }}
                      onPaste={handleUrlPaste}
                      onBlur={e => {
                        field.onBlur(e)
                        handleUrlBlur()
                      }}
                    />
                  )}
                  {recognized && platform !== 'local' && (
                    <p className="text-muted-foreground text-xs">
                      已识别 {platformLabel(recognized.platform)}
                      {recognized.title ? `：${recognized.title}` : ' 链接'}
                    </p>
                  )}
                  <FormMessage style={{ display: 'none' }} />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="video_url"
            render={({ field }) => (
              <FormItem className="flex-1">
                {platform === 'local' && (
                  <>
                    <div
                      className="hover:border-primary mt-2 flex h-40 cursor-pointer items-center justify-center rounded-md border-2 border-dashed border-gray-300 transition-colors"
                      onDragOver={e => {
                        e.preventDefault()
                        e.stopPropagation()
                      }}
                      onDrop={e => {
                        e.preventDefault()
                        const file = e.dataTransfer.files?.[0]
                        if (file) handleFileUpload(file, field.onChange)
                      }}
                      onClick={() => {
                        const input = document.createElement('input')
                        input.type = 'file'
                        input.accept = 'video/*'
                        input.onchange = e => {
                          const file = (e.target as HTMLInputElement).files?.[0]
                          if (file) handleFileUpload(file, field.onChange)
                        }
                        input.click()
                      }}
                    >
                      {isUploading ? (
                        <p className="text-center text-sm text-blue-500">上传中，请稍候…</p>
                      ) : uploadSuccess ? (
                        <p className="text-center text-sm text-green-500">上传成功！</p>
                      ) : (
                        <p className="text-center text-sm text-gray-500">
                          拖拽文件到这里上传 <br />
                          <span className="text-xs text-gray-400">或点击选择文件</span>
                        </p>
                      )}
                    </div>
                  </>
                )}
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="grid grid-cols-2 gap-2">
            {/* 模型选择 */}
            {

             modelList.length>0?(     <FormField
               className="w-full"
               control={form.control}
               name="model_name"
               render={({ field }) => (
                 <FormItem>
                   <SectionHeader title="模型选择" tip="不同模型效果不同，建议自行测试" />
                   <Select
                     onOpenChange={()=>{
                       loadEnabledModels()
                     }}
                     value={field.value}
                     onValueChange={field.onChange}
                     defaultValue={field.value}
                   >
                     <FormControl>
                       <SelectTrigger className="w-full min-w-0 truncate">
                         <SelectValue />
                       </SelectTrigger>
                     </FormControl>
                     <SelectContent>
                       {modelList.map(m => (
                         <SelectItem key={m.id} value={m.model_name}>
                           {m.model_name}
                         </SelectItem>
                       ))}
                     </SelectContent>
                   </Select>
                   <FormMessage />
                 </FormItem>
               )}
             />): (
               <FormItem>
                 <SectionHeader title="模型选择" tip="不同模型效果不同，建议自行测试" />
                  <Button type={'button'} variant={
                    'outline'
                  } onClick={()=>{goModelAdd()}}>请先添加模型</Button>
                 <FormMessage />
               </FormItem>
             )
            }

            {/* 笔记风格 */}
            <FormField
              className="w-full"
              control={form.control}
              name="style"
              render={({ field }) => (
                <FormItem>
                  <SectionHeader title="笔记风格" tip="选择生成笔记的呈现风格" />
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full min-w-0 truncate">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {noteStyles.map(({ label, value }) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          {/* 笔记格式 */}
          <FormField
            control={form.control}
            name="format"
            render={({ field }) => (
              <FormItem>
                <SectionHeader
                  title="笔记格式"
                  tip="原片截图会在各章节内自动截取对应时间点的画面（需下载完整视频）"
                />
                <CheckboxGroup
                  value={field.value}
                  onChange={field.onChange}
                  disabledMap={{
                    link: platform === 'local',
                  }}
                />
                <FormMessage />
              </FormItem>
            )}
          />

          {/* 备注 */}
          <FormField
            control={form.control}
            name="extras"
            render={({ field }) => (
              <FormItem>
                <SectionHeader title="备注" tip="可在 Prompt 结尾附加自定义说明" />
                <Textarea placeholder="笔记需要罗列出 xxx 关键点…" {...field} />
                <FormMessage />
              </FormItem>
            )}
          />
        </form>
      </Form>
    </div>
  )
}

export default NoteForm
