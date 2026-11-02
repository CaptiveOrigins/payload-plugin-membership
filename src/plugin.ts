import type { Config, Plugin } from 'payload'
import Stripe from 'stripe'

import { categoriesCollection, membershipsCollection, paymentsCollection, tiersCollection } from './collections.js'
import { cancelEndpoint, changeEndpoint, checkoutEndpoint, portalEndpoint, wallEndpoint, webhookEndpoint } from './endpoints.js'
import type { MembershipPluginOptions, ResolvedMembership, StripeLike } from './types.js'

/**
 * Memberships: fixed tiers (Patreon-style) and/or pledges where members pick
 * categories and set their own amounts, billed monthly or yearly as Stripe
 * subscriptions. A payments ledger calls `onPayment` once per paid invoice;
 * `getBackers` builds an opt-in backers wall, A–Z within each tier/category.
 */
export const membershipPlugin =
  (options: MembershipPluginOptions = {}): Plugin =>
  (config: Config): Config => {
    let client: StripeLike | null | undefined = options.stripe
    const o: ResolvedMembership = {
      tiers: options.slugs?.tiers ?? 'membership-tiers',
      categories: options.slugs?.categories ?? 'membership-categories',
      memberships: options.slugs?.memberships ?? 'memberships',
      payments: options.slugs?.payments ?? 'membership-payments',
      users: options.users ?? config.admin?.user ?? 'users',
      canManage: options.canManage ?? (() => false),
      canCheckout: options.canCheckout,
      stripe: () => (client === undefined ? (client = options.stripeSecretKey ? (new Stripe(options.stripeSecretKey) as unknown as StripeLike) : null) : client),
      webhookSecret: options.webhookSecret,
      currency: (options.currency ?? 'usd').toLowerCase(),
      publicURL: options.publicURL,
      scopeField: options.scopeField,
      scopeOf: options.scopeOf,
      onPayment: options.onPayment,
      onStatusChange: options.onStatusChange,
    }
    const apply = (c: ReturnType<typeof tiersCollection>, f?: (c: ReturnType<typeof tiersCollection>) => ReturnType<typeof tiersCollection>) => (f ? f(c) : c)
    const memberships = membershipsCollection(o)
    memberships.endpoints = [checkoutEndpoint, webhookEndpoint, changeEndpoint, cancelEndpoint, portalEndpoint, wallEndpoint]
    return {
      ...config,
      collections: [
        ...(config.collections ?? []),
        apply(tiersCollection(o), options.overrides?.tiers),
        apply(categoriesCollection(o), options.overrides?.categories),
        apply(memberships, options.overrides?.memberships),
        apply(paymentsCollection(o), options.overrides?.payments),
      ],
      custom: { ...config.custom, membership: o },
    }
  }
