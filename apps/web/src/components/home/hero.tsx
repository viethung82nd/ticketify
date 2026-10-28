import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

/**
 * Facts about how Ticketify works (PLAN §1), not marketing numbers.
 */
const FACTS = [
  { value: '10 phút', label: 'Giữ ghế trong khi thanh toán' },
  { value: '6 ghế', label: 'Tối đa cho mỗi đơn' },
  { value: '0 vé trùng', label: 'Mỗi ghế chỉ bán một lần' },
];

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden px-4 pt-20 pb-16 sm:pt-28">
      {/* Glow: dark green + faint yellow behind the title. No photography. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 left-1/2 h-[520px] w-[880px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(46_92_52/0.55),transparent)] blur-2xl" />
        <div className="absolute top-24 left-[58%] h-[260px] w-[420px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(252_252_101/0.14),transparent)] blur-2xl" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-background" />
      </div>

      <div className="mx-auto max-w-4xl text-center">
        <h1 className="text-4xl leading-[1.1] font-extrabold tracking-tight text-cream uppercase sm:text-6xl lg:text-7xl">
          Đặt vé xem phim
          <br />
          ngay hôm nay!
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-base text-muted-foreground sm:text-lg">
          Xem những bộ phim mới nhất tại rạp yêu thích. Chọn ghế trực tiếp trên sơ đồ, ghế được giữ
          cho bạn trong lúc thanh toán.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Button asChild className="h-11 rounded-xl px-5 text-sm font-semibold">
            <Link to="/movies">
              Khám phá phim
              <ArrowRight aria-hidden />
            </Link>
          </Button>
          <Link
            to="/#rap"
            className="rounded-xl px-4 py-3 text-sm font-medium text-cream underline-offset-4 hover:underline"
          >
            Tìm rạp
          </Link>
        </div>
      </div>

      <dl className="mx-auto mt-16 grid max-w-4xl grid-cols-1 gap-8 sm:grid-cols-3">
        {FACTS.map((fact) => (
          <div key={fact.label} className="flex flex-col-reverse items-center gap-1 text-center">
            <dt className="text-sm text-muted-foreground">{fact.label}</dt>
            <dd className="text-3xl font-bold text-white sm:text-4xl">{fact.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
