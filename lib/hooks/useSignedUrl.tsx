import { useState, useEffect } from 'react';

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

  const timerRef = { current: null as NodeJS.Timeout | null };

  const fetchSignedUrl = async (): Promise<void> => {
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
        const refreshTime = (data.expiresIn - 300) * 1000;
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
  };

  useEffect(() => {
    fetchSignedUrl();
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, type]);

  return { url, loading, error, refresh: fetchSignedUrl };
}

/**
 * Component wrapper for images that automatically handles signed URLs
 */
interface S3ImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  assetId?: string;
}

export function S3Image({ 
  assetId, 
  src, 
  alt, 
  className,
  ...props 
}: S3ImageProps) {
  const { url, loading } = useSignedUrl(assetId || null, 'asset', src);

  if (loading) {
    return (
      <div className={`animate-pulse bg-gray-200 ${className}`}>
        <span className="sr-only">Loading image...</span>
      </div>
    );
  }

  return (
    <img 
      src={url || src || ''}
      alt={alt}
      className={className}
      {...props}
    />
  );
}