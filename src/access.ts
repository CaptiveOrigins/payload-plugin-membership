import type { Payload, PayloadRequest } from 'payload'

import type { ResolvedMembership } from './types.js'

/** Only an answer of exactly `true` passes; anything else, a thrown error included, is no. */
export async function exactlyTrue(check: () => unknown): Promise<boolean> {
  try {
    return (await check()) === true
  } catch {
    return false
  }
}

/** A signed-in manager: `canManage` answered exactly `true` (a truthy value or an error is a no). */
export const isManager = (o: Pick<ResolvedMembership, 'canManage'>, req: PayloadRequest): Promise<boolean> =>
  req.user ? exactlyTrue(() => o.canManage({ req })) : Promise.resolve(false)

/** Checkout is allowed here: no `canCheckout`, or `canCheckout` answered exactly `true`. */
export const checkoutAllowed = (o: Pick<ResolvedMembership, 'canCheckout'>, payload: Payload): Promise<boolean> =>
  o.canCheckout ? exactlyTrue(() => o.canCheckout!({ payload })) : Promise.resolve(true)
