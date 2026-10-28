import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  return (
    <section className="mx-auto max-w-5xl space-y-4 px-4 py-16">
      <h1 className="text-2xl font-semibold">Không tìm thấy trang</h1>
      <Button asChild variant="outline">
        <Link to="/">Về trang chủ</Link>
      </Button>
    </section>
  );
}
