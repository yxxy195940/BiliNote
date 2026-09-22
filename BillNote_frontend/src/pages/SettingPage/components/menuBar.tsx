import styles from './index.module.css'
import { FC, JSX } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useIsMobile } from '@/hooks/useIsMobile.ts'

export interface IMenuProps {
  id: string
  name: string
  icon: JSX.Element
  path: string
}

interface IMenuItem {
  menuItem: IMenuProps
}

const MenuBar: ({ menuItem }: { menuItem: any }) => JSX.Element = ({ menuItem }) => {
  const location = useLocation()
  const isMobile = useIsMobile()
  const isActive =
    location.pathname.startsWith(menuItem.path + '/') || location.pathname === menuItem.path

  // 移动端：胶囊标签样式，横向排在顶部菜单条里
  if (isMobile) {
    return (
      <Link to={menuItem.path} className="shrink-0">
        <div
          className={
            'flex h-9 items-center gap-1.5 rounded-full px-3 whitespace-nowrap' +
            (isActive ? ' bg-[#F0F0F0] font-semibold text-blue-600' : ' text-neutral-600')
          }
        >
          <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
            {menuItem.icon}
          </span>
          <span className="text-sm">{menuItem.name}</span>
        </div>
      </Link>
    )
  }

  return (
    <Link to={menuItem.path} className="w-full">
      <div
        className={
          styles.menuBar +
          ' flex h-12 w-full items-center gap-1 rounded px-2' +
          (isActive ? ' bg-[#F0F0F0] font-semibold text-blue-600' : '')
        }
      >
        <div className="flex h-6 w-6 items-center justify-center">{menuItem.icon}</div>
        <div className="text-[16px]">{menuItem.name}</div>
      </div>
    </Link>
  )
}

export default MenuBar
