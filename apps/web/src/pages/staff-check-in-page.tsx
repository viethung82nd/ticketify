import { type CheckInResponse, CheckInResult, type CheckedTicket } from '@ticketify/shared';
import {
  Camera,
  CameraOff,
  CircleCheck,
  CircleX,
  Keyboard,
  ScanLine,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/features/auth/auth-store';
import { checkInTicket } from '@/features/tickets/tickets-api';
import { useQrScanner } from '@/features/tickets/use-qr-scanner';
import { cinemaDate, cinemaTime } from '@/lib/cinema-time';

/** How each verdict is shown: one colour, one sentence, no jargon. */
const VERDICTS: Record<CheckInResult, { tone: string; title: string; note: string }> = {
  [CheckInResult.OK]: {
    tone: 'border-brand/60 bg-brand/10',
    title: 'Vé hợp lệ — mời vào',
    note: 'Vé đã được ghi nhận. Mỗi mã chỉ dùng được một lần.',
  },
  [CheckInResult.ALREADY_USED]: {
    tone: 'border-amber-400/60 bg-amber-400/10',
    title: 'Vé đã được dùng',
    note: 'Mã này đã soát trước đó. Kiểm tra lại với khách.',
  },
  [CheckInResult.WRONG_SHOWTIME]: {
    tone: 'border-amber-400/60 bg-amber-400/10',
    title: 'Sai suất chiếu',
    note: 'Vé thật, nhưng của suất khác. Vé vẫn dùng được ở cửa đúng.',
  },
  [CheckInResult.VOID]: {
    tone: 'border-destructive/60 bg-destructive/10',
    title: 'Vé đã bị hủy',
    note: 'Vé này không còn giá trị.',
  },
  [CheckInResult.NOT_FOUND]: {
    tone: 'border-destructive/60 bg-destructive/10',
    title: 'Không tìm thấy vé',
    note: 'Mã không tồn tại hoặc mã QR không phải của rạp này.',
  },
};

function TicketCard({ ticket }: { ticket: CheckedTicket }) {
  return (
    <dl className="mt-3 grid gap-1.5 text-sm">
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">Phim</dt>
        <dd className="text-right font-semibold text-cream">{ticket.movieTitle}</dd>
      </div>
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">Suất</dt>
        <dd className="text-right text-cream">
          {cinemaTime(ticket.showtimeStartsAt)} · {cinemaDate(ticket.showtimeStartsAt)}
        </dd>
      </div>
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">Phòng · ghế</dt>
        <dd className="text-right font-semibold text-cream">
          {ticket.roomName} · {ticket.seatLabel}
        </dd>
      </div>
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">Mã vé</dt>
        <dd className="text-right font-mono text-cream">{ticket.code}</dd>
      </div>
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">Mã đơn</dt>
        <dd className="text-right text-cream">{ticket.bookingCode}</dd>
      </div>
      {ticket.checkedInAt && (
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Đã soát lúc</dt>
          <dd className="text-right text-cream">
            {cinemaTime(ticket.checkedInAt)} · {cinemaDate(ticket.checkedInAt)}
          </dd>
        </div>
      )}
    </dl>
  );
}

function Verdict({ response }: { response: CheckInResponse }) {
  const verdict = VERDICTS[response.result];
  const ok = response.result === CheckInResult.OK;
  const bad = response.result === CheckInResult.NOT_FOUND || response.result === CheckInResult.VOID;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="check-in-verdict"
      data-result={response.result}
      className={`rounded-2xl border p-5 ${verdict.tone}`}
    >
      <div className="flex items-center gap-3">
        {ok ? (
          <CircleCheck className="size-7 shrink-0 text-brand" aria-hidden />
        ) : bad ? (
          <CircleX className="size-7 shrink-0 text-destructive" aria-hidden />
        ) : (
          <TriangleAlert className="size-7 shrink-0 text-amber-400" aria-hidden />
        )}
        <div>
          <p className="text-lg font-bold text-cream">{verdict.title}</p>
          <p className="text-sm text-muted-foreground">{verdict.note}</p>
        </div>
      </div>
      {response.ticket && <TicketCard ticket={response.ticket} />}
    </div>
  );
}

