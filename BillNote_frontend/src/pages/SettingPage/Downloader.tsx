import { Outlet } from 'react-router-dom'
import Options from '@/components/Form/DownloaderForm/Options.tsx'
import { useIsMobile } from '@/hooks/useIsMobile.ts'

const Downloader = () => {
  const isMobile = useIsMobile()

  // 移动端：同样把左右两栏改为上下堆叠
  if (isMobile) {
    return (
      <div className="flex flex-col bg-white">
        <div className="shrink-0 border-b border-neutral-200 p-2">
          <Options></Options>
        </div>
        <div>
          <Outlet />
        </div>
      </div>
    )
  }

  return (
    <div className={'flex h-full bg-white'}>
      <div className={'flex-1/5 border-r border-neutral-200 p-2'}>
        <Options></Options>
      </div>
      <div className={'flex-4/5'}>
        <Outlet />
      </div>
    </div>
  )
}
export default Downloader
