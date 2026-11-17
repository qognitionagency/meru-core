// The real module objects, so jest can redefine `request`; the egress
// guard's own `import * as` reads through to these at call time.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require('http');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const https = require('https');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dnsModule = require('node:dns');
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationStatus, NotificationType } from './entities/notification.entity';
import { guardedLookup } from '../common/egress-guard';

/**
 * Notification webhook SSRF (Owen's gate, 2026-11-17; HIGH). Any staff user
 * can `POST /notifications` with `type: webhook` and a `metadata.url`; the
 * dispatcher POSTed the notification there with the global `fetch` — no host
 * check, redirects followed — and stored the exception text on the row, so
 * staff could aim it at cloud metadata or the private network and read back
 * which internal addresses answered.
 *
 * Now: the URL goes through the egress guard (scheme, literal, DNS, and the
 * dial-time lookup), a redirect is not followed, and the stored attempt
 * carries a fixed reason; the detail is logged.
 */
describe('NotificationDispatchService — webhook egress', () => {
  let httpReq: jest.SpyInstance;
  let httpsReq: jest.SpyInstance;
  let globalFetch: jest.SpyInstance;
  const calls: any[] = [];
  let respond: { status: number; headers?: Record<string, string> } | Error = { status: 200 };

  function fakeRequest(opts: any, cb: (res: any) => void) {
    calls.push(opts);
    const req: any = new EventEmitter();
    req.end = () => {
      if (respond instanceof Error) {
        const e = respond;
        setImmediate(() => req.emit('error', e));
        return;
      }
      const res: any = new PassThrough();
      res.statusCode = respond.status;
      res.headers = respond.headers ?? {};
      cb(res);
      res.end('');
    };
    req.destroy = jest.fn();
    return req;
  }

  beforeEach(() => {
    calls.length = 0;
    respond = { status: 200 };
    httpReq = jest.spyOn(http, 'request').mockImplementation(fakeRequest as any);
    httpsReq = jest.spyOn(https, 'request').mockImplementation(fakeRequest as any);
    globalFetch = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('ok'));
    jest
      .spyOn(dnsModule.promises, 'lookup')
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });
  afterEach(() => jest.restoreAllMocks());

  function build() {
    const repo = { save: jest.fn(async (n: any) => n) };
    const svc = new NotificationDispatchService(repo as any, {} as any, {} as any);
    const logs: string[] = [];
    (svc as any).logger = {
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
      log: () => undefined,
    };
    return { svc, repo, logs };
  }

  const row = (metadata: Record<string, unknown>) =>
    ({
      id: 'n1',
      tenantId: 't1',
      type: NotificationType.WEBHOOK,
      status: NotificationStatus.PENDING,
      metadata,
      deliveryAttempts: [],
      retryCount: 0,
    }) as any;

  it.each([
    ['metadata.url at cloud metadata', { url: 'http://169.254.169.254/latest/meta-data/' }],
    ['metadata.customData.url on RFC1918', { customData: { url: 'http://10.0.0.5:8080/admin' } }],
    ['a non-http scheme', { url: 'file:///etc/passwd' }],
  ])('refuses %s before any request, and stores no address', async (_l, metadata) => {
    const { svc, logs } = build();
    const n = row(metadata);

    const outcome = await (svc as any).deliverOne(n);

    expect(outcome).toBe('failed');
    expect(httpReq).not.toHaveBeenCalled();
    expect(httpsReq).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    const stored = JSON.stringify(n.deliveryAttempts);
    expect(stored).toContain('webhook target refused by egress policy');
    expect(stored).not.toMatch(/169\.254|10\.0\.0\.5|etc\/passwd|non-public|not publicly/);
    expect(logs.join('\n')).toContain('n1');
  });

  it('dials a public receiver through the guarded lookup and records success', async () => {
    const { svc } = build();
    const n = row({ url: 'https://hooks.receiver.example/meru' });

    expect(await (svc as any).deliverOne(n)).toBe('delivered');
    expect(calls).toHaveLength(1);
    expect(calls[0].lookup).toBe(guardedLookup);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(n.status).toBe(NotificationStatus.SENT);
  });

  it('does not follow a redirect inward, and stores no Location', async () => {
    respond = { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } };
    const { svc } = build();
    const n = row({ url: 'https://hooks.receiver.example/meru' });

    expect(await (svc as any).deliverOne(n)).toBe('failed');
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(n.deliveryAttempts)).not.toContain('169.254');
  });

  it('stores a fixed reason for a transport error, not its text', async () => {
    respond = Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:443 via internal-proxy.corp'), {
      code: 'ECONNREFUSED',
    });
    const { svc, logs } = build();
    const n = row({ url: 'https://hooks.receiver.example/meru' });

    expect(await (svc as any).deliverOne(n)).toBe('failed');
    const stored = JSON.stringify(n.deliveryAttempts);
    expect(stored).toContain('webhook request failed');
    expect(stored).not.toContain('internal-proxy');
    expect(stored).not.toContain('ECONNREFUSED');
    expect(logs.join('\n')).toContain('internal-proxy');
  });

  it('keeps the receiver status code, which is the receiver telling us, not us probing', async () => {
    respond = { status: 503 };
    const { svc } = build();
    const n = row({ url: 'https://hooks.receiver.example/meru' });
    await (svc as any).deliverOne(n);
    expect(JSON.stringify(n.deliveryAttempts)).toContain('webhook returned HTTP 503');
  });
});
