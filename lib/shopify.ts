// ============================================================
// Shopify Admin API client
//
// Design notes:
// - Idempotency for order creation is enforced by tagging orders
//   with a hashed cycle-ID tag (see cycleIdTag). Before creating,
//   we GET orders with that tag; if found, we return the existing
//   order. The raw cycle ID is also kept in note_attributes for
//   manual debugging.
// - Customer tag mutations use the GraphQL `tagsAdd`/`tagsRemove`
//   mutations because REST `customer.tags` requires fetching all
//   tags first (race-prone under concurrent webhooks).
// - All errors throw a typed `ShopifyError` so the caller can
//   distinguish payment-provider errors from internal errors.
// ============================================================

import crypto from 'node:crypto';
import { env } from './env';

// Shopify caps tag length at 40 chars. Real Xendit cycle IDs (UUID-shaped,
// often 30-40 chars themselves) overflow once we prefix them, causing
// `422 Order tags is invalid`. We tag with a stable SHA-1-derived short
// hash instead; the full ID still lives in `note_attributes.xendit_cycle_id`
// for human/manual lookup. Tag length is constant 23 chars.
function cycleIdTag(cycleId: string): string {
  const h = crypto.createHash('sha1').update(cycleId).digest('hex').slice(0, 16);
  return `xcycle_${h}`;
}

function restBase(): string {
  return `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}`;
}
function gqlUrl(): string {
  return `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;
}

export class ShopifyError extends Error {
  constructor(public status: number, public body: string) {
    super(`Shopify API ${status}: ${body.slice(0, 500)}`);
    this.name = 'ShopifyError';
  }
}

async function shopifyRest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${restBase()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN,
      ...init.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new ShopifyError(res.status, text);
  return text ? JSON.parse(text) : ({} as T);
}

async function shopifyGql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(gqlUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new ShopifyError(res.status, text);
  const json = JSON.parse(text);
  if (json.errors?.length) {
    throw new ShopifyError(200, JSON.stringify(json.errors));
  }
  return json.data as T;
}

// ============================================================
// CUSTOMER
// ============================================================

export type ShopifyCustomer = {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  tags: string;
};

export async function getCustomer(customerId: string): Promise<ShopifyCustomer> {
  const data = await shopifyRest<{ customer: ShopifyCustomer }>(
    `/customers/${customerId}.json`
  );
  return data.customer;
}

// ============================================================
// PRODUCT VARIANT VALIDATION
//
// Used by /api/checkout to cross-check that line items posted by the
// theme actually correspond to real products at the prices claimed.
// Without this, anyone who can craft an App-Proxy-signed request could
// substitute a Rp 1.000 price for any product. We trust ONLY the
// Shopify Admin API for unit prices.
// ============================================================

export type ShopifyVariantInfo = {
  variantId: string;                 // gid stripped to numeric
  productId: string;
  title: string;                     // "Product Title — Variant Title"
  productTitle: string;
  variantTitle: string | null;
  price: number;                     // IDR integer (Shopify returns string)
  currencyCode: string;
  // True if the variant is configured with at least one selling plan
  // (subscription / pre-order / etc.). Caller cross-checks the specific
  // selling_plan_id by querying sellingPlanGroups separately if needed.
  hasSellingPlans: boolean;
  sellingPlanIds: string[];          // numeric IDs as strings
  requiresShipping: boolean;
  taxable: boolean;
  imageUrl: string | null;
};

/**
 * Fetch one or more product variants by numeric ID via Admin GraphQL.
 *
 * Returns variants in the same order they were requested (missing
 * variants are omitted, not throwing — caller decides how to handle).
 */
export async function getVariantsByIds(variantIds: string[]): Promise<ShopifyVariantInfo[]> {
  if (variantIds.length === 0) return [];
  const ids = variantIds.map((id) => `gid://shopify/ProductVariant/${id}`);

  type Node = {
    id: string;
    title: string;
    price: string;
    sku: string | null;
    requiresShipping: boolean;
    taxable: boolean;
    image: { url: string } | null;
    product: { id: string; title: string };
    sellingPlanGroupCount?: number;
    sellingPlanGroups?: {
      edges: Array<{ node: { sellingPlans: { edges: Array<{ node: { id: string } }> } } }>;
    };
  };

  type GqlResult = {
    nodes: Array<Node | null>;
    shop: { currencyCode: string };
  };

  const data = await shopifyGql<GqlResult>(
    `query getVariants($ids: [ID!]!) {
      shop { currencyCode }
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          title
          price
          sku
          requiresShipping
          taxable
          image { url }
          product { id title }
          sellingPlanGroups(first: 5) {
            edges { node { sellingPlans(first: 10) { edges { node { id } } } } }
          }
        }
      }
    }`,
    { ids },
  );

  const result: ShopifyVariantInfo[] = [];
  for (const node of data.nodes) {
    if (!node) continue;
    const variantId = node.id.split('/').pop() ?? '';
    const productId = node.product.id.split('/').pop() ?? '';
    const sellingPlanIds: string[] = [];
    for (const grp of node.sellingPlanGroups?.edges ?? []) {
      for (const sp of grp.node.sellingPlans.edges) {
        sellingPlanIds.push(sp.node.id.split('/').pop() ?? '');
      }
    }
    const priceNum = Math.round(Number(node.price));
    if (!Number.isFinite(priceNum)) {
      throw new ShopifyError(200, `Variant ${variantId} returned non-numeric price`);
    }
    result.push({
      variantId,
      productId,
      title: node.title === 'Default Title'
        ? node.product.title
        : `${node.product.title} — ${node.title}`,
      productTitle: node.product.title,
      variantTitle: node.title === 'Default Title' ? null : node.title,
      price: priceNum,
      currencyCode: data.shop.currencyCode,
      hasSellingPlans: sellingPlanIds.length > 0,
      sellingPlanIds,
      requiresShipping: node.requiresShipping,
      taxable: node.taxable,
      imageUrl: node.image?.url ?? null,
    });
  }
  return result;
}

