import { useTheme } from 'next-themes'
import type { PropsWithChildren, ReactNode } from 'react'
import { cn } from 'ui'

import { BASE_PATH } from '@/lib/constants'

interface InterstitialLayoutProps {
  logo?: ReactNode
  title?: string
  description?: string
}

export const InterstitialLayout = ({
  logo,
  title,
  description,
  children,
}: PropsWithChildren<InterstitialLayoutProps>) => {
  return (
    <div
      className={cn(
        'flex min-h-screen w-full flex-col',
        'items-center justify-center gap-4 px-5',
        'bg-studio'
      )}
    >
      {logo && <div className="flex items-center justify-center">{logo}</div>}
      {(title || description) && (
        <div className="flex flex-col items-center gap-1 text-center">
          {title && <h1 className="text-lg font-medium text-foreground">{title}</h1>}
          {description && <p className="text-sm text-foreground-light">{description}</p>}
        </div>
      )}
      <div className={cn('overflow-hidden rounded-md border border-muted shadow', 'md:w-[400px]')}>
        {children}
      </div>
    </div>
  )
}

export const LogoPair = ({ left, right }: { left: ReactNode; right: ReactNode }) => (
  <div className="flex items-center gap-3">
    {left}
    <span className="select-none text-xs text-foreground-muted">×</span>
    {right}
  </div>
)

export const SupabaseLogo = ({ className }: { className?: string }) => {
  const { resolvedTheme } = useTheme()
  return (
    <img
      src={
        resolvedTheme?.includes('dark')
          ? `${BASE_PATH}/img/supabase-dark.svg`
          : `${BASE_PATH}/img/supabase-light.svg`
      }
      alt="Supabase"
      className={cn('block h-[20px]', className)}
    />
  )
}
