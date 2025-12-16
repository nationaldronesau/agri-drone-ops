/**
 * Audit Trail Utilities
 *
 * Provides standardized audit logging for critical data modifications.
 * Logs are stored in the AuditLog table with indexes for efficient querying.
 *
 * Usage:
 *   await logAudit({
 *     action: 'VERIFY',
 *     entityType: 'Detection',
 *     entityId: detection.id,
 *     beforeState: { verified: false },
 *     afterState: { verified: true },
 *     userId: auth.userId,
 *     request,
 *   });
 */

import prisma from '@/lib/db';
import { AuditAction } from '@prisma/client';
import { NextRequest } from 'next/server';

export interface AuditLogParams {
  action: AuditAction;
  entityType: string;
  entityId: string;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  userId?: string | null;
  userEmail?: string | null;
  request?: NextRequest | null;
  requestId?: string | null;
}

/**
 * Extract client information from a request for audit logging
 */
function extractRequestInfo(request: NextRequest | null | undefined): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  if (!request) {
    return { ipAddress: null, userAgent: null };
  }

  // Get IP from various headers (in order of preference)
  const ipAddress =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    request.headers.get('cf-connecting-ip') || // Cloudflare
    null;

  const userAgent = request.headers.get('user-agent') || null;

  return { ipAddress, userAgent };
}

/**
 * Log an audit trail entry for a data modification
 *
 * This function is designed to never throw - audit failures should not
 * break the main operation. Errors are logged to console instead.
 */
export async function logAudit(params: AuditLogParams): Promise<void> {
  try {
    const { ipAddress, userAgent } = extractRequestInfo(params.request);

    await prisma.auditLog.create({
      data: {
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        beforeState: params.beforeState ?? undefined,
        afterState: params.afterState ?? undefined,
        userId: params.userId ?? null,
        userEmail: params.userEmail ?? null,
        ipAddress,
        userAgent,
        requestId: params.requestId ?? null,
      },
    });
  } catch (error) {
    // Log but don't throw - audit failures should not break operations
    console.error('[AUDIT] Failed to create audit log entry:', error);
    console.error('[AUDIT] Params:', {
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      userId: params.userId,
    });
  }
}

/**
 * Batch create audit log entries (for bulk operations)
 */
export async function logAuditBatch(
  entries: AuditLogParams[]
): Promise<void> {
  try {
    await prisma.auditLog.createMany({
      data: entries.map((params) => {
        const { ipAddress, userAgent } = extractRequestInfo(params.request);
        return {
          action: params.action,
          entityType: params.entityType,
          entityId: params.entityId,
          beforeState: params.beforeState ?? undefined,
          afterState: params.afterState ?? undefined,
          userId: params.userId ?? null,
          userEmail: params.userEmail ?? null,
          ipAddress,
          userAgent,
          requestId: params.requestId ?? null,
        };
      }),
    });
  } catch (error) {
    console.error('[AUDIT] Failed to create batch audit log entries:', error);
    console.error('[AUDIT] Entry count:', entries.length);
  }
}

/**
 * Query audit logs for a specific entity
 */
export async function getAuditLogsForEntity(
  entityType: string,
  entityId: string,
  limit = 50
) {
  return prisma.auditLog.findMany({
    where: {
      entityType,
      entityId,
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: limit,
  });
}

/**
 * Query audit logs for a specific user
 */
export async function getAuditLogsForUser(userId: string, limit = 50) {
  return prisma.auditLog.findMany({
    where: {
      userId,
    },
    orderBy: {
      createdAt: 'desc',
    },
    take: limit,
  });
}
