# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md`, "Test self-audits". Newest first.

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
