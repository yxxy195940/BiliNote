import {
  BotMessageSquare,
  Captions,
  HardDriveDownload,
  Info,
  Activity,
} from 'lucide-react'
import MenuBar, { IMenuProps } from '@/pages/SettingPage/components/menuBar.tsx'
import { useIsMobile } from '@/hooks/useIsMobile.ts'

const Menu = () => {
  const isMobile = useIsMobile()
  const menuList: IMenuProps[] = [
    {
      id: 'model',
      name: 'AI 模型设置',
      icon: <BotMessageSquare size={18} />,
      path: '/settings/model',
    },
    {
      id: 'transcriber',
      name: '音频转写配置',
      icon: <Captions size={18} />,
      path: '/settings/transcriber',
    },
    {
      id: 'download',
      name: '下载配置',
      icon: <HardDriveDownload size={18} />,
      path: '/settings/download',
    },
    // //其他配置
    // {
    //   id: 'prompt',
    //   name: '提示词设置',
    //   icon: <SquareChevronRight />,
    //   path: '/settings/prompt',
    // },
    {
      id: 'monitor',
      name: '部署监控',
      icon: <Activity size={18} />,
      path: '/settings/monitor',
    },
    {
      id: 'about',
      name: '关于',
      icon: <Info size={18} />,
      path: '/settings/about',
    },
    // {
    //   id: 'other',
    //   name: '其他配置',
    //   icon: <Wrench />,
    //   path: '/settings/other',
    // },
  ]

  // 移动端：菜单横向排列并支持左右滑动，省掉占地方的标题区
  if (isMobile) {
    return (
      <div className="flex w-full gap-2 overflow-x-auto px-3 py-2">
        {menuList.map(item => (
          <MenuBar key={item.id} menuItem={item} />
        ))}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className={'flex w-full flex-col gap-2'}>
        <div className="text-2xl font-medium">设置</div>
        <div className="text-sm font-light text-gray-800">全局配置与模型设置</div>
      </div>
      <div className="mt-6 flex-1">
        {menuList &&
          menuList.map(item => {
            return <MenuBar key={item.id} menuItem={item} />
          })}
      </div>
    </div>
  )
}
export default Menu
