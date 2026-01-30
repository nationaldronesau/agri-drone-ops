import { useCallback, useEffect, useRef, useState } from 'react';
import Image, { type ImageProps } from 'next/image';

interface SignedUrlResponse {
  url: string;
  storageType: string;
  expiresIn?: number;
  fallback?: boolean;
}

interface UseSignedUrlReturn {
  url: string | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * Hook to fetch and manage signed URLs for assets
 * Automatically handles both S3 and local storage
 */
export function useSignedUrl(
  assetId: string | null,
  type: 'asset' | 'orthomosaic' = 'asset',
  initialUrl?: string
): UseSignedUrlReturn {
  const [url, setUrl] = useState<string | null>(initialUrl || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const fetchSignedUrl = useCallback(async (): Promise<void> => {
    if (!assetId) {
      setUrl(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const endpoint = type === 'asset'
        ? `/api/assets/${assetId}/signed-url`
        : `/api/orthomosaics/${assetId}/signed-url`;

      const response = await fetch(endpoint);

      if (!response.ok) {
        throw new Error(`Failed to fetch signed URL: ${response.statusText}`);
      }

      const data: SignedUrlResponse = await response.json();
      setUrl(data.url);

      // If URL expires, set a timer to refresh it
      if (data.expiresIn && data.storageType === 's3') {
        // Refresh 5 minutes before expiry
        const refreshTime = Math.max((data.expiresIn - 300) * 1000, 0);
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(() => { fetchSignedUrl(); }, refreshTime);
      }
    } catch (err) {
      console.error('Error fetching signed URL:', err);
      setError(err instanceof Error ? err : new Error('Unknown error'));

      // Fallback to initial URL if provided
      if (initialUrl) {
        setUrl(initialUrl);
      }
    } finally {
      setLoading(false);
    }
  }, [assetId, initialUrl, type]);

  useEffect(() => {
    fetchSignedUrl();
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [fetchSignedUrl]);

  return { url, loading, error, refresh: fetchSignedUrl };
}

/**
 * Component wrapper for images that automatically handles signed URLs
 */
type S3ImageProps = Omit<ImageProps, 'src' | 'alt' | 'width' | 'height' | 'fill'> & {
  assetId?: string;
  src?: string;
  alt?: string;
  width?: number;
  height?: number;
  fill?: boolean;
};

export function S3Image({ 
  assetId, 
  src, 
  alt, 
  className,
  ...props 
}: S3ImageProps) {
  const { url, loading, error } = useSignedUrl(assetId || null, 'asset', src);
  const resolvedSrc = url || src;
  const { width, height, fill, ...imageProps } = props;

  if (loading) {
    return (
      <div className={`animate-pulse bg-gray-200 ${className}`}>
        <span className="sr-only">Loading image...</span>
      </div>
    );
  }

  if (error && !resolvedSrc) {
    return (
      <div className={`flex items-center justify-center bg-gray-100 text-xs text-gray-500 ${className}`}>
        Image unavailable
      </div>
    );
  }

  if (fill) {
    return (
      <Image
        src={resolvedSrc || ''}
        alt={alt ?? ''}
        className={className}
        fill
        unoptimized
        {...imageProps}
      />
    );
  }

  return (
    <Image
      src={resolvedSrc || ''}
      alt={alt ?? ''}
      className={className}
      width={width ?? 1}
      height={height ?? 1}
      unoptimized
      {...imageProps}
    />
  );
}
