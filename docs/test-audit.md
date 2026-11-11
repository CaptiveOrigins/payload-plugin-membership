# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md`, "Test self-audits". Newest first.

## 2026-11-10: the two gaps left for the lead

Suite before: 19 tests. After: 36. The fake Stripe moved to `test/fake-stripe.ts` so all three files share it. `@payloadcms/plugin-multi-tenant` is an exact-pinned devDependency at 3.92.1, the same as `payload`. No real Stripe calls.

| Promise | Test |
| --- | --- |
| With `scopeField` under the real tenant plugin, every Membership collection gets the `tenant` field, and memberships and payments are stored on the site they were bought on | `multi-tenant.test.ts > set-up…` |
| Local API (`overrideAccess: false`): a site's manager reads, changes, deletes or moves only their own site's memberships and payments; a member reads only their own | `multi-tenant.test.ts > the Local API…` |
| REST through `handleEndpoints`: lists, reads, writes and deletes stay on the caller's site; signed-out reads refused | `multi-tenant.test.ts > REST…` |
| Member endpoints (change, cancel, portal, wall) refuse another site's manager from either site, and a member's own membership asked for from another or an unknown site, without calling Stripe; the owner and their own site's manager still get through | `multi-tenant.test.ts > member endpoints…` |
| Checkout refuses another site's tiers and categories, and an unknown site, creating nothing | `multi-tenant.test.ts > member endpoints > checkout refuses…` |
| The backers wall lists only the asked site | `multi-tenant.test.ts > the backers wall…` |
| Under the tenant plugin, each paid invoice is recorded on its first delivery | `multi-tenant.test.ts > payments under the tenant plugin…` |
| The same signed `invoice.paid` delivered 2 or 4 times at once (`Promise.all`, REST, replica set): one payment, one `totalPaid`, one period, one `onPayment`, one status change; a later retry changes nothing | `webhook-race.test.ts > counts one payment…`, `> holds with four copies…` |
| A payment that fails to save for any reason other than a repeat answers 500, so Stripe retries, and the retry counts it once | `webhook-race.test.ts > a payment that fails to save…` |

### Bugs found and fixed

- **Member endpoints crossed sites.** `ownMembership` let any `canManage` user act on any membership, and ignored `scopeOf`. A manager of site A could cancel, change, open the portal for, or edit the wall entry of a site B member. Now, with `scopeField` and `scopeOf`, a membership from another site, or asked for from a site `scopeOf` returns null for, is a 404. Managers also need the collection's read access (`overrideAccess: false`), so the tenant plugin's rules apply.
- **A failed payment save was dropped.** The catch around the payment create returned `ignored` for any error, so Stripe got a 200 and never retried. Now it returns `ignored` only if the invoice is already recorded, and rethrows otherwise (500, and Stripe retries).
- **Payments under the tenant plugin failed about half the time.** Inside a Mongo transaction, the tenant plugin's relationship checks run in parallel, and Mongo aborts them (`TransientTransactionError` on `tier`). Together with the bug above, this silently lost the payment. The payment create now runs without a transaction (`disableTransaction: true`). It is one document, and the unique `invoiceId` index still keeps it to one.

The race itself was not a bug: the unique `invoiceId` index already kept it to one. No schema or index changes.

Mutation checks (back up, string replace, run, restore byte for byte): the site check removed, unknown sites allowed, managers skipping collection access, the failed save swallowed again, and the unique `invoiceId` removed were each caught on every run. Putting the transaction back was caught 5 times in 5 runs after the ten-invoice test was added, and 2 in 6 before it.

### Gaps skipped (and why)

- Anonymous reads of tiers and categories still list every site. They're public catalog data with Stripe ids hidden, and the host filters by site. This is the tenant plugin's behavior for signed-out readers, not member data.
- `startCheckout` reuses the member's newest Stripe customer from any site. It is the same person and the same Stripe account, so nobody else's data is involved. Left as is.
- Two *different* invoices for one membership at the same moment could each read `totalPaid` before the other writes it. The payments ledger stays correct, but the running total could lag. This is not the same-invoice race asked about. It's on the lead's list below.

### For the lead

- `totalPaid` is read-modify-write. Two different invoices paid at the same moment could lose one addition, though the ledger keeps both. An atomic `$inc`, or summing the ledger, would close it.

