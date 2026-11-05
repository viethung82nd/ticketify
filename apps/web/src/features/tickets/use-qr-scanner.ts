import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Reading a QR code off the camera with the browser's own `BarcodeDetector` (ROADMAP 4.8).
 *
 * No scanning library: `BarcodeDetector` is built into Chrome and Edge, which is what a cinema's
 * check-in tablet runs, and every screen that uses this also offers typing the code by hand — so
 * a browser without it loses the convenience, not the ability to work. Swapping in a library
 * (`@zxing/browser`) later would only touch this file.
 *
 * The caller attaches `attachVideo` to its `<video>`; the hook keeps the element, fills it with
 * a camera stream and reads frames out of it.
 *
 * - `phase` says what the screen should show; `error` is a sentence for the person, not a stack.
 * - `onScan` gets each decoded value. The same value is ignored for `REPEAT_GUARD_MS` after it
 *   was reported, so one ticket held in front of the lens is not scanned thirty times a second.
 */

export type ScannerPhase = 'idle' | 'starting' | 'scanning' | 'unsupported' | 'failed';

/** How long the same decoded value is ignored after it was reported once. */
const REPEAT_GUARD_MS = 2_500;
const FRAME_INTERVAL_MS = 250;

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect: (this: void, source: CanvasImageSource) => Promise<DetectedBarcode[]>;
}

type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

const detectorClass = (): BarcodeDetectorConstructor | undefined =>
  (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;

/** `true` when this browser can decode a QR from the camera without any extra library. */
export const qrScanningSupported = (): boolean =>
  detectorClass() !== undefined && typeof navigator.mediaDevices?.getUserMedia === 'function';

export interface QrScanner {
  phase: ScannerPhase;
  error?: string;
  /** Put this on the `<video>` that should show the camera. */
  attachVideo: (element: HTMLVideoElement | null) => void;
  start: () => void;
  stop: () => void;
}

export function useQrScanner(onScan: (value: string) => void): QrScanner {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastRef = useRef<{ value: string; at: number } | null>(null);
  const onScanRef = useRef(onScan);
  const [phase, setPhase] = useState<ScannerPhase>(qrScanningSupported() ? 'idle' : 'unsupported');
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  const stop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const element = videoRef.current;
    if (element) element.srcObject = null;
    setPhase((current) => (current === 'unsupported' ? current : 'idle'));
  }, []);

  // Never leave the camera on when the screen goes away.
  useEffect(() => stop, [stop]);

  const start = useCallback(() => {
    const Detector = detectorClass();
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      setPhase('unsupported');
      return;
    }
    setPhase('starting');
    setError(undefined);

    const read = async (detector: BarcodeDetectorLike): Promise<string | undefined> => {
      const element = videoRef.current;
      if (!element || element.readyState < 2) return undefined;
      try {
        const codes = await detector.detect(element);
        return codes[0]?.rawValue.trim();
      } catch {
        // A frame the detector could not read; the next one is 250 ms away.
        return undefined;
      }
    };

    const begin = async (): Promise<void> => {
      const stream = await navigator.mediaDevices.getUserMedia({
        // The back camera of a tablet or phone; a laptop simply gives its only one.
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      const element = videoRef.current;
      if (!element) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      element.srcObject = stream;
      await element.play();

      const detector = new Detector({ formats: ['qr_code'] });
      setPhase('scanning');
      timerRef.current = setInterval(() => {
        void read(detector).then((value) => {
          if (!value) return;
          const last = lastRef.current;
          const now = Date.now();
          if (last && last.value === value && now - last.at < REPEAT_GUARD_MS) return;
          lastRef.current = { value, at: now };
          onScanRef.current(value);
        });
      }, FRAME_INTERVAL_MS);
    };

    begin().catch((cause: unknown) => {
      stop();
      setPhase('failed');
      setError(
        cause instanceof DOMException && cause.name === 'NotAllowedError'
          ? 'Trình duyệt chưa được phép dùng camera. Hãy cấp quyền rồi thử lại.'
          : 'Không mở được camera. Bạn vẫn có thể nhập mã vé bằng tay.',
      );
    });
  }, [stop]);

  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
  }, []);

  return { phase, error, attachVideo, start, stop };
}
