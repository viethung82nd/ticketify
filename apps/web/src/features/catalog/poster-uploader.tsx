import { CATALOG_LIMITS, isPosterContentType, posterContentTypes } from '@ticketify/shared';
import { ImageUp, Loader2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { MoviePoster } from '@/components/catalog/movie-poster';
import { Button } from '@/components/ui/button';
import { presignPoster, putToStorage } from './catalog-api';
import { catalogErrorMessage } from './catalog-errors';

type UploadState =
  { kind: 'idle' } | { kind: 'uploading'; percent: number } | { kind: 'error'; message: string };

/** Same size rules as the API (`posterUploadRequestSchema`), checked before any request. */
function sizeProblem(file: File): string | null {
  if (file.size === 0) return 'Tệp ảnh rỗng.';
  if (file.size > CATALOG_LIMITS.posterMaxBytes) return 'Ảnh poster tối đa 2 MB.';
  return null;
}

/**
 * Poster field: pick a file → check type/size → `POST /admin/uploads/poster` → PUT to the
 * presigned URL with progress → hand the storage key to the form.
 */
export function PosterUploader({
  title,
  value,
  savedUrl,
  savedKey,
  onChange,
  onUploadingChange,
  error,
}: {
  title: string;
  /** Current form value. */
  value: string | null | undefined;
  /** URL of the poster already saved on the movie (edit form). */
  savedUrl: string | null;
  savedKey: string | null;
  onChange: (key: string | null) => void;
  onUploadingChange: (uploading: boolean) => void;
  error?: string;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ kind: 'idle' });
  const [preview, setPreview] = useState<string | null>(null);

  // Object URLs hold the file in memory until revoked.
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  const upload = async (file: File) => {
    const contentType = file.type;
    if (!isPosterContentType(contentType)) {
      setState({ kind: 'error', message: 'Chỉ nhận ảnh JPEG, PNG hoặc WebP.' });
      return;
    }
    const problem = sizeProblem(file);
    if (problem) {
      setState({ kind: 'error', message: problem });
      return;
    }
    setPreview(URL.createObjectURL(file));
    setState({ kind: 'uploading', percent: 0 });
    onUploadingChange(true);
    try {
      const { key, uploadUrl } = await presignPoster({ contentType, sizeBytes: file.size });
      await putToStorage(uploadUrl, file, (percent) => setState({ kind: 'uploading', percent }));
      onChange(key);
      setState({ kind: 'idle' });
    } catch (uploadError) {
      setPreview(null);
      setState({ kind: 'error', message: catalogErrorMessage(uploadError) });
    } finally {
      onUploadingChange(false);
    }
  };

  const remove = () => {
    setPreview(null);
    setState({ kind: 'idle' });
    onChange(null);
  };

  const shownUrl = preview ?? (value && value === savedKey ? savedUrl : null);
  const message = state.kind === 'error' ? state.message : error;

  return (
    <div className="space-y-2">
      <span className="block text-sm font-medium text-cream" id={`${inputId}-label`}>
        Poster
      </span>
      <div className="flex items-start gap-4">
        <MoviePoster
          title={title || 'Chưa có tên'}
          posterUrl={shownUrl}
          className="w-32 shrink-0"
        />
        <div className="min-w-0 space-y-3">
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={posterContentTypes.join(',')}
            className="sr-only"
            aria-labelledby={`${inputId}-label`}
            aria-describedby={`${inputId}-help`}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void upload(file);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="rounded-xl"
              disabled={state.kind === 'uploading'}
              onClick={() => inputRef.current?.click()}
            >
              <ImageUp aria-hidden />
              {value ? 'Đổi ảnh' : 'Chọn ảnh'}
            </Button>
            {value && state.kind !== 'uploading' && (
              <Button type="button" variant="ghost" className="rounded-xl" onClick={remove}>
                <X aria-hidden />
                Bỏ poster
              </Button>
            )}
          </div>
          {state.kind === 'uploading' && (
            <div className="space-y-1.5" role="status">
              <div className="flex items-center gap-2 text-sm text-cream">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Đang tải lên… {state.percent}%
              </div>
              <progress
                value={state.percent}
                max={100}
                aria-label="Tiến trình tải poster"
                className="h-1.5 w-48 overflow-hidden rounded-full [&::-moz-progress-bar]:bg-brand [&::-webkit-progress-bar]:bg-white/10 [&::-webkit-progress-value]:bg-brand"
              />
            </div>
          )}
          <p id={`${inputId}-help`} className="text-xs text-muted-foreground">
            JPEG, PNG hoặc WebP, tối đa 2 MB. Tỷ lệ 2:3 hiển thị đẹp nhất.
          </p>
          {message && (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