type TagMutationResult = {
  userErrors: Array<{ field: string[] | null; message: string }>;
};

function toTagArray(tag: string | string[]): string[] {
  return Array.isArray(tag) ? tag : [tag];
}

/**
 * Add one or more tags to a Shopify customer. Idempotent: adding a tag that
 * already exists is a no-op at Shopify's side. Throws ShopifyError if Shopify
 * returns userErrors (e.g. customer not found, invalid tag).
 */
export async function addCustomerTag(
  customerId: string,
  tag: string | string[],
): Promise<void> {
  const tags = toTagArray(tag);
  if (tags.length === 0) return;
  const gid = `gid://shopify/Customer/${customerId}`;
  const data = await shopifyGql<{ tagsAdd: TagMutationResult }>(
    `mutation tagsAdd($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }`,
    { id: gid, tags },
  );
  if (data.tagsAdd.userErrors.length) {
    throw new ShopifyError(200, JSON.stringify(data.tagsAdd.userErrors));
  }
}

export async function removeCustomerTag(
  customerId: string,
  tag: string | string[],
): Promise<void> {
  const tags = toTagArray(tag);
  if (tags.length === 0) return;
  const gid = `gid://shopify/Customer/${customerId}`;
  const data = await shopifyGql<{ tagsRemove: TagMutationResult }>(
    `mutation tagsRemove($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }`,
    { id: gid, tags },
  );
  if (data.tagsRemove.userErrors.length) {
    throw new ShopifyError(200, JSON.stringify(data.tagsRemove.userErrors));
  }
}

// ============================================================
// ORDER
// ============================================================

export type ShopifyOrder = {
  id: number;
  name: string;             // e.g. "#1042"
  email: string;
  financial_status: string;
  tags: string;
  created_at: string;
};

type CreateOrderInput = {
  shopifyCustomerId: string;
  email: string;
  amount: number;                   // IDR in smallest currency unit (IDR has no fractional)
  currency: string;                 // "IDR"
  planName: string;
  planCode: string;
  xenditCycleId: string;            // used as idempotency key
  xenditPlanId: string;
  xenditPaymentId?: string;
  cycleDate?: string;
};

/**
 * Look up an existing order for a given Xendit cycle ID. We tag
 * orders with `xendit_cycle_id=<id>` so we can locate them later.
 * Returns null if no matching order exists.
 *
 * Uses GraphQL: the REST /orders.json endpoint does NOT support
 * filtering by tag — only GraphQL `orders(query:)` does.
 */
