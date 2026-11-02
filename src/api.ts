import { APIError, type CollectionSlug, type Payload, type Where } from 'payload'

import type { Interval, MembershipRecord, MembershipStatus, PaymentRecord, ResolvedMembership, StripeEvent, StripeLike, StripeSubscription } from './types.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const idOf = (v: unknown) => (v && typeof v === 'object' ? String((v as { id: unknown }).id) : v ? String(v) : null)
const ctx = { membershipSync: true }

export const membershipOf = (payload: Payload): ResolvedMembership => payload.config.custom?.membership as ResolvedMembership

const stripeOf = (o: ResolvedMembership): StripeLike => {
  const s = o.stripe()
  if (!s) throw new APIError('Memberships are not available here yet.', 503, undefined, true)
  return s
}

/** What a member chooses: a tier, or amounts (cents per interval) for categories. */
export type Choice = { tier?: string | null; pledges?: { category: string; amount: number }[] | null; interval: Interval }

type Line = { product: string; name: string; amount: number }

/** Validates a choice and turns it into priced lines (creating Stripe products on first use). */
async function linesFor(payload: Payload, o: ResolvedMembership, choice: Choice, scope: string | null): Promise<{ kind: 'tier' | 'pledge'; lines: Line[]; tier: Doc | null; pledges: { category: string; amount: number }[] }> {
  if (choice.interval !== 'month' && choice.interval !== 'year') throw new APIError('Choose monthly or yearly.', 400, undefined, true)
  const inScope = (d: Doc) => !o.scopeField || !scope || idOf(d[o.scopeField]) === scope
  if (choice.tier) {
    const tier = (await payload.findByID({ collection: o.tiers as CollectionSlug, id: choice.tier, depth: 0, overrideAccess: true, disableErrors: true })) as Doc | null
    const price = tier?.[choice.interval === 'month' ? 'monthly' : 'yearly']
    if (!tier || !tier.active || !inScope(tier) || !(price > 0)) throw new APIError('That tier isn’t available.', 400, undefined, true)
    return { kind: 'tier', tier, pledges: [], lines: [{ product: await productFor(payload, o, o.tiers, tier), name: tier.name, amount: Math.round(price) }] }
  }
  const pledges = (choice.pledges ?? []).filter((p) => p && p.category && Number(p.amount) > 0).map((p) => ({ category: String(p.category), amount: Math.round(Number(p.amount)) }))
  if (pledges.length === 0) throw new APIError('Choose a tier, or at least one category with an amount.', 400, undefined, true)
  if (pledges.length > 20) throw new APIError('Choose at most 20 categories.', 400, undefined, true)
  if (new Set(pledges.map((p) => p.category)).size !== pledges.length) throw new APIError('Each category once, please.', 400, undefined, true)
  const lines: Line[] = []
  for (const p of pledges) {
    const cat = (await payload.findByID({ collection: o.categories as CollectionSlug, id: p.category, depth: 0, overrideAccess: true, disableErrors: true })) as Doc | null
    if (!cat || !cat.active || !inScope(cat)) throw new APIError('One of those categories isn’t available.', 400, undefined, true)
    const minimum = (Number(cat.minimum) || 0) * (choice.interval === 'year' ? 12 : 1)
    if (p.amount < Math.max(minimum, 50)) throw new APIError(`The minimum for ${cat.name} is ${(Math.max(minimum, 50) / 100).toFixed(2)}.`, 400, undefined, true)
    lines.push({ product: await productFor(payload, o, o.categories, cat), name: cat.name, amount: p.amount })
  }
  return { kind: 'pledge', tier: null, pledges, lines }
}

async function productFor(payload: Payload, o: ResolvedMembership, slug: string, doc: Doc): Promise<string> {
  if (doc.stripeProduct) return doc.stripeProduct
  const product = await stripeOf(o).products.create({ name: doc.name, metadata: { payloadCollection: slug, payloadId: String(doc.id) } })
  await payload.update({ collection: slug as CollectionSlug, id: doc.id, data: { stripeProduct: product.id } as never, overrideAccess: true, context: ctx })
  return product.id
}

