import { NextResponse } from "next/server";
import prisma from "@/lib/db";
import { s3Client } from "@/lib/services/s3";
import { HeadBucketCommand } from "@aws-sdk/client-s3";

interface HealthCheck {
  name: string;
  status: "healthy" | "unhealthy" | "degraded";
  latencyMs?: number;
  error?: string;
}

async function checkDatabase(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return {
      name: "database",
      status: "healthy",
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      name: "database",
      status: "unhealthy",
      latencyMs: Date.now() - start,
      error: "Connection failed",
    };
  }
}

async function checkS3(): Promise<HealthCheck> {
  const bucket = process.env.AWS_S3_BUCKET;
  if (!bucket) {
    return {
      name: "s3",
      status: "degraded",
      error: "S3 bucket not configured",
    };
  }

  const start = Date.now();
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
    return {
      name: "s3",
      status: "healthy",
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      name: "s3",
      status: "unhealthy",
      latencyMs: Date.now() - start,
      error: "Bucket access failed",
    };
  }
}

export async function GET() {
  const startTime = Date.now();

  // Run health checks in parallel
  const checks = await Promise.all([checkDatabase(), checkS3()]);

  // Determine overall status
  const hasUnhealthy = checks.some((c) => c.status === "unhealthy");
  const hasDegraded = checks.some((c) => c.status === "degraded");

  const overallStatus = hasUnhealthy
    ? "unhealthy"
    : hasDegraded
      ? "degraded"
      : "healthy";

  const response = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    service: "agridrone-ops",
    version: process.env.npm_package_version || "1.0.0",
    environment: process.env.NODE_ENV || "unknown",
    totalLatencyMs: Date.now() - startTime,
    checks: checks.reduce(
      (acc, check) => {
        acc[check.name] = {
          status: check.status,
          latencyMs: check.latencyMs,
          ...(check.error && { error: check.error }),
        };
        return acc;
      },
      {} as Record<string, object>
    ),
  };

  const httpStatus = overallStatus === "healthy" ? 200 : overallStatus === "degraded" ? 200 : 503;

  return NextResponse.json(response, { status: httpStatus });
}
