import { ExternalLink } from 'lucide-react'
import { Button } from 'ui'
import { Admonition } from 'ui-patterns/admonition'

import { STRIPE_DASHBOARD_URL } from '@/components/interfaces/Billing/Payment/PaymentMethods/StripePaymentConnection'

export const StripeManagedPlanNotice = () => {
  return (
    <Admonition
      type="default"
      title="Subscription plan managed through Stripe"
      description="Plan changes for this organisation are handled through your connected Stripe project."
      actions={
        <Button asChild type="default" iconRight={<ExternalLink size={14} />}>
          <a href={STRIPE_DASHBOARD_URL} target="_blank" rel="noopener noreferrer">
            Manage in Stripe Dashboard
          </a>
        </Button>
      }
    />
  )
}