const priceData = (o: ResolvedMembership, line: Line, interval: Interval) => ({
  currency: o.currency,
  product: line.product,
  unit_amount: line.amount,
  recurring: { interval },
})

const labelOf = (user: Doc, kind: 'tier' | 'pledge', tier: Doc | null, lines: Line[]) =>
  `${user.name || user.email || 'Member'} · ${kind === 'tier' ? tier!.name : lines.map((l) => l.name).join(', ')}`.slice(0, 200)

/** Members in good standing (or still paying) block a second membership in the same scope. */
async function currentMembership(payload: Payload, o: ResolvedMembership, userId: string, scope: string | null) {
  const where: Where = { and: [{ user: { equals: userId } }, { status: { in: ['active', 'past_due', 'incomplete'] } }, ...(o.scopeField && scope ? [{ [o.scopeField]: { equals: scope } }] : [])] }
  return (await payload.find({ collection: o.memberships as CollectionSlug, where, limit: 1, depth: 0, overrideAccess: true })).docs[0] as Doc | undefined
}

/**
 * Starts a membership: validates the choice, records it as pending and opens
 * Stripe Checkout (a subscription with the member's own amounts). Returns the
 * Checkout URL; the webhook activates it once Stripe confirms.
 */
export async function startCheckout(
  payload: Payload,
  args: Choice & { user: Doc; successURL: string; cancelURL: string; scope?: string | null; wall?: { show?: boolean; name?: string | null } },
): Promise<{ url: string; membership: string }> {
  const o = membershipOf(payload)
  if (o.canCheckout && !(await o.canCheckout({ payload }))) throw new APIError('Memberships are not available here yet.', 503, undefined, true)
  const stripe = stripeOf(o)
  const scope = args.scope ?? null
  if (await currentMembership(payload, o, String(args.user.id), scope)) throw new APIError('You already have a membership: change it instead.', 409, undefined, true)
  const { kind, lines, tier, pledges } = await linesFor(payload, o, args, scope)
  const previous = (
    await payload.find({ collection: o.memberships as CollectionSlug, where: { and: [{ user: { equals: args.user.id } }, { 'stripe.customer': { exists: true } }] }, sort: '-createdAt', limit: 1, depth: 0, overrideAccess: true })
  ).docs[0] as Doc | undefined
  const membership = (await payload.create({
    collection: o.memberships as CollectionSlug,
    data: {
      label: labelOf(args.user, kind, tier, lines),
      user: args.user.id,
      kind,
      tier: tier ? tier.id : null,
      pledges,
      interval: args.interval,
      amount: lines.reduce((sum, l) => sum + l.amount, 0),
      currency: o.currency,
      status: 'pending',
      wall: { show: Boolean(args.wall?.show), name: args.wall?.name?.trim().slice(0, 80) || null },
      ...(o.scopeField && scope ? { [o.scopeField]: scope } : {}),
    } as never,
    overrideAccess: true,
    context: ctx,
  })) as Doc
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: lines.map((l) => ({ quantity: 1, price_data: priceData(o, l, args.interval) })),
    ...(previous?.stripe?.customer ? { customer: previous.stripe.customer } : { customer_email: args.user.email }),
    client_reference_id: String(membership.id),
    metadata: { membership: String(membership.id) },
    subscription_data: { metadata: { membership: String(membership.id) } },
    success_url: args.successURL,
    cancel_url: args.cancelURL,
  })
  await payload.update({ collection: o.memberships as CollectionSlug, id: membership.id, data: { stripe: { checkoutSession: session.id } } as never, overrideAccess: true, context: ctx })
  if (!session.url) throw new APIError('Stripe did not return a checkout page.', 502, undefined, true)
  return { url: session.url, membership: String(membership.id) }
}

