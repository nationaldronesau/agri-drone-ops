/**
 * Training Model Download API Route
 *
 * GET /api/training/models/[id]/download - Return signed URL for model weights
 */
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';
import { S3Service } from '@/lib/services/s3';

function parseS3Path(path: string): { bucket: string; keyPrefix: string } | null {
  if (!path.startsWith('s3://')) return null;
  const withoutScheme = path.replace('s3://', '');
  const [bucket, ...rest] = withoutScheme.split('/');
  if (!bucket) return null;
  return { bucket, keyPrefix: rest.join('/') };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const model = await prisma.trainedModel.findFirst({
      where: {
        id: params.id,
        team: {
          members: {
            some: { userId: auth.userId },
          },
        },
      },
      select: {
        id: true,
        s3Path: true,
        s3Bucket: true,
        weightsFile: true,
      },
    });

    if (!model) {
      return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    }

    const parsed = parseS3Path(model.s3Path);
    const bucket = model.s3Bucket || parsed?.bucket || S3Service.bucketName;
    const prefix = parsed?.keyPrefix ? parsed.keyPrefix.replace(/\/$/, '') : '';
    const weightsFile = model.weightsFile || 'best.pt';
    const key = prefix ? `${prefix}/${weightsFile}` : weightsFile;

    const signedUrl = await S3Service.getSignedUrl(key, 3600, bucket);
    return NextResponse.json({ url: signedUrl });
  } catch (error) {
    console.error('Error generating model download URL:', error);
    return NextResponse.json(
      { error: 'Failed to generate download URL' },
      { status: 500 }
    );
  }
}
