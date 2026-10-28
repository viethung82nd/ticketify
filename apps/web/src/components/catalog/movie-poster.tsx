import { Clapperboard } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * 2:3 poster. Without an image (or if it fails to load, e.g. an expired URL) it shows a grey
 * frame with the title instead of a stock poster.
 */
export function MoviePoster({
  title,
  posterUrl,
  className,
  size = 'md',
}: {
  title: string;
  posterUrl: string | null;
  className?: string;
  size?: 'sm' | 'md';
}) {
  const [failed, setFailed] = useState(false);
  const showImage = posterUrl !== null && !failed;

  return (
    <div
      className={cn(
        'relative aspect-[2/3] overflow-hidden rounded-xl bg-gradient-to-b from-[#2a2a2a] to-[#1a1a1a]',
        className,
      )}
    >
      {showImage ? (
        <img
          src={posterUrl}
          alt={`Poster phim ${title}`}
          loading="lazy"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        <div
          role="img"
          aria-label={`Chưa có poster: ${title}`}
          className="flex size-full flex-col items-center justify-center gap-2 p-3 text-center"
        >
          <Clapperboard
            className={cn('text-white/30', size === 'sm' ? 'size-4' : 'size-8')}
            aria-hidden
          />
          {size === 'md' && (
            <span className="line-clamp-3 text-sm font-semibold text-white/70">{title}</span>
          )}
        </div>
      )}
    </div>
  );
}
