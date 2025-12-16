/**
 * Pagination utilities for API endpoints
 *
 * Standard pagination pattern:
 * - page: 1-indexed page number (default: 1)
 * - pageSize: items per page (default: 50, max: 200)
 *
 * Response includes:
 * - data: Array of items
 * - pagination: { page, pageSize, total, totalPages, hasMore }
 */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const MAX_PAGE = 1000000; // Prevent overflow when calculating skip

export interface PaginationParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

/**
 * Parse and validate pagination parameters from URL search params
 */
export function parsePaginationParams(searchParams: URLSearchParams): PaginationParams {
  const pageParam = searchParams.get('page');
  const pageSizeParam = searchParams.get('pageSize');

  // Parse page (default 1, min 1, max 1000000 to prevent overflow)
  let page = pageParam ? parseInt(pageParam, 10) : 1;
  if (isNaN(page) || page < 1) page = 1;
  if (page > MAX_PAGE) page = MAX_PAGE;

  // Parse pageSize (default 50, min 1, max 200)
  let pageSize = pageSizeParam ? parseInt(pageSizeParam, 10) : DEFAULT_PAGE_SIZE;
  if (isNaN(pageSize) || pageSize < 1) pageSize = DEFAULT_PAGE_SIZE;
  if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;

  // Calculate Prisma skip/take
  const skip = (page - 1) * pageSize;
  const take = pageSize;

  return { page, pageSize, skip, take };
}

/**
 * Build pagination metadata from total count and params
 */
export function buildPaginationMeta(total: number, params: PaginationParams): PaginationMeta {
  const totalPages = Math.ceil(total / params.pageSize);

  return {
    page: params.page,
    pageSize: params.pageSize,
    total,
    totalPages,
    hasMore: params.page < totalPages,
  };
}

/**
 * Build a paginated response object
 */
export function paginatedResponse<T>(
  data: T[],
  total: number,
  params: PaginationParams,
  dataKey: string = 'data'
): { [key: string]: T[] | PaginationMeta } {
  return {
    [dataKey]: data,
    pagination: buildPaginationMeta(total, params),
  };
}
