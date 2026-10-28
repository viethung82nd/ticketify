import { Link } from 'react-router';
import { Logo } from '@/components/brand/logo';

interface FooterColumn {
  title: string;
  /** Items with `to` are live routes; the rest are pages planned for later phases. */
  items: { label: string; to?: string }[];
}

const COLUMNS: FooterColumn[] = [
  {
    title: 'Phim',
    items: [
      { label: 'Đang chiếu', to: '/#dang-chieu' },
      { label: 'Sắp chiếu' },
      { label: 'Lịch chiếu' },
    ],
  },
  {
    title: 'Rạp',
    items: [
      { label: 'Thông tin rạp', to: '/#rap' },
      { label: 'Giá vé' },
      { label: 'Combo bắp nước' },
    ],
  },
  {
    title: 'Công ty',
    items: [{ label: 'Giới thiệu' }, { label: 'Tuyển dụng' }, { label: 'Liên hệ' }],
  },
  {
    title: 'Hỗ trợ',
    items: [
      { label: 'Câu hỏi thường gặp' },
      { label: 'Điều khoản sử dụng' },
      { label: 'Trạng thái hệ thống', to: '/status' },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-white/10 bg-black">
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-10 px-6 py-14 md:grid-cols-[1.4fr_repeat(4,1fr)]">
        <div className="col-span-2 space-y-3 md:col-span-1">
          <Logo />
          <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
            Đặt vé xem phim thời gian thực: chọn ghế, giữ chỗ và thanh toán trong vài phút.
          </p>
        </div>
        {COLUMNS.map((column) => (
          <div key={column.title} className="space-y-3">
            <h2 className="text-sm font-semibold text-cream">{column.title}</h2>
            <ul className="space-y-2 text-sm text-muted-foreground">
              {column.items.map((item) => (
                <li key={item.label}>
                  {item.to ? (
                    <Link to={item.to} className="transition-colors hover:text-cream">
                      {item.label}
                    </Link>
                  ) : (
                    item.label
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-white/10">
        <p className="mx-auto max-w-6xl px-6 py-5 text-xs text-muted-foreground">
          © 2026 Ticketify · Dự án portfolio, không phải dịch vụ bán vé thật.
        </p>
      </div>
    </footer>
  );
}