/** Changes the tier or pledges of a running membership (same interval; takes effect from the next invoice). */
export async function changeMembership(payload: Payload, membershipId: string, choice: Omit<Choice, 'interval'>): Promise<Doc> {
  const o = membershipOf(payload)
  const m = (await payload.findByID({ collection: o.memberships as CollectionSlug, id: membershipId, depth: 1, overrideAccess: true })) as Doc
  if (!m.stripe?.subscription || !['active', 'past_due'].includes(m.status)) throw new APIError('Only a running membership can be changed.', 409, undefined, true)
  const scope = o.scopeField ? idOf(m[o.scopeField]) : null
  const { kind, lines, tier, pledges } = await linesFor(payload, o, { ...choice, interval: m.interval }, scope)
  const stripe = stripeOf(o)
  const sub = await stripe.subscriptions.retrieve(m.stripe.subscription)
  await stripe.subscriptions.update(sub.id, {
    items: [...sub.items.data.map((i) => ({ id: i.id, deleted: true })), ...lines.map((l) => ({ quantity: 1, price_data: priceData(o, l, m.interval) }))],
    proration_behavior: 'none',
    cancel_at_period_end: false,
  })
  return (await payload.update({
    collection: o.memberships as CollectionSlug,
    id: m.id,
    data: { kind, tier: tier ? tier.id : null, pledges, amount: lines.reduce((sum, l) => sum + l.amount, 0), cancelAtPeriodEnd: false, label: labelOf(typeof m.user === 'object' ? m.user : { email: '' }, kind, tier, lines) } as never,
    overrideAccess: true,
    context: ctx,
  })) as Doc
}

/** Cancels at the end of the paid period (the member keeps their perks until then). */
export async function cancelMembership(payload: Payload, membershipId: string): Promise<Doc> {
  const o = membershipOf(payload)
  const m = (await payload.findByID({ collection: o.memberships as CollectionSlug, id: membershipId, depth: 0, overrideAccess: true })) as Doc
  if (!m.stripe?.subscription) throw new APIError('This membership has no subscription to cancel.', 409, undefined, true)
  await stripeOf(o).subscriptions.update(m.stripe.subscription, { cancel_at_period_end: true })
  return (await payload.update({ collection: o.memberships as CollectionSlug, id: m.id, data: { cancelAtPeriodEnd: true } as never, overrideAccess: true, context: ctx })) as Doc
}

/** Stripe's customer portal (payment method, invoices, cancel). */
export async function portalLink(payload: Payload, membershipId: string, returnURL: string): Promise<string> {
  const o = membershipOf(payload)
  const m = (await payload.findByID({ collection: o.memberships as CollectionSlug, id: membershipId, depth: 0, overrideAccess: true })) as Doc
  if (!m.stripe?.customer) throw new APIError('Nothing to manage yet.', 409, undefined, true)
  return (await stripeOf(o).billingPortal.sessions.create({ customer: m.stripe.customer, return_url: returnURL })).url
}

const statusFrom = (s: string): MembershipStatus =>
  s === 'active' || s === 'trialing' ? 'active' : s === 'past_due' || s === 'unpaid' ? 'past_due' : s === 'incomplete' ? 'incomplete' : s === 'paused' ? 'past_due' : 'canceled'

const recordOf = (m: Doc): MembershipRecord => ({
  id: String(m.id),
  user: String(idOf(m.user)),
  kind: m.kind,
  tier: idOf(m.tier),
  pledges: (m.pledges ?? []).map((p: Doc) => ({ category: String(idOf(p.category)), amount: p.amount })),
  interval: m.interval,
  amount: m.amount,
  currency: m.currency,
  status: m.status,
})

async function setMembership(payload: Payload, o: ResolvedMembership, m: Doc, data: Doc): Promise<Doc> {
  const updated = (await payload.update({ collection: o.memberships as CollectionSlug, id: m.id, data: data as never, overrideAccess: true, depth: 0, context: ctx })) as Doc
  if (data.status && data.status !== m.status && o.onStatusChange) await o.onStatusChange({ payload, membership: recordOf(updated), previous: m.status ?? null })
  return updated
}

async function findBy(payload: Payload, o: ResolvedMembership, where: Where) {
  return (await payload.find({ collection: o.memberships as CollectionSlug, where, limit: 1, depth: 0, overrideAccess: true })).docs[0] as Doc | undefined
}

