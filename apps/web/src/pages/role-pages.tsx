import { ScanLine, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/features/auth/auth-store';

function Panel({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="mx-auto max-w-3xl px-4 py-16">
      <div className="rounded-3xl border border-white/10 bg-surface p-8">
        <div className="flex items-center gap-3">
          {icon}
          <h1 className="text-2xl font-bold text-cream">{title}</h1>
        </div>
        <div className="mt-4 space-y-4 text-muted-foreground">{children}</div>
      </div>
    </section>
  );
}

export function ForbiddenPage() {
  return (
    <Panel
      icon={<ShieldAlert className="size-7 text-destructive" aria-hidden />}
      title="Không có quyền truy cập"
    >
      <p>Tài khoản của bạn không được phép xem trang này (lỗi 403).</p>
      <Button asChild variant="outline" className="rounded-xl">
        <Link to="/">Về trang chủ</Link>
      </Button>
    </Panel>
  );
}

/** ADMIN only. CRUD screens arrive with tasks 1.8–1.17. */
export function AdminPage() {
  const user = useAuthStore((state) => state.user);
  return (
    <Panel icon={<ShieldCheck className="size-7 text-brand" aria-hidden />} title="Trang quản trị">
      <p>
        Xin chào {user?.fullName}. Quản lý phim, phòng chiếu, suất chiếu và bảng giá sẽ có ở đây.
      </p>
    </Panel>
  );
}

/** STAFF and ADMIN. QR check-in arrives in phase 4. */
export function StaffPage() {
  const user = useAuthStore((state) => state.user);
  return (
    <Panel icon={<ScanLine className="size-7 text-brand" aria-hidden />} title="Soát vé">
      <p>Xin chào {user?.fullName}. Màn hình quét mã QR để soát vé sẽ có ở giai đoạn 4.</p>
    </Panel>
  );
}
