import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, handleEndpoints, type Payload, type PayloadRequest, type Plugin } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { getBackers, membershipPlugin, type PaymentRecord } from '../src/index.js'
import { fakeStripe } from './fake-stripe.js'

// Membership's scopeField with Payload's real multi-tenant plugin adding `tenant` to all four
// collections, and scopeOf reading the site from a made-up header (a host would use the request's
// host name). Made-up sites, example.com people, a fake Stripe.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const COLLECTIONS = ['membership-tiers', 'membership-categories', 'memberships', 'membership-payments']
const KEY = 'membership-multi-tenant'
const PASSWORD = 'a-made-up-test-password'

let mongo: MongoMemoryReplSet
let payload: Payload
const { stripe, calls, subs, event } = fakeStripe()
const payments: PaymentRecord[] = []
/** Site name (as sent in `x-site`) to tenant id. */
const sites = new Map<string, string>()

let siteA: string, siteB: string
let memberA: Doc, memberB: Doc, managerA: Doc, managerB: Doc
let tierA: Doc, tierB: Doc, catA: Doc, catB: Doc
let membershipA: Doc, membershipB: Doc

const tokens = new Map<string, string>()
async function tokenFor(u: Doc) {
  if (!tokens.has(String(u.id))) tokens.set(String(u.id), (await payload.login({ collection: 'users', data: { email: u.email, password: PASSWORD } })).token!)
  return tokens.get(String(u.id))!
}
/** Through Payload's own REST routing, as a browser's request would go, with a real sign-in token. */
async function rest(method: string, path: string, user: Doc | null, opts: { body?: unknown; site?: string; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', ...(opts.site ? { 'x-site': opts.site } : {}), ...opts.headers })
  if (user) headers.set('Authorization', `JWT ${await tokenFor(user)}`)
  const request = new Request(`https://members.example.com/api${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
  const res = await handleEndpoints({ config: Promise.resolve(payload.config), payloadInstanceCacheKey: KEY, request } as never)
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Doc }
}
const as = (u: Doc) => ({ user: { ...u, collection: 'users' } as never, overrideAccess: false as const })
const get = (collection: string, id: unknown) => payload.findByID({ collection: collection as never, id: id as string, depth: 0 }) as Promise<Doc>
const tenantOf = (d: Doc) => String(d.tenant?.id ?? d.tenant)
const webhook = (e: Doc) => rest('POST', '/memberships/stripe-webhook', null, { body: e, headers: { 'stripe-signature': 'good' } })

/** Checks out on a site through REST, then activates and pays the first invoice through the signed webhook. */
async function joinAndPay(member: Doc, site: string, tier: Doc, sub: string, invoice: string) {
  const res = await rest('POST', '/memberships/checkout', member, { site, body: { tier: String(tier.id), interval: 'month', wall: { show: true, name: `${site} backer` } } })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  const id = res.body.membership as string
  subs.set(sub, { id: sub, status: 'active', customer: `cus_${sub}`, items: { data: [{ id: `si_${sub}`, current_period_end: 1_900_000_000 }] }, metadata: { membership: id } })
  expect((await webhook(event('checkout.session.completed', { mode: 'subscription', metadata: { membership: id }, subscription: sub, customer: `cus_${sub}` }))).body.result).toBe('handled')
  expect((await webhook(event('invoice.paid', { id: invoice, subscription: sub, amount_paid: tier.monthly, currency: 'usd', created: 1_800_000_000 }))).body.result).toBe('handled')
  return get('memberships', id)
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({
    key: KEY,
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      serverURL: 'https://members.example.com',
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('membership-multi-tenant'), ensureIndexes: true }),
      collections: [
        { slug: 'tenants', fields: [{ name: 'name', type: 'text' }] },
        { slug: 'users', auth: true, fields: [{ name: 'name', type: 'text' }, { name: 'role', type: 'text' }] },
      ],
      admin: { user: 'users' },
      plugins: [
        membershipPlugin({
          stripe,
          webhookSecret: 'whsec_test',
          scopeField: 'tenant',
          scopeOf: (req: PayloadRequest) => sites.get(req.headers.get('x-site') ?? '') ?? null,
          // Role-based on purpose: the host's canManage need not know about sites.
          canManage: ({ req }) => ['manager', 'admin'].includes(String((req.user as Doc | null)?.role)),
          onPayment: ({ payment }) => void payments.push(payment),
        }),
        // The tenant plugin goes last, as its docs ask.
        multiTenantPlugin({
          collections: Object.fromEntries(COLLECTIONS.map((slug) => [slug, {}])),
          userHasAccessToAllTenants: (user) => (user as Doc).role === 'admin',
        }) as Plugin,
      ],
    }),
  })
  // Collections and indexes exist before the first write, as on a running site (Mongo can't create
  // a collection inside a transaction that another one has open).
  const models = (payload.db as unknown as { collections: Record<string, { createCollection: () => Promise<unknown>; ensureIndexes: () => Promise<unknown> }> }).collections
  for (const m of Object.values(models)) await m.createCollection().catch(() => undefined)
  for (const m of Object.values(models)) await m.ensureIndexes()
  siteA = String((await payload.create({ collection: 'tenants' as never, data: { name: 'Site A' } as never })).id)
  siteB = String((await payload.create({ collection: 'tenants' as never, data: { name: 'Site B' } as never })).id)
  sites.set('a', siteA).set('b', siteB)
  const user = (email: string, site: string, role = 'member') => payload.create({ collection: 'users', data: { email, password: PASSWORD, role, tenants: [{ tenant: site }] } as never }) as Promise<Doc>
  memberA = await user('member-a@example.com', siteA)
  memberB = await user('member-b@example.com', siteB)
  managerA = await user('manager-a@example.com', siteA, 'manager')
  managerB = await user('manager-b@example.com', siteB, 'manager')
  const create = (collection: string, data: Doc) => payload.create({ collection: collection as never, data: data as never, depth: 0 }) as Promise<Doc>
  tierA = await create('membership-tiers', { tenant: siteA, name: 'Friend', monthly: 500 })
  tierB = await create('membership-tiers', { tenant: siteB, name: 'Friend', monthly: 700 })
  catA = await create('membership-categories', { tenant: siteA, name: 'Turtles', minimum: 100 })
  catB = await create('membership-categories', { tenant: siteB, name: 'Snakes', minimum: 100 })
  membershipA = await joinAndPay(memberA, 'a', tierA, 'sub_a', 'in_a1')
  membershipB = await joinAndPay(memberB, 'b', tierB, 'sub_b', 'in_b1')
}, 180_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

describe('set-up under the multi-tenant plugin', () => {
  it('has the tenant plugin’s own `tenant` field on every Membership collection', () => {
    for (const slug of COLLECTIONS) {
      const field = (payload.collections[slug as never]!.config.flattenedFields as Doc[]).find((f) => f.name === 'tenant')
      expect(field, slug).toMatchObject({ type: 'relationship', relationTo: 'tenants' })
    }
  })

  it('stores each membership and payment on the site it was bought on', async () => {
    expect([tenantOf(membershipA), tenantOf(membershipB)]).toEqual([siteA, siteB])
    const pays = (await payload.find({ collection: 'membership-payments' as never, depth: 0, pagination: false })).docs as Doc[]
    expect(pays.map((p) => [p.invoiceId, tenantOf(p)]).sort()).toEqual([
      ['in_a1', siteA],
      ['in_b1', siteB],
    ])
  })
})

describe('the Local API with overrideAccess: false', () => {
  it('a site’s manager reads only that site’s memberships and payments', async () => {
    for (const [manager, site] of [[managerA, siteA], [managerB, siteB]] as const) {
      for (const collection of ['memberships', 'membership-payments']) {
        const found = (await payload.find({ collection: collection as never, depth: 0, pagination: false, ...as(manager) })).docs as Doc[]
        expect(found.length, collection).toBeGreaterThan(0)
        expect(found.every((d) => tenantOf(d) === site), collection).toBe(true)
      }
    }
    await expect(payload.findByID({ collection: 'memberships' as never, id: membershipB.id, ...as(managerA) })).rejects.toThrow()
    const paymentB = ((await payload.find({ collection: 'membership-payments' as never, where: { invoiceId: { equals: 'in_b1' } }, depth: 0 })).docs as Doc[])[0]!
    await expect(payload.findByID({ collection: 'membership-payments' as never, id: paymentB.id, ...as(managerA) })).rejects.toThrow()
  })

  it('a site’s manager can’t change or delete another site’s membership or payment', async () => {
    await expect(payload.update({ collection: 'memberships' as never, id: membershipB.id, data: { notes: 'cross-site', wall: { show: false } } as never, ...as(managerA) })).rejects.toThrow()
    await expect(payload.delete({ collection: 'memberships' as never, id: membershipB.id, ...as(managerA) })).rejects.toThrow()
    // Bulk forms skip what the manager can't see.
    const bulk = await payload.update({ collection: 'memberships' as never, where: { id: { equals: membershipB.id } }, data: { notes: 'cross-site' } as never, ...as(managerA) })
    expect(bulk.docs).toHaveLength(0)
    const paymentB = ((await payload.find({ collection: 'membership-payments' as never, where: { invoiceId: { equals: 'in_b1' } }, depth: 0 })).docs as Doc[])[0]!
    await expect(payload.delete({ collection: 'membership-payments' as never, id: paymentB.id, ...as(managerA) })).rejects.toThrow()
    // Moving a membership to another site is refused too.
    await expect(payload.update({ collection: 'memberships' as never, id: membershipA.id, data: { tenant: siteB } as never, ...as(managerA) })).rejects.toThrow()
    const after = await get('memberships', membershipB.id)
    expect([after.notes ?? null, after.wall.show, tenantOf(await get('memberships', membershipA.id))]).toEqual([null, true, siteA])
    expect(await payload.count({ collection: 'membership-payments' as never, where: { invoiceId: { equals: 'in_b1' } } })).toMatchObject({ totalDocs: 1 })
  })

  it('a member reads only their own, and never another site’s', async () => {
    for (const collection of ['memberships', 'membership-payments']) {
      const mine = (await payload.find({ collection: collection as never, depth: 0, pagination: false, ...as(memberA) })).docs as Doc[]
      expect(mine.length, collection).toBeGreaterThan(0)
      expect(mine.every((d) => String(d.user?.id ?? d.user) === String(memberA.id) && tenantOf(d) === siteA), collection).toBe(true)
    }
    await expect(payload.findByID({ collection: 'memberships' as never, id: membershipB.id, ...as(memberA) })).rejects.toThrow()
  })
})

describe('REST', () => {
  it('lists and reads only the caller’s own site', async () => {
    const list = await rest('GET', '/memberships?depth=0', managerA)
    expect(list.status).toBe(200)
    expect((list.body.docs as Doc[]).map(tenantOf)).toEqual([siteA])
    expect((await rest('GET', `/memberships/${membershipB.id}`, managerA)).status).toBe(404)
    expect((await rest('GET', `/memberships/${membershipB.id}`, memberA)).status).toBe(404)
    const pays = await rest('GET', '/membership-payments?depth=0', managerA)
    expect((pays.body.docs as Doc[]).map((p) => p.invoiceId)).toEqual(['in_a1'])
    expect((await rest('GET', '/membership-payments?depth=0', memberB)).body.docs.map((p: Doc) => p.invoiceId)).toEqual(['in_b1'])
    expect((await rest('GET', '/memberships', null)).status).toBe(403)
  })

  it('refuses another site’s manager writing or deleting', async () => {
    expect((await rest('PATCH', `/memberships/${membershipB.id}`, managerA, { body: { notes: 'cross-site' } })).status).toBeGreaterThanOrEqual(403)
    expect((await rest('DELETE', `/memberships/${membershipB.id}`, managerA)).status).toBeGreaterThanOrEqual(403)
    expect((await rest('PATCH', `/memberships/${membershipB.id}`, memberA, { body: { wall: { show: false } } })).status).toBeGreaterThanOrEqual(403)
    const after = await get('memberships', membershipB.id)
    expect([after.notes ?? null, after.wall.show]).toEqual([null, true])
  })
})

describe('member endpoints', () => {
  const ACTIONS = [
    ['change', { tier: 'x' }],
    ['cancel', {}],
    ['portal', { returnPath: '/account' }],
    ['wall', { show: false, name: 'Changed' }],
  ] as const

  it('refuse another site’s manager, from either site, without touching Stripe', async () => {
    const before = calls.length
    for (const site of ['a', 'b'])
      for (const [action, body] of ACTIONS) {
        const res = await rest('POST', `/memberships/${membershipB.id}/${action}`, managerA, { site, body })
        expect(res.status, `${action} from site ${site}`).toBe(404)
      }
    expect(calls.slice(before)).toEqual([])
    const after = await get('memberships', membershipB.id)
    expect([after.wall, after.cancelAtPeriodEnd ?? false]).toEqual([{ show: true, name: 'b backer' }, false])
  })

  it('refuse a member’s own membership when asked from another site', async () => {
    const before = calls.length
    for (const [action, body] of ACTIONS) {
      expect((await rest('POST', `/memberships/${membershipA.id}/${action}`, memberA, { site: 'b', body })).status, action).toBe(404)
      expect((await rest('POST', `/memberships/${membershipA.id}/${action}`, memberA, { body })).status, `${action} with no site`).toBe(404)
    }
    expect(calls.slice(before)).toEqual([])
  })

  it('still serve the owner and their own site’s manager', async () => {
    const own = await rest('POST', `/memberships/${membershipA.id}/portal`, memberA, { site: 'a', body: { returnPath: '/account' } })
    expect(own).toMatchObject({ status: 200, body: { url: 'https://portal.example/cus_sub_a' } })
    const manager = await rest('POST', `/memberships/${membershipB.id}/portal`, managerB, { site: 'b' })
    expect(manager).toMatchObject({ status: 200, body: { url: 'https://portal.example/cus_sub_b' } })
  })

  it('checkout refuses another site’s tiers and categories, and refuses when the site is unknown', async () => {
    const newcomer = (await payload.create({ collection: 'users', data: { email: 'newcomer@example.com', password: PASSWORD, role: 'member', tenants: [{ tenant: siteA }] } as never })) as Doc
    const count = async () => (await payload.count({ collection: 'memberships' as never, where: { user: { equals: newcomer.id } } })).totalDocs
    const before = calls.length
    const tier = await rest('POST', '/memberships/checkout', newcomer, { site: 'a', body: { tier: String(tierB.id), interval: 'month' } })
    expect(tier).toMatchObject({ status: 400, body: { error: 'That tier isn’t available.' } })
    const pledge = await rest('POST', '/memberships/checkout', newcomer, { site: 'a', body: { pledges: [{ category: String(catA.id), amount: 500 }, { category: String(catB.id), amount: 500 }], interval: 'month' } })
    expect(pledge).toMatchObject({ status: 400, body: { error: 'One of those categories isn’t available.' } })
    const nowhere = await rest('POST', '/memberships/checkout', newcomer, { body: { tier: String(tierA.id), interval: 'month' } })
    expect(nowhere.status).toBeGreaterThanOrEqual(400)
    expect([await count(), calls.slice(before).filter((c) => c.what === 'checkout')]).toEqual([0, []])
  })
})

describe('the backers wall', () => {
  it('lists only the asked site’s backers, tiers and categories', async () => {
    const a = await getBackers(payload, { scope: siteA })
    const b = await getBackers(payload, { scope: siteB })
    expect(a.tiers.map((g) => [String(g.group.id), g.backers.map((x) => x.name)])).toEqual([[String(tierA.id), ['a backer']]])
    expect(b.tiers.map((g) => [String(g.group.id), g.backers.map((x) => x.name)])).toEqual([[String(tierB.id), ['b backer']]])
  })
})

describe('payments under the tenant plugin', () => {
  it('records every paid invoice on its first delivery, so none waits on a Stripe retry', async () => {
    const before = (await get('memberships', membershipA.id)).totalPaid
    for (let i = 2; i <= 11; i++) {
      const res = await webhook(event('invoice.paid', { id: `in_a${i}`, subscription: 'sub_a', amount_paid: 500, currency: 'usd', created: 1_800_000_000 + i }))
      expect(res, `invoice ${i}`).toMatchObject({ status: 200, body: { result: 'handled' } })
    }
    expect((await get('memberships', membershipA.id)).totalPaid).toBe(before + 5000)
    const pays = (await payload.find({ collection: 'membership-payments' as never, where: { user: { equals: memberA.id } }, depth: 0, pagination: false })).docs as Doc[]
    expect(pays.every((p) => tenantOf(p) === siteA)).toBe(true)
  })
})
