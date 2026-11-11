import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, handleEndpoints, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { membershipPlugin, startCheckout, type PaymentRecord } from '../src/index.js'
import { fakeStripe } from './fake-stripe.js'

// The same Stripe invoice webhook delivered more than once at the same moment, through Payload's
// own REST routing, against a real (in-memory) replica set. Made-up people, a fake Stripe.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const KEY = 'membership-webhook-race'
let mongo: MongoMemoryReplSet
let payload: Payload
const { stripe, subs, event } = fakeStripe()
/** onPayment is where a site awards perks and sends its receipt email: it must run once per invoice. */
const paid: PaymentRecord[] = []
const statusChanges: string[] = []
/** Makes the next payment write fail, as a database outage would. */
let failNextPaymentWrite = false

async function deliver(e: Doc, signature = 'good') {
  const request = new Request('https://members.example.com/api/memberships/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': signature, 'content-type': 'application/json' }, body: JSON.stringify(e) })
  const res = await handleEndpoints({ config: Promise.resolve(payload.config), payloadInstanceCacheKey: KEY, request } as never)
  return { status: res.status, body: (await res.json()) as Doc }
}
const get = (id: unknown) => payload.findByID({ collection: 'memberships' as never, id: id as string, depth: 0 }) as Promise<Doc>
const paymentsFor = async (invoiceId: string) => (await payload.count({ collection: 'membership-payments' as never, where: { invoiceId: { equals: invoiceId } } })).totalDocs

let seq = 0
/** A member with a checked-out membership; Stripe's subscription starts `incomplete` until the first invoice is paid. */
async function member() {
  const n = ++seq
  const user = (await payload.create({ collection: 'users', data: { email: `racer-${n}@example.com`, password: 'a-made-up-test-password' } as never })) as Doc
  const { membership } = await startCheckout(payload, { user, tier: tierId, interval: 'month', successURL: 'https://members.example.com/', cancelURL: 'https://members.example.com/' })
  const sub = `sub_race_${n}`
  subs.set(sub, { id: sub, status: 'incomplete', customer: `cus_race_${n}`, items: { data: [{ id: `si_${sub}`, current_period_end: 1_900_000_000 }] }, metadata: { membership } })
  expect((await deliver(event('checkout.session.completed', { mode: 'subscription', metadata: { membership }, subscription: sub, customer: `cus_race_${n}` }))).body.result).toBe('handled')
  expect(await get(membership)).toMatchObject({ status: 'incomplete', totalPaid: 0 })
  return { membership, sub }
}
const invoice = (id: string, sub: string, periodEnd: number) =>
  event('invoice.paid', { id, subscription: sub, amount_paid: 500, currency: 'usd', status_transitions: { paid_at: 1_800_000_000 }, lines: { data: [{ period: { end: periodEnd } }] } })

let tierId: string

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({
    key: KEY,
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      serverURL: 'https://members.example.com',
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('membership-webhook-race'), ensureIndexes: true }),
      collections: [{ slug: 'users', auth: true, fields: [{ name: 'name', type: 'text' }] }],
      admin: { user: 'users' },
      plugins: [
        membershipPlugin({
          stripe,
          webhookSecret: 'whsec_test',
          onPayment: ({ payment }) => void paid.push(payment),
          onStatusChange: ({ membership, previous }) => void statusChanges.push(`${membership.id}:${previous}→${membership.status}`),
          overrides: {
            payments: (c) => ({
              ...c,
              hooks: {
                ...c.hooks,
                beforeChange: [
                  ...(c.hooks?.beforeChange ?? []),
                  ({ data }) => {
                    if (!failNextPaymentWrite) return data
                    failNextPaymentWrite = false
                    throw new Error('Made-up database outage')
                  },
                ],
              },
            }),
          },
        }),
      ],
    }),
  })
  // Collections and indexes exist before the first write, as on a running site.
  const models = (payload.db as unknown as { collections: Record<string, { createCollection: () => Promise<unknown>; ensureIndexes: () => Promise<unknown> }> }).collections
  for (const m of Object.values(models)) await m.createCollection().catch(() => undefined)
  for (const m of Object.values(models)) await m.ensureIndexes()
  tierId = String((await payload.create({ collection: 'membership-tiers' as never, data: { name: 'Friend', monthly: 500 } as never })).id)
}, 180_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

