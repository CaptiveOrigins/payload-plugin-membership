# payload-plugin-membership

Memberships for [Payload](https://payloadcms.com), billed as Stripe subscriptions. Run it like
Patreon, or let members support **categories** with **their own amount** — or both.

- **Tiers** (Patreon-style): fixed monthly and/or yearly prices, perks, colors. Drag-and-drop order.
- **Categories**: things members can choose to support (e.g. "Turtles", "North American turtles"),
  nestable, with a minimum amount and an optional **earmarked** flag (otherwise the category is the
  member's preference). New categories go in A–Z; drag to reorder. Add your own fields to tie them to
  anything (taxa, regions, projects…).
- **Memberships**: one running membership per member (per scope); a tier, or pledges split across
  categories. Monthly or yearly. Members change, cancel (at the end of the paid period) or open Stripe's
  customer portal.
- **Payments ledger**: every paid invoice recorded once (idempotent webhooks). `onPayment` runs once per
  invoice: award perks, votes, credits, receipts.
- **Backers wall**: opt-in only, with the name the member chooses; listed under their tier or under each
  category they support, **A–Z within each group**.
- **Works with** [`@captiveorigins/payload-plugin-sponsor`](https://www.npmjs.com/package/@captiveorigins/payload-plugin-sponsor):
  mark a tier "Members are listed as sponsors" and call `upsertListing`/`retireListing` from `onStatusChange`.

## Install

```bash
npm install @captiveorigins/payload-plugin-membership
```

```ts
import { membershipPlugin } from '@captiveorigins/payload-plugin-membership'

export default buildConfig({
  plugins: [
    membershipPlugin({
      stripeSecretKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_MEMBERSHIP_WEBHOOK_SECRET,
      canManage: ({ req }) => req.user?.role === 'admin',
      onPayment: async ({ payload, payment, membership }) => {
        // e.g. thank the member, grant perks
      },
    }),
  ],
})
```

In Stripe, add a webhook endpoint `https://<your site>/api/memberships/stripe-webhook` for
`checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`,
`customer.subscription.updated` and `customer.subscription.deleted`.

## Endpoints (signed-in members)

| Endpoint | Body | Result |
|---|---|---|
| `POST /api/memberships/checkout` | `{ tier }` or `{ pledges: [{ category, amount }] }`, `interval` (`month`/`year`), `wall?: { show, name }`, `successPath?`, `cancelPath?` | `{ url }` of Stripe Checkout |
| `POST /api/memberships/:id/change` | `{ tier }` or `{ pledges }` | the updated membership (from the next invoice) |
| `POST /api/memberships/:id/cancel` | | cancels at the end of the paid period |
| `POST /api/memberships/:id/portal` | `{ returnPath? }` | `{ url }` of Stripe's customer portal |
| `POST /api/memberships/:id/wall` | `{ show, name }` | the member's backers-wall choice |

Amounts are in cents. Server code can call `startCheckout`, `changeMembership`, `cancelMembership`,
`portalLink`, `myMembership` and `getBackers` directly.

## Options

| Option | Default | |
|---|---|---|
| `slugs` | `membership-tiers`, `membership-categories`, `memberships`, `membership-payments` | |
| `users` | `admin.user` | The members' auth collection |
| `canManage` | nobody | Who manages tiers, categories and memberships in the admin |
| `canCheckout` | always | E.g. off in development |
| `stripeSecretKey` / `stripe` | | Key, or a ready client (tests) |
| `webhookSecret` | | Signing secret of the webhook endpoint |
| `currency` | `usd` | |
| `publicURL` | `serverURL` | Origin for Stripe return links |
| `scopeField` / `scopeOf` | | Multi-site: the owner field (e.g. `tenant`) and how to read it from a request |
| `onPayment` | | Once per paid invoice |
| `onStatusChange` | | When a membership's status changes |
| `overrides` | | Adjust the generated collections |

## License

MIT
