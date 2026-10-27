import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useHealth } from '@/features/health/use-health';
import { env } from '@/lib/env';

const SERVICE_LABELS: Record<string, string> = { database: 'PostgreSQL', redis: 'Redis' };

export function StatusPage() {
  const { data, error, isPending, isFetching, refetch } = useHealth();

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Trạng thái hệ thống</CardTitle>
        <CardDescription>
          Gọi <code>GET {env.VITE_API_URL}/health</code> từ trình duyệt.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isPending && <p className="text-sm text-muted-foreground">Đang kiểm tra…</p>}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            Không gọi được API: {error.message}
          </p>
        )}

        {data && (
          <>
            <p className="flex items-center gap-2 text-sm">
              API
              <Badge variant={data.healthy ? 'default' : 'destructive'}>
                {data.healthy ? 'Hoạt động' : 'Có sự cố'}
              </Badge>
            </p>
            <ul className="divide-y rounded-md border">
              {data.services.map((service) => (
                <li key={service.name} className="flex items-center justify-between px-3 py-2">
                  <span>{SERVICE_LABELS[service.name] ?? service.name}</span>
                  <span className="flex items-center gap-2">
                    {service.message && (
                      <span className="text-xs text-muted-foreground">{service.message}</span>
                    )}
                    <Badge variant={service.up ? 'secondary' : 'destructive'}>
                      {service.up ? 'up' : 'down'}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={isFetching ? 'animate-spin' : undefined} aria-hidden />
          Kiểm tra lại
        </Button>
      </CardContent>
    </Card>
  );
}
