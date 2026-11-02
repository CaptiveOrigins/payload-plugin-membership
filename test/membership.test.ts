import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { webhookEndpoint } from '../src/endpoints.js'
import { cancelMembership, changeMembership, getBackers, handleStripeEvent, membershipPlugin, myMembership, startCheckout, type PaymentRecord, type StripeLike } from '../src/index.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
let payload: Payload
let mongo: MongoMemoryReplSet

// A fake Stripe that records calls.
const calls: { what: string; params: Doc }[] = []
let n = 0
const subs = new Map<string, Doc>()
const stripe: StripeLike = {
  products: { create: async (params) => (calls.push({ what: 'product', params }), { id: `prod_${++n}` }) },
  checkout: { sessions: { create: async (params) => (calls.push({ what: 'checkout', params }), { id: `cs_${++n}`, url: `https://checkout.example/${n}` }) } },
  billingPortal: { sessions: { create: async (params) => ({ url: `https://portal.example/${String(params.customer)}` }) } },
  subscriptions: {
    retrieve: async (id) => subs.get(id) as never,
    update: async (id, params) => {
      calls.push({ what: 'update', params: { id, ...params } })
      const s = { ...subs.get(id)!, ...(params.cancel_at_period_end !== undefined ? { cancel_at_period_end: params.cancel_at_period_end } : {}) }
      subs.set(id, s)
      return s as never
    },
  },
  webhooks: {
    constructEvent: (raw, sig) => {
      if (sig !== 'good') throw new Error('bad signature')
      return JSON.parse(raw)
    },
  },
}
const payments: PaymentRecord[] = []
const statusChanges: string[] = []

let alice: Doc
let bob: Doc
let gold: Doc
let friend: Doc
let turtles: Doc
let snakes: Doc
const event = (type: string, object: Doc) => ({ id: `evt_${++n}`, type, data: { object } })

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      serverURL: 'https://example.org',
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('membership'), ensureIndexes: true }),
      collections: [{ slug: 'users', auth: true, fields: [{ name: 'name', type: 'text' }, { name: 'role', type: 'text' }] }],
      admin: { user: 'users' },
      plugins: [
        membershipPlugin({
          stripe,
          webhookSecret: 'whsec_test',
          canManage: ({ req }) => (req.user as Doc | null)?.role === 'admin',
          onPayment: ({ payment }) => void payments.push(payment),
          onStatusChange: ({ membership, previous }) => void statusChanges.push(`${previous}→${membership.status}`),
        }),
      ],
    }),
  })
  const user = (email: string, name: string) => payload.create({ collection: 'users', data: { email, name, password: 'a-long-password' } as never })
  alice = await user('alice@example.org', 'Alice')
  bob = await user('bob@example.org', 'Bob')
  // Created out of order: tiers keep creation order (drag to change), categories go A–Z.
  friend = await payload.create({ collection: 'membership-tiers' as never, data: { name: 'Friend', monthly: 500, yearly: 5000 } as never })
  gold = await payload.create({ collection: 'membership-tiers' as never, data: { name: 'Gold', monthly: 2500 } as never })
  turtles = await payload.create({ collection: 'membership-categories' as never, data: { name: 'Turtles', minimum: 300 } as never })
  snakes = await payload.create({ collection: 'membership-categories' as never, data: { name: 'Snakes', minimum: 100 } as never })
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

const urls = { successURL: 'https://example.org/thanks', cancelURL: 'https://example.org/membership' }

