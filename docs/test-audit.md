# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md`, "Test self-audits". Newest first.

## 2026-11-11: a throw from `scopeOf` is no site

Suite: 43 tests before, 45 after. Closes the gap the entry below left for the lead.

- **The gap.** In the member endpoints (change, cancel, portal, wall), a throw from the host's `scopeOf` escaped as a 500. In checkout it became a 500 through the catch-all.
- **The change.** `siteOf` in `src/endpoints.ts` calls `scopeOf`; a throw or rejection counts as no site, so the member endpoints answer 404 "Not found." (as for an unknown site, which doesn't reveal that the membership exists) and checkout refuses as it does for an unknown site. Only the error's name is logged, never its message.
- **Tests.** `multi-tenant.test.ts > member endpoints > treat a throw or rejection from scopeOf as no site…` (owner and manager, all four actions, a throwing and a rejecting `scopeOf`: 404 each, no Stripe call, membership unchanged, the log has the error's name and none of its message) and `> checkout treats a throw from scopeOf as no site…` (4xx, nothing created, no Stripe checkout).
- **Mutation checks.** 4 mutations, restored byte for byte (SHA-256): member endpoints calling `scopeOf` directly, checkout calling it directly, `siteOf` rethrowing, and logging the message instead of the name. All 4 fail the suite.

## 2026-11-11: only an exact `true` passes, everywhere

Suite: 40 tests before, 43 after (`npx vitest run`, real Payload, in-memory MongoDB, fake Stripe). Prompted by an access-control sweep across the plugins; the fix follows payload-plugin-sponsors.

- **The gap.** Every manager check was `Boolean(req.user) && await canManage(...)`, which handed `canManage`'s answer straight to Payload as collection and field access (tiers, categories, memberships and payments writes; `stripeProduct`, `stripe` and `notes`). An object answer is read by Payload as a query, and a truthy value like `1` as a yes. Memberships' and payments' `ownOrManager`, the member endpoints' manager check and `canCheckout` all accepted any truthy answer. A throw from `canManage` in the member endpoints escaped as a 500.
- **The change.** One helper, `src/access.ts`: `exactlyTrue` (only `true` passes; a throw or rejection is `false`), `isManager` (signed in, and `canManage` answered exactly `true`) and `checkoutAllowed` (no `canCheckout`, or exactly `true`). Every check uses them. Members' reads still get the plugin's own `{ user: { equals: id } }` query.
- **Tests.** "only an exact yes from canManage or canCheckout": each of `1`, `'yes'`, `{}`, a query-shaped object (`{ user: { exists: true } }`, which matches every row), a thrown error and a rejected promise, then `true`. Collection and field access (no writes, no `stripeProduct`, `stripe` or `notes`, a member reads only their own rows and a manager none, nothing changed; signed out is a no even with `true`). Member endpoints (404 for each, never a 500, no Stripe call; with `true`, 200). Checkout (503 "not available", never a 500, no Stripe call, no membership created; with `true`, 200).
- **Mutation checks.** 15 mutations, each a Python string replace on the file, restored byte for byte (checked by SHA-256). All 15 fail the suite: truthy passing in `exactlyTrue`; errors rethrown; `isManager` without its sign-in check; truthy `canCheckout` passing; the old truthy check put back at each of the four `manager`, three `managerField` and two `ownOrManager` guards, the member endpoints and `startCheckout`.
- **Skipped.** Access set by a host through `overrides` is the host's own rule. A throw from `scopeOf` in the member endpoints still escapes as a 500; it's a site lookup, not an access answer, and is left for the lead.

## 2026-11-10: the two gaps left for the lead

Suite before: 19 tests. After: 40. The fake Stripe moved to `test/fake-stripe.ts` so all three files share it. `@payloadcms/plugin-multi-tenant` is an exact-pinned devDependency at 3.92.1, the same as `payload`. No real Stripe calls.

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

### Later the same day: two different invoices at once

- **Fixed:** `totalPaid` was read-modify-write. With two different invoices paid at once, one delivery lost a Mongo write conflict and got a 500. Its payment was already recorded, so Stripe's retry was ignored, and the total, period and `onPayment` for that invoice never landed. Now `invoice.paid` adds with `$inc` through `payload.db.updateOne`, outside a transaction. Only the delivery whose conditional write flips the status fires `onStatusChange`. Test: `webhook-race.test.ts > two different invoices paid at once…` (five rounds; total 1200, both `onPayment`, one status change). Mutations caught 2 of 2: a plain set instead of `$inc`, and an unconditional status write.
- **Fixed, same day:** `payload.update` saves the whole document, `totalPaid` included, so any other save (a subscription or checkout event, cancel, a staff edit or a hook) could write back an older total. The window is the moment between that save reading the document and writing it. Now a field `beforeChange` hook drops `totalPaid` from every update (it is 0 on create), and field access refuses API and admin writes. Only `invoice.paid`'s `$inc` changes it. Tests: `webhook-race.test.ts > a whole-document write held across an invoice…` (deterministic: a staff save without a transaction is held while an invoice lands) and `> only invoice.paid changes totalPaid…`. A third test sends subscription events and staff edits at the same moment as invoices (8 rounds). It passed before the fix too, because on a Mongo replica set the transaction turns the stale write into a write conflict. The held test is what proves the fix. Mutation: keeping `totalPaid` in saves was caught by 2 tests. Removing the field access was not caught, because the hook already drops the value; the access rule is a second guard.

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
