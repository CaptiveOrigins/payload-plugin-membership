import type { Access, CollectionBeforeChangeHook, CollectionConfig, FieldAccess, Where } from 'payload'
import { generateKeyBetween } from 'payload/shared'

import { isManager } from './access.js'
import type { ResolvedMembership } from './types.js'

const idOf = (v: unknown) => (v && typeof v === 'object' ? String((v as { id: unknown }).id) : v ? String(v) : null)

/** Drag-and-drop ordered (Payload `orderable`); a new record goes between its alphabetical neighbours. */
const placeAlphabetically =
  (o: ResolvedMembership, slug: string, field: string): CollectionBeforeChangeHook =>
  async ({ data, operation, req }) => {
    if (operation !== 'create' || data._order || !data[field]) return data
    const scope = o.scopeField ? idOf(data[o.scopeField]) : null
    const { docs } = await req.payload.find({
      collection: slug as never,
      where: o.scopeField && scope ? { [o.scopeField]: { equals: scope } } : {},
      sort: '_order',
      depth: 0,
      pagination: false,
      overrideAccess: true,
      select: { [field]: true, _order: true } as never,
      req,
    })
    const ordered = docs as unknown as Record<string, string | undefined>[]
    const next = ordered.findIndex((d) => String(d[field]).localeCompare(String(data[field]), 'en', { sensitivity: 'base' }) > 0)
    const before = next === -1 ? (ordered.at(-1)?._order ?? null) : next > 0 ? (ordered[next - 1]!._order ?? null) : null
    const after = next === -1 ? null : (ordered[next]!._order ?? null)
    try {
      data._order = generateKeyBetween(before, after)
    } catch {
      // Neighbours out of order after manual moves: Payload appends it at the end instead.
    }
    return data
  }

const money = (name: string, label: string, description: string) =>
  ({ name, label, type: 'number' as const, min: 0, admin: { description: `${description} In cents (e.g. 500 = 5.00).` } })

export function tiersCollection(o: ResolvedMembership): CollectionConfig {
  // Only an exact `true` from `canManage` makes a manager; a truthy value or a thrown error is a no.
  const manager: Access = ({ req }) => isManager(o, req)
  const managerField: FieldAccess = ({ req }) => isManager(o, req)
  return {
    slug: o.tiers,
    labels: { singular: 'Membership tier', plural: 'Membership tiers' },
    admin: {
      useAsTitle: 'name',
      defaultColumns: ['name', 'monthly', 'yearly', 'active'],
      description: 'Fixed-price levels (Patreon-style). Shown in this order: drag rows to change it.',
    },
    access: { read: () => true, create: manager, update: manager, delete: manager },
    orderable: true,
    defaultSort: '_order',
    hooks: { beforeChange: [placeAlphabetically(o, o.tiers, 'name')] },
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'active', label: 'Open to new members', type: 'checkbox', defaultValue: true, admin: { position: 'sidebar' } },
      { type: 'row', fields: [{ ...money('monthly', 'Monthly price', 'Per month; empty: not offered monthly.'), admin: { width: '50%' } }, { ...money('yearly', 'Yearly price', 'Per year; empty: not offered yearly.'), admin: { width: '50%' } }] },
      { name: 'description', type: 'textarea' },
      { name: 'perks', type: 'array', fields: [{ name: 'perk', type: 'text', required: true }] },
      { name: 'color', type: 'text', admin: { position: 'sidebar', description: 'Badge color, e.g. #cf8137.' } },
      {
        name: 'sponsorListing',
        label: 'Members are listed as sponsors',
        type: 'checkbox',
        admin: { position: 'sidebar', description: 'A perk your site can act on in onStatusChange (e.g. with payload-plugin-sponsors).' },
      },
      // Stripe product for this tier/category (created on first checkout; prices are set per member).
      { name: 'stripeProduct', type: 'text', access: { read: managerField, create: managerField, update: managerField }, admin: { position: 'sidebar', readOnly: true } },
    ],
    timestamps: true,
  }
}