## 2026-11-10: first audit

Suite before: 10 tests. After: 19. Sources: the README, the option docs in `src/types.ts` and the comments in `src/api.ts`, `src/endpoints.ts` and `src/collections.ts`. There is no `docs/decisions.md`. Stripe is a recording fake throughout; no real Stripe calls.

| Promise | Test |
| --- | --- |
| Tier checkout as a Stripe subscription at the tier's price; pending until Stripe confirms | `checkout > starts a tier membership…` |
| Pledges: minimums (×12 yearly, at least 0.50), each category once, at least one | `checkout > validates pledges…`, `access and refusals > refuses closed or unpriced tiers…` |
| Closed tiers, a missing interval price, bad intervals and inactive categories refused | `access and refusals > refuses closed or unpriced tiers…` |
| `canCheckout` switches checkout off | `access and refusals > refuses closed or unpriced tiers…` |
| One Stripe product per tier and category, reused | `checkout > reuses each Stripe product…` |
| One running membership per member | `webhooks > allows one running membership…` |
| Change swaps the subscription items, from the next invoice; only a running membership | `webhooks > allows one running membership…`, `access and refusals > only a running membership…` |
| Cancel at the end of the paid period, then canceled by Stripe | `webhooks > cancels at period end…` |
| Every paid invoice recorded once; `onPayment` once; free invoices and unknown subscriptions ignored | `webhooks > activates on checkout…`, `access and refusals > ignores free invoices…` |
| Pledge payments split across categories; newer invoice shape | `webhooks > splits a pledge payment…` |
| `onStatusChange` on status changes | `webhooks > activates on checkout…`, `webhooks > cancels at period end…` |
| Webhook: signature checked; refused when not configured | `webhook endpoint > refuses unsigned events…`, `access and refusals > ignores free invoices…` |
| Member endpoints: signed in; own membership or a manager's; others get 404 | `access and refusals > member endpoints refuse anyone but the owner…` |
| Return links stay on this site | `access and refusals > return links stay on this site` |
| Backers wall: opt-in, with the member's chosen name (max 80), active only, A–Z under tier or each category | `backers wall and privacy > lists opted-in…`, `access and refusals > the wall endpoint…`, `access and refusals > the backers wall leaves out…` |
| Members read only their own memberships and payments, never Stripe references; anonymous reads refused | `backers wall and privacy > members read only their own…`, `access and refusals > nobody creates memberships or payments…` |
| Tiers and categories: public read, manager-only writes, Stripe product ids hidden from the public | `access and refusals > tiers and categories…` |
| Nobody creates memberships or payments directly; payments can't be edited; members can't edit memberships | `access and refusals > nobody creates memberships or payments…` |

### Gaps added

- Endpoint access: checkout signed out (401); change, cancel, portal and wall for signed-out people and other members (404); a manager can open the portal.
- Open-redirect guard: `//host` and absolute URLs fall back to `/` for success, cancel and portal return links.
- Wall endpoint: no name means not shown; names capped at 80.
- Checkout refusals: closed tier, no price for the interval, bad interval, inactive category, the 0.50 floor, `canCheckout` off.
- Change refused on a canceled membership.
- Collection access: tiers and categories write refusals and hidden Stripe products; nobody creates memberships or payments; payments can't be edited; members can't edit memberships; payments read own only.
- Webhook: free invoices, unknown subscriptions, not configured (503).
- Backers wall: active but not opted in, and opted in but past due, both left out.

### Gaps skipped (and why)

- `currency`, `publicURL`, `slugs`, `users` and `overrides`: value pass-through, and the defaults are already exercised.
- Payload's own access enforcement and Stripe's signature maths: framework and vendor internals; the fake checks the plugin passes the signature on.
- The more-than-20-categories refusal: a simple bound next to the tested "each category once".

### For the lead

- Multi-site scoping (`scopeField`, `scopeOf`) is untested. It keeps one site's tiers, memberships and backers out of another's, so it is a data-leak boundary. It needs a second Payload instance configured with a scope field.
- The two-webhooks-at-once race (the unique `invoiceId` catch) is untested. It protects money from being counted twice, and needs concurrent event delivery against a real replica set.