async function findOrderByXenditCycle(xenditCycleId: string): Promise<ShopifyOrder | null> {
  type GqlResult = {
    orders: {
      edges: Array<{
        node: {
          id: string;          // gid://shopify/Order/123
          name: string;
          email: string;
          displayFinancialStatus: string;
          tags: string[];
          createdAt: string;
        };
      }>;
    };
  };

  const data = await shopifyGql<GqlResult>(
    `query findOrderByTag($q: String!) {
      orders(first: 1, query: $q) {
        edges {
          node {
            id
            name
            email
            displayFinancialStatus
            tags
            createdAt
          }
        }
      }
    }`,
    // Search by the hashed cycle-ID tag (see cycleIdTag() at top of file).
    { q: `tag:"${cycleIdTag(xenditCycleId)}"` }
  );

  const node = data.orders.edges[0]?.node;
  if (!node) return null;

  // Extract numeric ID from gid://shopify/Order/123
  const numericId = Number(node.id.split('/').pop());
  return {
    id: numericId,
    name: node.name,
    email: node.email,
    financial_status: node.displayFinancialStatus.toLowerCase(),
    tags: node.tags.join(', '),
    created_at: node.createdAt,
  };
}

/**
 * Create a paid order in Shopify for one billing cycle.
 *
 * Idempotency: caller MUST pass `xenditCycleId`. We first search
 * for an existing order tagged with that cycle ID and return it
 * if found, so retrying this function for the same cycle never
 * creates a duplicate.
 */