export function categoriesCollection(o: ResolvedMembership): CollectionConfig {
  // Only an exact `true` from `canManage` makes a manager; a truthy value or a thrown error is a no.
  const manager: Access = ({ req }) => isManager(o, req)
  const managerField: FieldAccess = ({ req }) => isManager(o, req)
  return {
    slug: o.categories,
    labels: { singular: 'Membership category', plural: 'Membership categories' },
    admin: {
      useAsTitle: 'name',
      defaultColumns: ['name', 'parent', 'minimum', 'active'],
      description: 'What members can choose to support, setting their own amount (A–Z for new ones; drag to reorder). Add your own fields to tie categories to anything.',
    },
    access: { read: () => true, create: manager, update: manager, delete: manager },
    orderable: true,
    defaultSort: '_order',
    hooks: { beforeChange: [placeAlphabetically(o, o.categories, 'name')] },
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'active', label: 'Open to new pledges', type: 'checkbox', defaultValue: true, admin: { position: 'sidebar' } },
      { name: 'parent', type: 'relationship', relationTo: o.categories as never, admin: { position: 'sidebar', description: 'Optional: nest under a broader category.' } },
      { name: 'description', type: 'textarea' },
      money('minimum', 'Minimum per month', 'Smallest monthly amount for this category (yearly: 12×).'),
      {
        name: 'earmarked',
        type: 'checkbox',
        admin: { description: 'Off: the category is the member’s preference. On: pledges are reserved for work in this category (say so on your page).' },
      },
      { name: 'color', type: 'text', admin: { position: 'sidebar' } },
      // Stripe product for this tier/category (created on first checkout; prices are set per member).
      { name: 'stripeProduct', type: 'text', access: { read: managerField, create: managerField, update: managerField }, admin: { position: 'sidebar', readOnly: true } },
    ],
    timestamps: true,
  }
}

export function membershipsCollection(o: ResolvedMembership): CollectionConfig {
  // Only an exact `true` from `canManage` makes a manager; a truthy value or a thrown error is a no.
  const manager: Access = ({ req }) => isManager(o, req)
  const managerField: FieldAccess = ({ req }) => isManager(o, req)
  // Managers read all; members read their own (the plugin's own query, never the site's answer).
  const ownOrManager: Access = async ({ req }) => {
    if (!req.user) return false
    if (await isManager(o, req)) return true
    return { user: { equals: req.user.id } } satisfies Where
  }
  const nobody = () => false
  return {
    slug: o.memberships,
    labels: { singular: 'Membership', plural: 'Memberships' },
    admin: {
      useAsTitle: 'label',
      defaultColumns: ['label', 'kind', 'amount', 'interval', 'status', 'currentPeriodEnd'],
      description: 'Members’ subscriptions. Created and updated by checkout and Stripe; edit the wall name or notes here.',
    },
    // Created by checkout and updated by Stripe webhooks; members manage theirs through the plugin's endpoints.
    access: { read: ownOrManager, create: nobody, update: manager, delete: manager },
    fields: [
      { name: 'label', type: 'text', admin: { readOnly: true } },
      { name: 'user', type: 'relationship', relationTo: o.users as never, required: true, index: true, admin: { readOnly: true } },
      {
        type: 'row',
        fields: [
          { name: 'kind', type: 'select', required: true, options: [{ label: 'Tier', value: 'tier' }, { label: 'Pledge to categories', value: 'pledge' }], admin: { width: '33%', readOnly: true } },
          {
            name: 'status',
            type: 'select',
            required: true,
            defaultValue: 'pending',
            index: true,
            options: ['pending', 'incomplete', 'active', 'past_due', 'canceled'].map((v) => ({ label: v.replace('_', ' '), value: v })),
            admin: { width: '33%', readOnly: true },
          },
          { name: 'interval', type: 'select', required: true, options: [{ label: 'Monthly', value: 'month' }, { label: 'Yearly', value: 'year' }], admin: { width: '34%', readOnly: true } },
        ],
      },
      { name: 'tier', type: 'relationship', relationTo: o.tiers as never, index: true, admin: { readOnly: true, condition: (d) => d?.kind === 'tier' } },
      {
        name: 'pledges',
        type: 'array',
        admin: { readOnly: true, condition: (d) => d?.kind === 'pledge' },
        fields: [
          { name: 'category', type: 'relationship', relationTo: o.categories as never, required: true, index: true },
          { name: 'amount', type: 'number', required: true, min: 0, admin: { description: 'Per interval, in cents.' } },
        ],
      },
      {
        type: 'row',
        fields: [
          { name: 'amount', type: 'number', required: true, min: 0, admin: { width: '33%', readOnly: true, description: 'Per interval, in cents.' } },
          { name: 'currency', type: 'text', required: true, admin: { width: '33%', readOnly: true } },
          {
            name: 'totalPaid',
            type: 'number',
            defaultValue: 0,
            // Only invoice.paid changes it, with an atomic $inc. Payload saves the whole document,
            // so an edit, a Stripe event or a hook saved at the same moment as an invoice would
            // write back an older total: leave it out of every save (0 on create).
            access: { create: () => false, update: () => false },
            hooks: {
              beforeChange: [
                ({ operation, siblingData }) => {
                  if (operation === 'create') return 0
                  delete siblingData.totalPaid
                  return undefined
                },
              ],
            },
            admin: { width: '34%', readOnly: true, description: 'All paid invoices, in cents.' },
          },
        ],
      },
      {
        type: 'row',
        fields: [
          { name: 'startedAt', type: 'date', admin: { width: '25%', readOnly: true } },
          { name: 'currentPeriodEnd', type: 'date', admin: { width: '25%', readOnly: true } },
          { name: 'cancelAtPeriodEnd', type: 'checkbox', admin: { width: '25%', readOnly: true } },
          { name: 'canceledAt', type: 'date', admin: { width: '25%', readOnly: true } },
        ],
      },
      {
        name: 'wall',
        label: 'Backers wall',
        type: 'group',
        admin: { description: 'Members choose whether and how they appear; nothing is public otherwise.' },
        fields: [
          { name: 'show', label: 'Show on the backers wall', type: 'checkbox', defaultValue: false },
          { name: 'name', label: 'Name on the wall', type: 'text', maxLength: 80 },
        ],
      },
      // Stripe references: managers only, never in public responses.
      {
        name: 'stripe',
        type: 'group',
        access: { read: managerField, create: managerField, update: managerField },
        admin: { position: 'sidebar', readOnly: true },
        fields: [
          { name: 'customer', type: 'text', index: true },
          { name: 'subscription', type: 'text', index: true },
          { name: 'checkoutSession', type: 'text', index: true },
        ],
      },
      { name: 'notes', type: 'textarea', access: { read: managerField, update: managerField }, admin: { position: 'sidebar' } },
    ],
    timestamps: true,
  }
}

