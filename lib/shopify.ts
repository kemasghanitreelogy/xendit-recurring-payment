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
