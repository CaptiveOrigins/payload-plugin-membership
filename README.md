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
- **Works with** [`@captiveorigins/payload-plugin-sponsors`](https://www.npmjs.com/package/@captiveorigins/payload-plugin-sponsors):
  mark a tier "Members are listed as sponsors" and call `upsertListing`/`retireListing` from `onStatusChange`.

## On its own, and with others

**On its own.** Membership needs a Stripe account (a secret key and a webhook) and an auth collection for members. It doesn't import any other Captive Origins plugin. Perks, votes and credits are whatever your own `onPayment` and `onStatusChange` do.

**Works with:**

- **Sponsors** (`@captiveorigins/payload-plugin-sponsors`): tick "Members are listed as sponsors" on a tier, and call Sponsors' `upsertListing()` and `retireListing()` from `onStatusChange`. Your site makes the call; neither plugin imports the other.
- **Roadmap** (`@captiveorigins/payload-plugin-roadmap`): Roadmap's extra votes come from a number your site works out (`allocation.earned`), and a membership can be where they come from. There's no adapter for this. It's a few lines of your own code.
- **Multi-tenant** (`@payloadcms/plugin-multi-tenant`): set `scopeField` and `scopeOf`, and each site has its own tiers and members. The member endpoints answer only for the site `scopeOf` names: another site's membership, or a request from a site `scopeOf` doesn't know, gets a 404. Managers also need the collection's read access, so the tenant plugin's rules apply to them. Pass `scope` to `getBackers`, or it lists every site.

**Family.** Membership is in the Patronage family, with Sponsors, Backing, Credits, Printify and Roadmap. Backing and Credits are named but not built yet, and the families are a working draft that may change.

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
| `canManage` | nobody | Who manages tiers, categories and memberships in the admin. Only `true` counts: see [Access](#access) |
| `canCheckout` | always | E.g. off in development. Only `true` allows a checkout |
| `stripeSecretKey` / `stripe` | | Key, or a ready client (tests) |
| `webhookSecret` | | Signing secret of the webhook endpoint |
| `currency` | `usd` | |
| `publicURL` | `serverURL` | Origin for Stripe return links |
| `scopeField` / `scopeOf` | | Multi-site: the owner field (e.g. `tenant`) and how to read it from a request |
| `onPayment` | | Once per paid invoice |
| `onStatusChange` | | When a membership's status changes |
| `overrides` | | Adjust the generated collections |

## Access

`canManage` decides everything a manager can do, and only an answer of exactly `true` counts.
Anything else is a no: `false`, `1`, `'yes'`, an object, or an error thrown or rejected. An error
doesn't escape as a 500; the request is refused. Nobody who isn't signed in is a manager, whatever
`canManage` says.

| Where | A manager | A signed-in member | Signed out |
|---|---|---|---|
| Tiers, categories | Reads, creates, edits, deletes | Reads | Reads |
| Their `stripeProduct` (field) | Reads and writes | Never sees it | Never sees it |
| Memberships | Reads all, edits, deletes | Reads their own | Nothing |
| A membership's `stripe` and `notes` (fields) | Reads and writes | Never sees them | Nothing |
| Payments | Reads all, deletes | Reads their own | Nothing |
| `change`, `cancel`, `portal`, `wall` endpoints | Any membership on their site | Their own | 404 |

Nobody creates memberships or payments directly: checkout and Stripe do. The member endpoints answer
404, not 403, to anyone who may not use them, so they don't say whether a membership exists.

Memberships' and payments' read access returns a query for members: the plugin's own "your rows"
filter. What `canManage` returns is never passed to Payload, so an object that looks like a query
can't widen it to every row. `canCheckout` follows the same rule: only `true` lets a checkout start,
and anything else, an error included, refuses it with "Memberships are not available here yet."
(503).

`overrides` can change a collection's `access`; if you do, your rules replace these.

## License

MIT