export function paymentsCollection(o: ResolvedMembership): CollectionConfig {
  // Only an exact `true` from `canManage` makes a manager; a truthy value or a thrown error is a no.
  const manager: Access = ({ req }) => isManager(o, req)
  // Managers read all; members read their own (the plugin's own query, never the site's answer).
  const ownOrManager: Access = async ({ req }) => {
    if (!req.user) return false
    if (await isManager(o, req)) return true
    return { user: { equals: req.user.id } } satisfies Where
  }
  return {
    slug: o.payments,
    labels: { singular: 'Membership payment', plural: 'Membership payments' },
    admin: { useAsTitle: 'invoiceId', defaultColumns: ['membership', 'amount', 'currency', 'paidAt'], description: 'Every paid invoice, recorded once from Stripe.' },
    access: { read: ownOrManager, create: () => false, update: () => false, delete: manager },
    fields: [
      { name: 'membership', type: 'relationship', relationTo: o.memberships as never, required: true, index: true },
      { name: 'user', type: 'relationship', relationTo: o.users as never, required: true, index: true },
      { type: 'row', fields: [{ name: 'amount', type: 'number', required: true, admin: { width: '33%' } }, { name: 'currency', type: 'text', required: true, admin: { width: '33%' } }, { name: 'paidAt', type: 'date', required: true, index: true, admin: { width: '34%' } }] },
      { name: 'invoiceId', type: 'text', required: true, unique: true },
      { name: 'tier', type: 'relationship', relationTo: o.tiers as never },
      { name: 'pledges', type: 'array', fields: [{ name: 'category', type: 'relationship', relationTo: o.categories as never }, { name: 'amount', type: 'number' }] },
    ],
    timestamps: true,
  }
}
