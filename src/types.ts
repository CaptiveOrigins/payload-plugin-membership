import type { CollectionConfig, Payload, PayloadRequest } from 'payload'

/** Who manages tiers, categories and memberships in the admin (default: nobody but overrideAccess code). */
export type CanManage = (args: { req: PayloadRequest }) => boolean | Promise<boolean>

export type Interval = 'month' | 'year'

/** A paid invoice, as recorded in the payments ledger. Amounts in the currency's minor unit (cents). */
export type PaymentRecord = {
  id: string
  membership: string
  user: string
  amount: number
  currency: string
  paidAt: string
  invoiceId: string
  /** Pledged amounts per category in this payment (pledge memberships). */
  pledges: { category: string; amount: number }[]
  tier: string | null
}

export type MembershipRecord = {
  id: string
  user: string
  kind: 'tier' | 'pledge'
  tier: string | null
  pledges: { category: string; amount: number }[]
  interval: Interval
  amount: number
  currency: string
  status: MembershipStatus
}

export type MembershipStatus = 'pending' | 'active' | 'past_due' | 'canceled' | 'incomplete'

/** The small part of the Stripe SDK the plugin uses (inject a fake in tests). */
export type StripeLike = {
  checkout: { sessions: { create: (params: Record<string, unknown>) => Promise<{ id: string; url: string | null }> } }
  billingPortal: { sessions: { create: (params: Record<string, unknown>) => Promise<{ url: string }> } }
  products: { create: (params: Record<string, unknown>) => Promise<{ id: string }> }
  subscriptions: {
    retrieve: (id: string) => Promise<StripeSubscription>
    update: (id: string, params: Record<string, unknown>) => Promise<StripeSubscription>
  }
  webhooks: { constructEvent: (payload: string, signature: string, secret: string) => StripeEvent }
}
export type StripeSubscription = {
  id: string
  status: string
  customer: string | { id: string }
  cancel_at_period_end?: boolean
  current_period_end?: number
  items: { data: { id: string; current_period_end?: number }[] }
  metadata?: Record<string, string>
}
export type StripeEvent = { id: string; type: string; data: { object: Record<string, unknown> } }

export type MembershipPluginOptions = {
  /** Slugs. Defaults: `membership-tiers`, `membership-categories`, `memberships`, `membership-payments`. */
  slugs?: { tiers?: string; categories?: string; memberships?: string; payments?: string }
  /** The auth collection of members. Default: `admin.user` of your config. */
  users?: string
  /** Who manages tiers, categories and memberships in the admin. */
  canManage?: CanManage
  /** May members start or change memberships here right now (e.g. off in development)? Default: always. */
  canCheckout?: (args: { payload: Payload }) => boolean | Promise<boolean>
  /** Stripe secret key (`sk_…`/`rk_…`), or a ready client. Without either, checkout is off. */
  stripeSecretKey?: string
  stripe?: StripeLike
  /** Signing secret of the webhook endpoint (`whsec_…`) for `/api/<memberships>/stripe-webhook`. */
  webhookSecret?: string
  /** ISO currency, lowercase. Default `usd`. */
  currency?: string
  /** Public origin for Stripe return links. Default: `serverURL`. */
  publicURL?: string
  /** A field that separates owners (e.g. `tenant`): new tiers/categories go A–Z among their own; memberships are per scope. */
  scopeField?: string
  /** The scope of a request (e.g. the site of the request's host), stored on new memberships. */
  scopeOf?: (req: PayloadRequest) => Promise<string | null> | string | null
  /** Called once per paid invoice (idempotent: never twice for the same invoice). Award perks, votes, credits here. */
  onPayment?: (args: { payload: Payload; payment: PaymentRecord; membership: MembershipRecord }) => Promise<void> | void
  /** Called when a membership's status changes (e.g. list or retire a sponsor-wall perk). */
  onStatusChange?: (args: { payload: Payload; membership: MembershipRecord; previous: MembershipStatus | null }) => Promise<void> | void
  /** Change the generated collections before they are added (fields, access, admin groups). */
  overrides?: {
    tiers?: (c: CollectionConfig) => CollectionConfig
    categories?: (c: CollectionConfig) => CollectionConfig
    memberships?: (c: CollectionConfig) => CollectionConfig
    payments?: (c: CollectionConfig) => CollectionConfig
  }
}

export type ResolvedMembership = {
  tiers: string
  categories: string
  memberships: string
  payments: string
  users: string
  canManage: CanManage
  canCheckout?: MembershipPluginOptions['canCheckout']
  stripe: () => StripeLike | null
  webhookSecret?: string
  currency: string
  publicURL?: string
  scopeField?: string
  scopeOf?: MembershipPluginOptions['scopeOf']
  onPayment?: MembershipPluginOptions['onPayment']
  onStatusChange?: MembershipPluginOptions['onStatusChange']
}
