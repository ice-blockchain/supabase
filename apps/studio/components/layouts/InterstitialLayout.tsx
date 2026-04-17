import type { PropsWithChildren, ReactNode } from 'react'

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
            {description && <p className="mt-1 text-sm text-foreground-light">{description}</p>}
          </div>
        )}
        {children}
      </div>
    </div>
  )
}

/** Wraps a single icon in the standard rounded-rect logo container. */
export const LogoBox = ({ children }: { children: ReactNode }) => (
  <div className="flex size-12 items-center justify-center overflow-hidden rounded-xl bg-muted">
    {children}
  </div>
)

/** Two icons side-by-side with the "×" separator, each in their own LogoBox. */
export const LogoPair = ({ left, right }: { left: ReactNode; right: ReactNode }) => (
  <div className="flex items-center justify-center gap-3">
    <LogoBox>{left}</LogoBox>
    <span className="select-none text-sm text-foreground-muted">×</span>
    <LogoBox>{right}</LogoBox>
  </div>
)

/** Supabase symbol SVG (not the wordmark). Sized via className, e.g. className="size-7". */
export const SupabaseSymbol = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 109 113" className={className} aria-label="Supabase">
    <path
      d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z"
      fill="url(#supabase_gradient_1)"
    />
    <path
      d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z"
      fill="url(#supabase_gradient_2)"
      fillOpacity="0.2"
    />
    <path
      d="M45.317 2.07103C48.1765 -1.53037 53.9745 0.442937 54.0434 5.041L54.4849 72.2922H9.83113C1.64038 72.2922 -2.9274 62.8321 2.1655 56.4175L45.317 2.07103Z"
      fill="#3ECF8E"
    />
    <defs>
      <linearGradient
        id="supabase_gradient_1"
        x1="53.9738"
        y1="54.974"
        x2="94.1635"
        y2="71.8295"
        gradientUnits="userSpaceOnUse"
      >
        <stop stopColor="#249361" />
        <stop offset="1" stopColor="#3ECF8E" />
      </linearGradient>
      <linearGradient
        id="supabase_gradient_2"
        x1="36.1558"
        y1="30.578"
        x2="54.4844"
        y2="65.0806"
        gradientUnits="userSpaceOnUse"
      >
        <stop />
        <stop offset="1" stopOpacity="0" />
      </linearGradient>
    </defs>
  </svg>
)