const subscriptionIdOf = (obj: Doc): string | null =>
  idOf(obj.subscription) ?? idOf(obj.parent?.subscription_details?.subscription) ?? idOf(obj.lines?.data?.[0]?.parent?.subscription_item_details?.subscription) ?? null
const periodEndOf = (sub: Doc): number | undefined => sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end

/**
 * Applies one Stripe webhook event. Safe to receive twice: payments are keyed
 * by invoice, and status updates are idempotent.
 */
export async function handleStripeEvent(payload: Payload, event: StripeEvent): Promise<'handled' | 'ignored'> {
  const o = membershipOf(payload)
  const obj = event.data.object as Doc
  switch (event.type) {
    case 'checkout.session.completed': {
      if (obj.mode !== 'subscription') return 'ignored'
      const id = obj.metadata?.membership ?? obj.client_reference_id
      const m = id ? await findBy(payload, o, { id: { equals: id } }) : undefined
      if (!m) return 'ignored'
      const subId = idOf(obj.subscription)
      const sub = subId ? await stripeOf(o).subscriptions.retrieve(subId) : null
      const end = sub ? periodEndOf(sub as Doc) : undefined
      await setMembership(payload, o, m, {
        stripe: { ...m.stripe, customer: idOf(obj.customer), subscription: subId },
        status: sub ? statusFrom(sub.status) : 'incomplete',
        startedAt: m.startedAt ?? new Date().toISOString(),
        ...(end ? { currentPeriodEnd: new Date(end * 1000).toISOString() } : {}),
      })
      return 'handled'
    }
    case 'invoice.paid': {
      const subId = subscriptionIdOf(obj)
      const m = subId ? await findBy(payload, o, { 'stripe.subscription': { equals: subId } }) : undefined
      if (!m || !(obj.amount_paid > 0)) return 'ignored'
      const exists = await payload.find({ collection: o.payments as CollectionSlug, where: { invoiceId: { equals: obj.id } }, limit: 1, depth: 0, overrideAccess: true })
      if (exists.totalDocs) return 'ignored'
      const paidAt = new Date(((obj.status_transitions?.paid_at as number) ?? (obj.created as number) ?? Date.now() / 1000) * 1000).toISOString()
      const share = (amount: number) => (m.amount > 0 ? Math.round((amount * obj.amount_paid) / m.amount) : 0)
      const pledges = (m.pledges ?? []).map((p: Doc) => ({ category: idOf(p.category), amount: share(p.amount) }))
      let payment: Doc
      try {
        payment = (await payload.create({
          collection: o.payments as CollectionSlug,
          data: { membership: m.id, user: idOf(m.user), amount: obj.amount_paid, currency: obj.currency ?? m.currency, paidAt, invoiceId: obj.id, tier: idOf(m.tier), pledges, ...(o.scopeField && m[o.scopeField] ? { [o.scopeField]: idOf(m[o.scopeField]) } : {}) } as never,
          overrideAccess: true,
          context: ctx,
        })) as Doc
      } catch {
        return 'ignored' // the same invoice arrived twice at once (unique invoiceId)
      }
      const periodEnd = obj.lines?.data?.[0]?.period?.end as number | undefined
      const updated = await setMembership(payload, o, m, {
        status: 'active',
        totalPaid: (m.totalPaid ?? 0) + obj.amount_paid,
        ...(periodEnd ? { currentPeriodEnd: new Date(periodEnd * 1000).toISOString() } : {}),
      })
      if (o.onPayment)
        await o.onPayment({
          payload,
          membership: recordOf(updated),
          payment: { id: String(payment.id), membership: String(m.id), user: String(idOf(m.user)), amount: obj.amount_paid, currency: payment.currency, paidAt, invoiceId: obj.id, pledges: pledges as never, tier: idOf(m.tier) },
        })
      return 'handled'
    }
    case 'invoice.payment_failed': {
      const subId = subscriptionIdOf(obj)
      const m = subId ? await findBy(payload, o, { 'stripe.subscription': { equals: subId } }) : undefined
      if (!m) return 'ignored'
      await setMembership(payload, o, m, { status: 'past_due' })
      return 'handled'
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = obj as unknown as StripeSubscription
      const m = (await findBy(payload, o, { 'stripe.subscription': { equals: sub.id } })) ?? (sub.metadata?.membership ? await findBy(payload, o, { id: { equals: sub.metadata.membership } }) : undefined)
      if (!m) return 'ignored'
      const status = event.type === 'customer.subscription.deleted' ? 'canceled' : statusFrom(sub.status)
      const end = periodEndOf(sub as unknown as Doc)
      await setMembership(payload, o, m, {
        status,
        cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
        ...(end ? { currentPeriodEnd: new Date(end * 1000).toISOString() } : {}),
        ...(status === 'canceled' ? { canceledAt: new Date().toISOString() } : {}),
      })
      return 'handled'
    }
    default:
      return 'ignored'
  }
}

