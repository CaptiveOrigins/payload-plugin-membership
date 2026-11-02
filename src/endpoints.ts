import type { CollectionSlug, Endpoint, PayloadRequest } from 'payload'

import { cancelMembership, changeMembership, handleStripeEvent, membershipOf, portalLink, startCheckout } from './api.js'

const json = (body: unknown, status = 200) => Response.json(body, { status })
const fail = (err: unknown) => {
  const e = err as { status?: number; message?: string; isPublic?: boolean }
  return json({ error: e.isPublic || (e.status && e.status < 500) ? e.message : 'Something went wrong.' }, e.status && e.status >= 400 ? e.status : 500)
}
const body = async (req: PayloadRequest): Promise<Record<string, any>> => (req.json ? ((await req.json().catch(() => ({}))) as Record<string, any>) : {}) // eslint-disable-line @typescript-eslint/no-explicit-any
const origin = (req: PayloadRequest) => membershipOf(req.payload).publicURL ?? req.payload.config.serverURL ?? new URL(req.url ?? 'http://localhost').origin
/** Same-site paths only. */
const path = (p: unknown, fallback: string) => (typeof p === 'string' && /^\/(?!\/)/.test(p) ? p : fallback)

/** The member's own membership, or any for managers. */
async function ownMembership(req: PayloadRequest) {
  const o = membershipOf(req.payload)
  if (!req.user) return null
  const id = String(req.routeParams?.id ?? '')
  const m = await req.payload.findByID({ collection: o.memberships as CollectionSlug, id, depth: 0, overrideAccess: true, disableErrors: true })
  if (!m) return null
  const owner = String(typeof m.user === 'object' ? (m.user as { id: unknown }).id : m.user)
  return owner === String(req.user.id) || (await o.canManage({ req })) ? m : null
}

/** POST /api/<memberships>/checkout { tier? | pledges?, interval, wall?, successPath?, cancelPath? } → { url } */
export const checkoutEndpoint: Endpoint = {
  path: '/checkout',
  method: 'post',
  handler: async (req) => {
    if (!req.user) return json({ error: 'Sign in first.' }, 401)
    try {
      const o = membershipOf(req.payload)
      const b = await body(req)
      const base = origin(req)
      const result = await startCheckout(req.payload, {
        user: req.user as never,
        tier: b.tier ?? null,
        pledges: Array.isArray(b.pledges) ? b.pledges : null,
        interval: b.interval,
        wall: b.wall,
        scope: o.scopeOf ? await o.scopeOf(req) : null,
        successURL: `${base}${path(b.successPath, '/')}`,
        cancelURL: `${base}${path(b.cancelPath, '/')}`,
      })
      return json(result)
    } catch (err) {
      return fail(err)
    }
  },
}

/** POST /api/<memberships>/:id/change { tier? | pledges? } */
export const changeEndpoint: Endpoint = {
  path: '/:id/change',
  method: 'post',
  handler: async (req) => {
    const m = await ownMembership(req)
    if (!m) return json({ error: 'Not found.' }, 404)
    try {
      const b = await body(req)
      return json({ membership: await changeMembership(req.payload, String(m.id), { tier: b.tier ?? null, pledges: Array.isArray(b.pledges) ? b.pledges : null }) })
    } catch (err) {
      return fail(err)
    }
  },
}

/** POST /api/<memberships>/:id/cancel: ends at the close of the paid period. */
export const cancelEndpoint: Endpoint = {
  path: '/:id/cancel',
  method: 'post',
  handler: async (req) => {
    const m = await ownMembership(req)
    if (!m) return json({ error: 'Not found.' }, 404)
    try {
      return json({ membership: await cancelMembership(req.payload, String(m.id)) })
    } catch (err) {
      return fail(err)
    }
  },
}

/** POST /api/<memberships>/:id/portal { returnPath? } → { url } (Stripe customer portal). */
export const portalEndpoint: Endpoint = {
  path: '/:id/portal',
  method: 'post',
  handler: async (req) => {
    const m = await ownMembership(req)
    if (!m) return json({ error: 'Not found.' }, 404)
    try {
      const b = await body(req)
      return json({ url: await portalLink(req.payload, String(m.id), `${origin(req)}${path(b.returnPath, '/')}`) })
    } catch (err) {
      return fail(err)
    }
  },
}

/** POST /api/<memberships>/:id/wall { show, name }: the member's own choice for the backers wall. */
export const wallEndpoint: Endpoint = {
  path: '/:id/wall',
  method: 'post',
  handler: async (req) => {
    const m = await ownMembership(req)
    if (!m) return json({ error: 'Not found.' }, 404)
    const b = await body(req)
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 80) : ''
    const updated = await req.payload.update({
      collection: membershipOf(req.payload).memberships as CollectionSlug,
      id: m.id,
      data: { wall: { show: Boolean(b.show) && Boolean(name), name: name || null } } as never,
      overrideAccess: true,
      context: { membershipSync: true },
    })
    return json({ wall: (updated as { wall?: unknown }).wall })
  },
}

/** POST /api/<memberships>/stripe-webhook: Stripe events, verified with the endpoint's signing secret. */
export const webhookEndpoint: Endpoint = {
  path: '/stripe-webhook',
  method: 'post',
  handler: async (req) => {
    const o = membershipOf(req.payload)
    const stripe = o.stripe()
    if (!stripe || !o.webhookSecret) return json({ error: 'Not configured.' }, 503)
    const signature = req.headers.get('stripe-signature')
    const raw = req.text ? await req.text() : ''
    let event
    try {
      event = stripe.webhooks.constructEvent(raw, signature ?? '', o.webhookSecret)
    } catch {
      return json({ error: 'Invalid signature.' }, 400)
    }
    try {
      return json({ received: true, result: await handleStripeEvent(req.payload, event) })
    } catch (err) {
      req.payload.logger.error({ err, event: event.type }, 'Membership webhook failed')
      return json({ error: 'Failed.' }, 500) // Stripe retries
    }
  },
}
