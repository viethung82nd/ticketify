/**
 * Query parameters whose value never reaches a log line: the VNPay signature of the return URL
 * and the IPN (ROADMAP 3.3–3.4, CONTRIBUTING "never log a whole signed query").
 */
const SECRET_QUERY_PARAMS: ReadonlySet<string> = new Set(['vnp_SecureHash']);
const REDACTED = '[redacted]';

function decodedKey(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/** `url` with the value of every secret query parameter replaced; the rest is left as it is. */
export function redactUrl(url: string): string {
  const start = url.indexOf('?');
  if (start < 0) return url;
  const pairs = url
    .slice(start + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      return SECRET_QUERY_PARAMS.has(decodedKey(key)) ? `${key}=${REDACTED}` : pair;
    });
  return `${url.slice(0, start + 1)}${pairs.join('&')}`;
}

/** A parsed query with the value of every secret parameter replaced (a shallow copy). */
export function redactQuery(query: unknown): unknown {
  if (typeof query !== 'object' || query === null) return query;
  return Object.fromEntries(
    Object.entries(query).map(([key, value]) => [
      key,
      SECRET_QUERY_PARAMS.has(key) ? REDACTED : (value as unknown),
    ]),
  );
}

/** The request as pino-http's default serializer gives it (only the fields redacted here). */
interface SerializedRequest {
  url?: unknown;
  query?: unknown;
}

/** pino-http `serializers.req`: the default request fields, secret query values redacted. */
export function redactRequest<T extends SerializedRequest>(req: T): T {
  return {
    ...req,
    url: typeof req.url === 'string' ? redactUrl(req.url) : req.url,
    query: redactQuery(req.query),
  };
}
