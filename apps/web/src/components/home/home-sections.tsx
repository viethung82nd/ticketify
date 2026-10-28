import { ArrowRight, Clapperboard, MapPin } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { BookingStepper } from '@/components/booking/booking-stepper';

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

/** Titles from the dev seed (fictional); real data arrives with the movie API (task 1.8). */
const PLACEHOLDER_MOVIES = [
  { title: 'Mùa Hạ Cuối Cùng', meta: 'Tình cảm · 112 phút', rating: 'T13' },
  { title: 'Biệt Đội Sao Băng', meta: 'Hành động · 128 phút', rating: 'T16' },
  { title: 'Căn Nhà Số 13', meta: 'Kinh dị · 104 phút', rating: 'T18' },
  { title: 'Chú Mèo Và Ngọn Hải Đăng', meta: 'Hoạt hình · 95 phút · Sắp chiếu', rating: 'P' },
];

export function NowShowing() {
  return (
    <section aria-labelledby="dang-chieu" className="mx-auto max-w-6xl scroll-mt-28 px-4 pt-20">
      <SectionHeading
        id="dang-chieu"
        title="Đang chiếu"
        description="Phim mới nhất đang chiếu tại rạp — đặt vé ngay hôm nay."
        action={
          <span className="flex items-center gap-1 text-sm text-muted-foreground">
            Xem tất cả <ArrowRight className="size-4" aria-hidden />
            <span className="sr-only">(sắp có)</span>
          </span>
        }
      />
      <ul className="mt-8 grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-4">
        {PLACEHOLDER_MOVIES.map((movie) => (
          <li key={movie.title} className="overflow-hidden rounded-2xl bg-surface">
            <div className="relative flex aspect-[2/3] flex-col items-center justify-center gap-3 bg-gradient-to-b from-[#2a2a2a] to-[#1a1a1a] p-4 text-center">
              <Clapperboard className="size-8 text-white/30" aria-hidden />
              <span className="text-sm font-semibold text-white/70">{movie.title}</span>
              <span className="absolute top-3 left-3 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-bold text-brand">
                {movie.rating}
              </span>
            </div>
            <div className="space-y-1 p-4">
              <h3 className="truncate font-semibold text-cream">{movie.title}</h3>
              <p className="text-xs text-muted-foreground">{movie.meta}</p>
            </div>
          </li>
        ))}
      </ul>
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