describe('the same invoice webhook arriving twice at once', () => {
  /**
   * Delivers copies at once. Exactly one is handled; each other copy is either acknowledged as a
   * repeat (200, ignored) or refused for Stripe to retry (500), never counted. A retry afterwards
   * is acknowledged and changes nothing.
   */
  async function race(copies: number) {
    const { membership, sub } = await member()
    const id = `in_race_${seq}`
    const e = invoice(id, sub, 1_802_592_000)
    const before = { paid: paid.length, changes: statusChanges.length }
    const results = await Promise.all(Array.from({ length: copies }, () => deliver(e)))
    const handled = results.filter((r) => r.status === 200 && r.body.result === 'handled')
    const others = results.filter((r) => !handled.includes(r))
    expect(handled, JSON.stringify(results)).toHaveLength(1)
    for (const r of others) expect(r.status === 200 ? r.body.result : r.status, JSON.stringify(r.body)).toMatch(/^(ignored|500)$/)
    expect((await deliver(e)).body.result).toBe('ignored') // Stripe's later retry
    const m = await get(membership)
    expect(await paymentsFor(id)).toBe(1)
    expect(m).toMatchObject({ status: 'active', totalPaid: 500, currentPeriodEnd: new Date(1_802_592_000 * 1000).toISOString() })
    expect(paid.slice(before.paid).map((p) => p.invoiceId)).toEqual([id])
    expect(statusChanges.slice(before.changes)).toEqual([`${membership}:incomplete→active`])
    return membership
  }

  it('counts one payment, one period and one onPayment for two identical signed events', async () => {
    for (let round = 0; round < 5; round++) await race(2)
  })

  it('holds with four copies at once, and the next month’s invoice still counts', async () => {
    const membership = await race(4)
    const sub = `sub_race_${seq}`
    const next = invoice(`in_race_${seq}_next`, sub, 1_805_184_000)
    const results = await Promise.all([deliver(next), deliver(next)])
    expect(results.filter((r) => r.body.result === 'handled')).toHaveLength(1)
    expect(await get(membership)).toMatchObject({ totalPaid: 1000, currentPeriodEnd: new Date(1_805_184_000 * 1000).toISOString() })
  })

  it('two different invoices paid at once both count toward totalPaid', async () => {
    for (let round = 0; round < 5; round++) {
      const { membership, sub } = await member()
      const before = paid.length
      const changes = statusChanges.length
      const e1 = event('invoice.paid', { id: `in_pair_${seq}_1`, subscription: sub, amount_paid: 500, currency: 'usd', created: 1_800_000_000 })
      const e2 = event('invoice.paid', { id: `in_pair_${seq}_2`, subscription: sub, amount_paid: 700, currency: 'usd', created: 1_800_000_001 })
      const results = await Promise.all([deliver(e1), deliver(e2)])
      expect(results.map((r) => r.body.result), JSON.stringify(results)).toEqual(['handled', 'handled'])
      expect((await get(membership)).totalPaid).toBe(1200)
      expect(paid.slice(before).map((p) => p.amount).sort()).toEqual([500, 700])
      expect(statusChanges.slice(changes)).toEqual([`${membership}:incomplete→active`])
    }
  })

  it('a payment that fails to save for another reason is refused for Stripe to retry, not dropped', async () => {
    const { membership, sub } = await member()
    const e = invoice(`in_outage_${seq}`, sub, 1_802_592_000)
    const before = paid.length
    failNextPaymentWrite = true
    const first = await deliver(e)
    expect(first.status).toBe(500)
    expect([await paymentsFor(`in_outage_${seq}`), paid.length - before, (await get(membership)).totalPaid]).toEqual([0, 0, 0])
    expect((await deliver(e)).body.result).toBe('handled') // Stripe's retry
    expect([await paymentsFor(`in_outage_${seq}`), paid.length - before, (await get(membership)).totalPaid]).toEqual([1, 1, 500])
  })

  it('refuses an unsigned copy outright', async () => {
    const { sub } = await member()
    const e = invoice(`in_unsigned_${seq}`, sub, 1_802_592_000)
    expect((await deliver(e, 'forged')).status).toBe(400)
    expect(await paymentsFor(`in_unsigned_${seq}`)).toBe(0)
  })
})