export type Backer = { name: string; since: string | null }
export type BackerGroup<T> = { group: T; backers: Backer[] }

/**
 * The backers wall: active members who chose to be shown, under their tier or
 * under each category they support, A–Z within each (user decision for
 * Captive Origins). Groups follow the admin's (drag-and-drop) order.
 */
export async function getBackers(payload: Payload, opts: { scope?: string | null; locale?: string } = {}): Promise<{ tiers: BackerGroup<Doc>[]; categories: BackerGroup<Doc>[] }> {
  const o = membershipOf(payload)
  const scoped = (w: Where[]): Where => ({ and: [...w, ...(o.scopeField && opts.scope ? [{ [o.scopeField]: { equals: opts.scope } }] : [])] })
  const read = { depth: 0, pagination: false as const, overrideAccess: true, locale: opts.locale as never }
  const [members, tiers, categories] = await Promise.all([
    payload.find({ collection: o.memberships as CollectionSlug, where: scoped([{ status: { equals: 'active' } }, { 'wall.show': { equals: true } }]), select: { kind: true, tier: true, pledges: true, wall: true, startedAt: true } as never, ...read }),
    payload.find({ collection: o.tiers as CollectionSlug, where: scoped([]), sort: '_order', select: { name: true, description: true, color: true } as never, ...read }),
    payload.find({ collection: o.categories as CollectionSlug, where: scoped([]), sort: '_order', select: { name: true, description: true, color: true, parent: true } as never, ...read }),
  ])
  const byTier = new Map<string, Backer[]>()
  const byCategory = new Map<string, Backer[]>()
  const add = (map: Map<string, Backer[]>, key: string | null, b: Backer) => key && map.set(key, [...(map.get(key) ?? []), b])
  for (const m of members.docs as Doc[]) {
    const name = String(m.wall?.name ?? '').trim()
    if (!name) continue
    const b: Backer = { name, since: m.startedAt ?? null }
    if (m.kind === 'tier') add(byTier, idOf(m.tier), b)
    else for (const p of m.pledges ?? []) add(byCategory, idOf(p.category), b)
  }
  const az = (list: Backer[]) => [...list].sort((a, b) => a.name.localeCompare(b.name, opts.locale ?? 'en', { sensitivity: 'base' }))
  return {
    tiers: (tiers.docs as Doc[]).map((t) => ({ group: t, backers: az(byTier.get(String(t.id)) ?? []) })).filter((g) => g.backers.length),
    categories: (categories.docs as Doc[]).map((c) => ({ group: c, backers: az(byCategory.get(String(c.id)) ?? []) })).filter((g) => g.backers.length),
  }
}

/** The signed-in member's current membership in a scope (for account pages). */
export async function myMembership(payload: Payload, userId: string, scope: string | null = null): Promise<Doc | null> {
  const o = membershipOf(payload)
  const where: Where = { and: [{ user: { equals: userId } }, { status: { not_equals: 'pending' } }, ...(o.scopeField && scope ? [{ [o.scopeField]: { equals: scope } }] : [])] }
  return ((await payload.find({ collection: o.memberships as CollectionSlug, where, sort: '-createdAt', limit: 1, depth: 1, overrideAccess: true })).docs[0] as Doc) ?? null
}
