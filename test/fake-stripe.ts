import type { StripeLike } from '../src/index.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * A fake Stripe that records calls and never reaches the network. Events are "signed" when the
 * signature header is `good`; anything else is refused, as a bad signature would be.
 */
export function fakeStripe() {
  const calls: { what: string; params: Doc }[] = []
  const subs = new Map<string, Doc>()
  let n = 0
  const stripe: StripeLike = {
    products: { create: async (params) => (calls.push({ what: 'product', params }), { id: `prod_${++n}` }) },
    checkout: { sessions: { create: async (params) => (calls.push({ what: 'checkout', params }), { id: `cs_${++n}`, url: `https://checkout.example/${n}` }) } },
    billingPortal: { sessions: { create: async (params) => (calls.push({ what: 'portal', params }), { url: `https://portal.example/${String(params.customer)}` }) } },
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
  const event = (type: string, object: Doc) => ({ id: `evt_${++n}`, type, data: { object } })
  return { stripe, calls, subs, event }
}