export async function createPaidOrder(input: CreateOrderInput): Promise<ShopifyOrder> {
  // 1. Idempotency check
  const existing = await findOrderByXenditCycle(input.xenditCycleId);
  if (existing) return existing;

  // 2. Build order payload
  const amountStr = input.amount.toString();          // IDR is integer; no decimals
  // Shopify caps tag length at 40 chars. Both plan ID and cycle ID are
  // UUID-shaped (~37 chars), so we keep their FULL values in note_attributes
  // and use a short, hash-derived idempotency tag (see cycleIdTag()).
  const tags = [
    'xendit-recurring',
    `subscription-${input.planCode}`,
    cycleIdTag(input.xenditCycleId),
  ].join(', ');

  const noteAttributes = [
    { name: 'xendit_cycle_id', value: input.xenditCycleId },
    { name: 'xendit_plan_id', value: input.xenditPlanId },
    { name: 'plan_code', value: input.planCode },
  ];
  if (input.xenditPaymentId) {
    noteAttributes.push({ name: 'xendit_payment_id', value: input.xenditPaymentId });
  }
  if (input.cycleDate) {
    noteAttributes.push({ name: 'cycle_date', value: input.cycleDate });
  }

  const payload = {
    order: {
      customer: { id: Number(input.shopifyCustomerId) },
      email: input.email,
      currency: input.currency,
      line_items: [
        {
          title: input.planName,
          price: amountStr,
          quantity: 1,
          requires_shipping: false,
          taxable: false,
        },
      ],
      financial_status: 'paid',
      inventory_behaviour: 'bypass',
      send_receipt: true,
      send_fulfillment_receipt: false,
      tags,
      note: `Xendit recurring payment. Plan: ${input.xenditPlanId}. Cycle: ${input.xenditCycleId}.`,
      note_attributes: noteAttributes,
      transactions: [
        {
          kind: 'sale',
          status: 'success',
          amount: amountStr,
          currency: input.currency,
          gateway: 'Xendit Recurring',
        },
      ],
    },
  };

  const data = await shopifyRest<{ order: ShopifyOrder }>(`/orders.json`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return data.order;
}

// ============================================================
// SELLING PLAN LOOKUP
//
// A Shopify "selling plan" defines the recurring schedule attached
// to a variant (e.g. "Deliver every 3 months, 15% off"). We need the
// billing interval to translate into the Xendit Recurring schedule
// shape (DAY | WEEK | MONTH | YEAR + interval_count).
// ============================================================

export type SellingPlanInfo = {
  id: string;                       // numeric
  name: string;
  interval: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
  intervalCount: number;
};

export async function getSellingPlansByIds(ids: string[]): Promise<SellingPlanInfo[]> {
  if (ids.length === 0) return [];
  const gids = ids.map((id) => `gid://shopify/SellingPlan/${id}`);

  type Node = {
    id: string;
    name: string;
    billingPolicy:
      | {
          interval?: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
          intervalCount?: number;
        }
      | null;
    deliveryPolicy:
      | {
          interval?: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
          intervalCount?: number;
        }
      | null;
  };

  const data = await shopifyGql<{ nodes: Array<Node | null> }>(
    `query getSellingPlans($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on SellingPlan {
          id
          name
          billingPolicy {
            ... on SellingPlanRecurringBillingPolicy {
              interval
              intervalCount
            }
          }
          deliveryPolicy {
            ... on SellingPlanRecurringDeliveryPolicy {
              interval
              intervalCount
            }
          }
        }
      }
    }`,
    { ids: gids },
  );

  const out: SellingPlanInfo[] = [];
  for (const node of data.nodes) {
    if (!node) continue;
    // Billing policy is the source of truth for "how often we charge".
    // Delivery policy is the fulfilment cadence; for most setups they
    // match, but we always prefer billing for the Xendit schedule.
    const policy = node.billingPolicy ?? node.deliveryPolicy;
    if (!policy?.interval || !policy.intervalCount) continue;
    out.push({
      id: node.id.split('/').pop() ?? '',
      name: node.name,
      interval: policy.interval,
      intervalCount: policy.intervalCount,
    });
  }
  return out;
}

// ============================================================
// CART-BASED ORDER CREATION (cart_snapshot → Shopify Order)
//
// Used by webhook handlers when a Xendit Invoice or Recurring cycle
// succeeds. Builds Shopify line_items from the cart snapshot captured
// at /api/checkout time, so the customer's actual cart contents appear
// on the order — not a single "Subscription" placeholder line.
//
// Same idempotency model as createPaidOrder: one Shopify Order per
// cycle ID, tag-based lookup via GraphQL.
// ============================================================

export type CartLineItemSnapshot = {
  variant_id: string;
  quantity: number;
  price: number;                  // unit price IDR (validated server-side at checkout)
  title: string;
  is_subscription?: boolean;      // for note_attributes annotation only
  requires_shipping?: boolean;
  taxable?: boolean;
};

type CreateCartOrderInput = {
  shopifyCustomerId: string;
  email: string;
  currency: string;               // "IDR"
  lineItems: CartLineItemSnapshot[];
  idempotencyKey: string;         // xendit_cycle_id OR xendit_invoice_id
  // Free-form attributes recorded on the order for human debugging.
  // Always include the source Xendit object(s).
  noteAttributes: Array<{ name: string; value: string }>;
  note: string;
  tags: string[];                 // free-form tags to add; cycleIdTag is added automatically
  shippingAddress?: ShopifyAddressInput;
};

export type ShopifyAddressInput = {
  first_name?: string;
  last_name?: string;
  address1: string;
  address2?: string;
  city: string;
  province?: string;
  country: string;                // 'Indonesia' etc.
  zip?: string;
  phone?: string;
};

export async function createCartOrder(input: CreateCartOrderInput): Promise<ShopifyOrder> {
  const existing = await findOrderByXenditCycle(input.idempotencyKey);
  if (existing) return existing;

  const lineItems = input.lineItems.map((li) => ({
    variant_id: Number(li.variant_id),
    quantity: li.quantity,
    // Pass through the per-unit price captured at checkout. Shopify will
    // still consult the variant for inventory + tax + shipping rules.
    price: li.price.toString(),
    requires_shipping: li.requires_shipping ?? true,
    taxable: li.taxable ?? true,
  }));

  const totalAmount = input.lineItems.reduce(
    (sum, li) => sum + li.price * li.quantity,
    0,
  );

  const allTags = [
    ...new Set([...input.tags, 'xendit', cycleIdTag(input.idempotencyKey)]),
  ].join(', ');

  const payload = {
    order: {
      customer: { id: Number(input.shopifyCustomerId) },
      email: input.email,
      currency: input.currency,
      line_items: lineItems,
      financial_status: 'paid',
      inventory_behaviour: 'decrement_obeying_policy',
      send_receipt: true,
      send_fulfillment_receipt: false,
      tags: allTags,
      note: input.note,
      note_attributes: input.noteAttributes,
      shipping_address: input.shippingAddress,
      transactions: [
        {
          kind: 'sale',
          status: 'success',
          amount: totalAmount.toString(),
          currency: input.currency,
          gateway: 'Xendit',
        },
      ],
    },
  };

  const data = await shopifyRest<{ order: ShopifyOrder }>(`/orders.json`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return data.order;
}
