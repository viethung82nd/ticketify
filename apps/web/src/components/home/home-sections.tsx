import { MovieStatus } from '@ticketify/shared';
import { ArrowRight, MapPin } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { BookingStepper } from '@/components/booking/booking-stepper';
import { MovieGrid } from '@/components/catalog/movie-grid';
import { useMovies } from '@/features/catalog/use-catalog';

/** Thin announcement strip between the hero and the catalog. */
export function PromoBanner() {
  return (
    <div className="border-y border-white/10 bg-surface/80">
      <p className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-3.5 text-center text-sm text-cream">
        <span className="font-medium">
          Ghế bạn chọn được giữ 10 phút trong lúc thanh toán — không ai đặt mất.
        </span>
        <Link to="/#rap" className="font-semibold text-brand underline-offset-4 hover:underline">
          Xem thêm
        </Link>
      </p>
    </div>
  );
}

function SectionHeading({
  id,
  title,
  description,
  action,
}: {
  id: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1.5">
        <h2 id={id} className="text-2xl font-bold text-cream sm:text-3xl">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground sm:text-base">{description}</p>
      </div>
      {action}
    </div>
  );
}

/** First 8 NOW_SHOWING movies, newest release first (same order as /movies). */
const NOW_SHOWING_QUERY = { status: MovieStatus.NOW_SHOWING, pageSize: 8 };

export function NowShowing() {
  const { data, isPending, error, refetch } = useMovies(NOW_SHOWING_QUERY);

  return (
    <section aria-labelledby="dang-chieu" className="mx-auto max-w-6xl scroll-mt-28 px-4 pt-20">
      <SectionHeading
        id="dang-chieu"
        title="Đang chiếu"
        description="Phim mới nhất đang chiếu tại rạp — đặt vé ngay hôm nay."
        action={
          <Link
            to={`/movies?status=${MovieStatus.NOW_SHOWING}`}
            className="flex items-center gap-1 rounded-lg text-sm font-semibold text-brand underline-offset-4 hover:underline"
          >
            Xem tất cả <ArrowRight className="size-4" aria-hidden />
          </Link>
        }
      />
      <div className="mt-8">
        <MovieGrid
          movies={data?.items}
          isPending={isPending}
          error={error}
          onRetry={() => void refetch()}
          empty="Hiện chưa có phim đang chiếu. Hãy quay lại sau nhé."
        />
      </div>
    </section>
  );
}

export function HowItWorks() {
  return (
    <section aria-labelledby="rap" className="mx-auto max-w-6xl scroll-mt-28 px-4 pt-20">
      <SectionHeading
        id="rap"
        title="Đặt vé trong 4 bước"
        description="Một rạp, nhiều phòng chiếu. Ghế được giữ cho bạn trong lúc thanh toán."
      />
      <div className="mt-8 grid gap-6 rounded-2xl bg-surface p-6 sm:p-8 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <BookingStepper current={0} />
          <p className="text-sm leading-relaxed text-muted-foreground">
            Chọn suất chiếu, chọn ghế trên sơ đồ (Thường, VIP hoặc ghế Đôi), thêm combo nếu muốn,
            thanh toán qua VNPay và nhận vé có mã QR qua email.
          </p>
        </div>
        <div className="flex items-start gap-3 rounded-xl border border-white/10 p-4">
          <MapPin className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden />
          <div className="space-y-1 text-sm">
            <p className="font-semibold text-cream">Rạp Ticketify</p>
            <p className="text-muted-foreground">Địa chỉ và lịch chiếu sẽ có ở giai đoạn 1.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
