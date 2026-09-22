import Provider from '@/components/Form/modelForm/Provider.tsx'
import { Outlet } from 'react-router-dom'
import { useIsMobile } from '@/hooks/useIsMobile.ts'

const Model = () => {
  const isMobile = useIsMobile()

  // 移动端：左右两栏在手机上挤不下（左侧只剩几十像素），改为上下堆叠
  if (isMobile) {
    return (
      <div className="flex flex-col bg-white">
        <div className="shrink-0 border-b border-neutral-200 p-2">
          <Provider></Provider>
        </div>
        <div>
          <Outlet />
        </div>
      </div>
    )
  }

  return (
    <div className={'flex h-full min-h-0 bg-white'}>
      <div className={'flex-1/5 min-h-0 overflow-y-auto border-r border-neutral-200 p-2'}>
        <Provider></Provider>
      </div>
      <div className={'flex-4/5 min-h-0 overflow-y-auto'}>
        <Outlet />
      </div>
    </div>
  )
}
export default Model
