/**
 * Type-only re-export of the canonical domain contract.
 *
 * The single source of truth lives in server/src/types.ts; this module lets
 * the web package consume the exact same types without duplicating them.
 * Import domain types from this module in web code.
 */
export type * from '../../server/src/types';
