import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

export function HomePage() {
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">Ticketify</h1>
      <p className="max-w-prose text-muted-foreground">
        Đặt vé xem phim thời gian thực. Danh sách phim và lịch chiếu sẽ có ở giai đoạn 1.
      </p>
      <Button asChild variant="outline">
        <Link to="/status">Kiểm tra kết nối tới API</Link>
      </Button>
    </section>
  );
}
