import { ArrowRightLeft } from 'lucide-react'
import type { PropsWithChildren, ReactNode } from 'react'
import { cn } from 'ui'

import { BASE_PATH } from '@/lib/constants'

interface InterstitialLayoutProps {
  logo?: ReactNode
  title?: string
  description?: string
}

/**
 * Minimal full-screen centered layout for interstitial flows:
 * partner authorization, org invites, CLI auth, credit redemption, etc.
 *
 * The logo, title, and description render inside the card (above children),
 * so every consumer gets a consistent header for free.
 */
export const InterstitialLayout = ({
  logo,
  title,
  description,
  children,
}: PropsWithChildren<InterstitialLayoutProps>) => {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-studio px-5">
      <div className="w-full overflow-hidden rounded-xl border border-muted bg-surface-100 shadow md:w-[400px]">
        {(logo || title || description) && (
          <div className="p-6 pb-4 text-center">
            {logo && <div className="mb-4 flex justify-center">{logo}</div>}
            {title && <h1 className="text-lg font-semibold text-foreground">{title}</h1>}
            {description && <p className="text-sm text-foreground-light">{description}</p>}
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

/**
 * Standard rounded-rect logo container (48x48).
 * Partner logos fill edge-to-edge (see `PartnerLogo`); the Supabase symbol and
 * Lucide icons sit inset (sized at `size-7`).
 */
export const LogoBox = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div
    className={cn(
      'flex size-12 items-center justify-center overflow-hidden rounded-xl border border-muted bg-muted',
      className
    )}
  >
    {children}
  </div>
)

/** Two pre-boxed logos side-by-side with a swap separator. */
export const LogoPair = ({ left, right }: { left: ReactNode; right: ReactNode }) => (
  <div className="flex items-center justify-center gap-3">
    {left}
    <ArrowRightLeft className="size-4 text-foreground-muted" />
    {right}
  </div>
)

/** Partner logo rendered edge-to-edge inside a LogoBox. */
export const PartnerLogo = ({ src, alt }: { src: string; alt: string }) => (
  <LogoBox>
    <img alt={alt} src={src} className="size-full object-cover" />
  </LogoBox>
)

/** Supabase symbol (not the wordmark) rendered inset inside a LogoBox. */
export const SupabaseLogo = () => (
  <LogoBox>
    <img alt="Supabase" src={`${BASE_PATH}/img/supabase-logo.svg`} className="size-7" />
  </LogoBox>
)