describe('checkout', () => {
  it('starts a tier membership as a Stripe subscription with the tier’s price', async () => {
    const r = await startCheckout(payload, { user: alice, tier: String(friend.id), interval: 'month', wall: { show: true, name: 'Alice A.' }, ...urls })
    expect(r.url).toMatch(/^https:\/\/checkout\.example\//)
    const session = calls.find((c) => c.what === 'checkout')!.params
    expect(session).toMatchObject({ mode: 'subscription', customer_email: 'alice@example.org', metadata: { membership: r.membership } })
    expect(session.line_items).toEqual([{ quantity: 1, price_data: { currency: 'usd', product: expect.stringMatching(/^prod_/), unit_amount: 500, recurring: { interval: 'month' } } }])
    const m = (await payload.findByID({ collection: 'memberships' as never, id: r.membership })) as Doc
    expect(m).toMatchObject({ status: 'pending', kind: 'tier', amount: 500, wall: { show: true, name: 'Alice A.' } })
  })

  it('validates pledges: minimums (×12 yearly), each category once, at least one', async () => {
    const pledge = (pledges: Doc[], interval: 'month' | 'year' = 'month') => startCheckout(payload, { user: bob, pledges: pledges as never, interval, ...urls }).then(() => 'ok', (e: Error) => e.message)
    expect(await pledge([])).toMatch(/at least one/)
    expect(await pledge([{ category: turtles.id, amount: 200 }])).toMatch(/minimum for Turtles is 3\.00/)
    expect(await pledge([{ category: turtles.id, amount: 1000 }], 'year')).toMatch(/minimum for Turtles is 36\.00/)
    expect(await pledge([{ category: turtles.id, amount: 500 }, { category: turtles.id, amount: 500 }])).toMatch(/once/)
  })

  it('reuses each Stripe product (one per tier/category)', async () => {
    await startCheckout(payload, { user: bob, pledges: [{ category: String(turtles.id), amount: 700 }, { category: String(snakes.id), amount: 300 }] as never, interval: 'month', wall: { show: true, name: 'Bob B.' }, ...urls })
    const productNames = calls.filter((c) => c.what === 'product').map((c) => c.params.name)
    expect(productNames.sort()).toEqual(['Friend', 'Snakes', 'Turtles'])
  })
})

describe('webhooks', () => {
  const activate = async (user: Doc, sub: string) => {
    const m = (await payload.find({ collection: 'memberships' as never, where: { user: { equals: user.id } }, sort: '-createdAt' })).docs[0] as Doc
    subs.set(sub, { id: sub, status: 'active', customer: `cus_${user.id}`, items: { data: [{ id: `si_${sub}`, current_period_end: 1_900_000_000 }] }, metadata: { membership: String(m.id) } })
    await handleStripeEvent(payload, event('checkout.session.completed', { mode: 'subscription', metadata: { membership: String(m.id) }, subscription: sub, customer: `cus_${user.id}` }))
    return m
  }

  it('activates on checkout, records each paid invoice once, and calls onPayment once', async () => {
    const m = await activate(alice, 'sub_alice')
    const paid = event('invoice.paid', { id: 'in_1', subscription: 'sub_alice', amount_paid: 500, currency: 'usd', status_transitions: { paid_at: 1_800_000_000 }, lines: { data: [{ period: { end: 1_802_592_000 } }] } })
    expect(await handleStripeEvent(payload, paid)).toBe('handled')
    expect(await handleStripeEvent(payload, paid)).toBe('ignored') // Stripe retries
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({ amount: 500, invoiceId: 'in_1', tier: String(friend.id) })
    const after = (await payload.findByID({ collection: 'memberships' as never, id: m.id })) as Doc
    expect(after).toMatchObject({ status: 'active', totalPaid: 500, stripe: { subscription: 'sub_alice', customer: `cus_${alice.id}` } })
    expect(statusChanges).toContain('pending→active')
  })

  it('splits a pledge payment across its categories (newer invoice shape too)', async () => {
    await activate(bob, 'sub_bob')
    await handleStripeEvent(payload, event('invoice.paid', { id: 'in_2', parent: { subscription_details: { subscription: 'sub_bob' } }, amount_paid: 1000, currency: 'usd', created: 1_800_000_000 }))
    const p = payments.at(-1)!
    expect(p.pledges.map((x) => [x.category, x.amount])).toEqual([
      [String(turtles.id), 700],
      [String(snakes.id), 300],
    ])
  })

  it('allows one running membership per member; changes swap the subscription items', async () => {
    await expect(startCheckout(payload, { user: alice, tier: String(gold.id), interval: 'month', ...urls })).rejects.toThrow(/already have a membership/)
    const m = (await myMembership(payload, String(alice.id)))!
    const changed = await changeMembership(payload, String(m.id), { tier: String(gold.id) })
    expect(changed).toMatchObject({ kind: 'tier', amount: 2500 })
    const update = calls.filter((c) => c.what === 'update').at(-1)!.params
    expect(update.items).toEqual([{ id: 'si_sub_alice', deleted: true }, { quantity: 1, price_data: expect.objectContaining({ unit_amount: 2500 }) }])
  })

  it('cancels at period end, then ends with Stripe', async () => {
    const m = (await myMembership(payload, String(alice.id)))!
    expect(await cancelMembership(payload, String(m.id))).toMatchObject({ cancelAtPeriodEnd: true })
    await handleStripeEvent(payload, event('customer.subscription.deleted', { id: 'sub_alice', status: 'canceled', items: { data: [] } }))
    expect((await payload.findByID({ collection: 'memberships' as never, id: m.id })) as Doc).toMatchObject({ status: 'canceled' })
    expect(statusChanges).toContain('active→canceled')
  })
})

describe('backers wall and privacy', () => {
  it('lists opted-in active backers A–Z under their tier and each category they support', async () => {
    const carol = await payload.create({ collection: 'users', data: { email: 'carol@example.org', password: 'a-long-password' } as never })
    await startCheckout(payload, { user: carol, pledges: [{ category: String(turtles.id), amount: 400 }] as never, interval: 'month', wall: { show: true, name: 'Aaron (Carol)' }, ...urls })
    const m = (await payload.find({ collection: 'memberships' as never, where: { user: { equals: carol.id } } })).docs[0] as Doc
    subs.set('sub_carol', { id: 'sub_carol', status: 'active', customer: 'cus_c', items: { data: [] } })
    await handleStripeEvent(payload, event('checkout.session.completed', { mode: 'subscription', metadata: { membership: String(m.id) }, subscription: 'sub_carol', customer: 'cus_c' }))
    const wall = await getBackers(payload)
    expect(wall.tiers).toEqual([]) // Alice canceled
    expect(wall.categories.map((g) => [g.group.name, g.backers.map((b) => b.name)])).toEqual([
      ['Snakes', ['Bob B.']],
      ['Turtles', ['Aaron (Carol)', 'Bob B.']],
    ])
  })

  it('members read only their own memberships, without Stripe references', async () => {
    const mine = await payload.find({ collection: 'memberships' as never, overrideAccess: false, user: { ...bob, collection: 'users' } })
    expect(mine.docs.every((d: Doc) => String(typeof d.user === 'object' ? d.user.id : d.user) === String(bob.id))).toBe(true)
    expect(JSON.stringify(mine.docs)).not.toContain('sub_bob')
    await expect(payload.find({ collection: 'memberships' as never, overrideAccess: false })).rejects.toThrow()
  })
})

describe('webhook endpoint', () => {
  const call = (signature: string, body: Doc) =>
    webhookEndpoint.handler({ payload, headers: new Headers({ 'stripe-signature': signature }), text: async () => JSON.stringify(body) } as never) as Promise<Response>
  it('refuses unsigned events and applies signed ones', async () => {
    expect((await call('bad', event('invoice.paid', {}))).status).toBe(400)
    const ok = await call('good', event('invoice.payment_failed', { subscription: 'sub_bob' }))
    expect(await ok.json()).toMatchObject({ received: true, result: 'handled' })
    expect((await myMembership(payload, String(bob.id)))).toMatchObject({ status: 'past_due' })
  })
})
