/**
 * Query parameters left out of every log line, name and value: the VNPay signature of the return
 * URL and the IPN (ROADMAP 3.3–3.4, CONTRIBUTING "never log a whole signed query").
 */
const SECRET_QUERY_PARAMS: ReadonlySet<string> = new Set(['vnp_SecureHash']);

function decodedKey(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/** `url` without the secret query parameters; every other part is left as it is. */
export function redactUrl(url: string): string {
  const start = url.indexOf('?');
  if (start < 0) return url;
  const pairs = url
    .slice(start + 1)
    .split('&')
    .filter((pair) => {
      const eq = pair.indexOf('=');
      return !SECRET_QUERY_PARAMS.has(decodedKey(eq < 0 ? pair : pair.slice(0, eq)));
    });
  const path = url.slice(0, start);
  return pairs.length > 0 ? `${path}?${pairs.join('&')}` : path;
}

/** A parsed query without the secret parameters (a shallow copy). */
export function redactQuery(query: unknown): unknown {
  if (typeof query !== 'object' || query === null) return query;
  return Object.fromEntries(Object.entries(query).filter(([key]) => !SECRET_QUERY_PARAMS.has(key)));
}

/** The request as pino-http's default serializer gives it (only the fields redacted here). */
interface SerializedRequest {
  url?: unknown;
  query?: unknown;
}

/** pino-http `serializers.req`: the default request fields, secret query parameters left out. */
export function redactRequest<T extends SerializedRequest>(req: T): T {
  return {
    ...req,
    url: typeof req.url === 'string' ? redactUrl(req.url) : req.url,
    query: redactQuery(req.query),
  };
}
