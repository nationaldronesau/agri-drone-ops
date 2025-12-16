import { redirect } from "next/navigation";
import { checkAssetAccess } from "@/lib/auth/api-auth";
import { AnnotateClient } from "./AnnotateClient";

interface PageProps {
  params: Promise<{ assetId: string }>;
}

/**
 * Server component wrapper for the annotation page.
 * Validates authentication and asset access before rendering.
 */
export default async function AnnotatePage({ params }: PageProps) {
  const { assetId } = await params;

  // Check if user has access to this asset
  const access = await checkAssetAccess(assetId);

  if (!access.authenticated) {
    // Not authenticated - redirect to login
    redirect("/api/auth/signin?callbackUrl=" + encodeURIComponent(`/annotate/${assetId}`));
  }

  if (!access.hasAccess) {
    // Authenticated but no access to this asset
    redirect("/unauthorized");
  }

  // User has access - render the client component
  return <AnnotateClient assetId={assetId} />;
}