/**
 * `/staff` (ROADMAP 4.8): check-in for staff.
 *
 * Two ways in, both ending in the same request: the camera (the browser's own QR decoding) and a
 * code typed by hand. The typed field is always there — it is the fallback when a QR is torn,
 * a phone screen is too dark, or the browser cannot use the camera at all.
 *
 * Every verdict comes back as HTTP 200, so there is one place to render and no error handling in
 * the happy path; only a network or permission problem becomes a message of its own.
 */
export function StaffCheckInPage() {
  const user = useAuthStore((state) => state.user);
  const [response, setResponse] = useState<CheckInResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async (body: { token?: string; code?: string }) => {
    setBusy(true);
    setFailure(null);
    try {
      setResponse(await checkInTicket(body));
    } catch {
      setResponse(null);
      setFailure('Không gửi được yêu cầu soát vé. Kiểm tra kết nối rồi thử lại.');
    } finally {
      setBusy(false);
    }
  }, []);

  const onScan = useCallback(
    (value: string) => {
      void submit({ token: value });
    },
    [submit],
  );
  const {
    phase: scanPhase,
    error: scanError,
    attachVideo,
    start: startScan,
    stop: stopScan,
  } = useQrScanner(onScan);

  const submitCode = (event: React.FormEvent) => {
    event.preventDefault();
    const typed = code.trim();
    if (!typed) return;
    setCode('');
    void submit({ code: typed });
  };

  return (
    <section className="mx-auto max-w-3xl space-y-6 px-4 py-10 sm:px-6">
      <header className="flex items-center gap-3">
        <ScanLine className="size-7 text-brand" aria-hidden />
        <div>
          <h1 className="text-2xl font-bold text-cream">Soát vé</h1>
          <p className="text-sm text-muted-foreground">
            Xin chào {user?.fullName}. Quét mã QR trên vé, hoặc nhập mã vé bằng tay.
          </p>
        </div>
      </header>

      <div className="space-y-4 rounded-3xl border border-white/10 bg-surface p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-semibold text-cream">
            <Camera className="size-5 text-brand" aria-hidden />
            Quét bằng camera
          </h2>
          {scanPhase === 'scanning' ? (
            <Button variant="outline" className="rounded-xl" onClick={stopScan}>
              <CameraOff className="size-4" aria-hidden />
              Tắt camera
            </Button>
          ) : (
            <Button
              className="rounded-xl"
              onClick={startScan}
              disabled={scanPhase === 'unsupported' || scanPhase === 'starting'}
            >
              <Camera className="size-4" aria-hidden />
              {scanPhase === 'starting' ? 'Đang mở…' : 'Mở camera'}
            </Button>
          )}
        </div>

        {scanPhase === 'unsupported' && (
          <p className="text-sm text-muted-foreground">
            Trình duyệt này không giải mã được QR. Hãy dùng Chrome hoặc Edge, hoặc nhập mã vé bằng
            tay ở dưới.
          </p>
        )}
        {scanError && <p className="text-sm text-destructive">{scanError}</p>}

        <div
          className={
            scanPhase === 'scanning'
              ? 'overflow-hidden rounded-2xl border border-brand/40'
              : 'hidden'
          }
        >
          {/* A live camera preview: nothing to caption, and it is decorative next to the verdict. */}
          <video
            ref={attachVideo}
            muted
            playsInline
            aria-label="Hình ảnh từ camera để quét mã QR"
            className="aspect-video w-full bg-black object-cover"
          />
        </div>
      </div>

      <form
        onSubmit={submitCode}
        className="space-y-3 rounded-3xl border border-white/10 bg-surface p-5"
      >
        <h2 className="flex items-center gap-2 font-semibold text-cream">
          <Keyboard className="size-5 text-brand" aria-hidden />
          Nhập mã vé
        </h2>
        <div className="flex gap-3">
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Ví dụ: K7PXA1B2C3D4"
            aria-label="Mã vé"
            autoComplete="off"
            spellCheck={false}
            className="h-11 font-mono uppercase"
          />
          <Button
            type="submit"
            disabled={busy || code.trim() === ''}
            className="h-11 rounded-xl px-6"
          >
            Soát vé
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Mã vé in dưới mã QR trên vé PDF, không phân biệt chữ hoa chữ thường.
        </p>
      </form>

      {failure && (
        <p
          role="alert"
          className="rounded-2xl border border-destructive/60 bg-destructive/10 p-4 text-sm text-cream"
        >
          {failure}
        </p>
      )}
      {response && <Verdict response={response} />}
    </section>
  );
}
