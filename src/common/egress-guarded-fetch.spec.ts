// The real module objects, so jest can redefine `request`; the guard's own
// `import * as` reads through to these at call time.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require('http');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const https = require('https');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dnsModule = require('node:dns');
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { AddressInfo } from 'net';
import {
  EgressRefusedError,
  egressGuardedFetch,
  guardedLookup,
} from './egress-guard';

/**
 * The AI connector's `fetch` (w1-08, Owen's gate). It used to check the host
 * and then call the global `fetch`, which resolves the name again on its own
 * — so a DNS server answering public first and private second (rebinding)
 * could swap the address between the check and the connect. It now dials
 * through `http(s).request` with `guardedLookup`, the same as the workflow
 * webhook, so the address connected to is the address checked. No new
 * dependency.
 */
describe('egressGuardedFetch — the dialled address is the checked one', () => {
  afterEach(() => jest.restoreAllMocks());

  it('refuses a host that resolves public for the check and loopback at dial time; nothing connects', async () => {
    let connections = 0;
    const server = http.createServer((_req: any, res: any) => res.end('reached'));
    server.on('connection', () => (connections += 1));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;

    jest
      .spyOn(dnsModule.promises, 'lookup')
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const realLookup = dnsModule.lookup;
    jest.spyOn(dnsModule, 'lookup').mockImplementation(((host: string, opts: any, cb: any) => {
      if (typeof opts === 'function') {
        cb = opts;
        opts = {};
      }
      if (host === 'rebind.example') {
        const answer = [{ address: '127.0.0.1', family: 4 }];
        return opts?.all ? cb(null, answer) : cb(null, '127.0.0.1', 4);
      }
      return realLookup(host, opts, cb);
    }) as any);

    try {
      const err = await egressGuardedFetch(`http://rebind.example:${port}/v1/chat`).then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(EgressRefusedError);
      expect(connections).toBe(0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  function fakeRequest(status: number, headers: Record<string, string | string[]>, body: string) {
    const calls: Array<{ opts: any; written: Buffer[] }> = [];
    const impl = (opts: any, cb: (res: any) => void) => {
      const call = { opts, written: [] as Buffer[] };
      calls.push(call);
      const req: any = new EventEmitter();
      req.write = (chunk: any) => call.written.push(Buffer.from(chunk));
      req.end = (chunk?: any) => {
        if (chunk) call.written.push(Buffer.from(chunk));
        const res: any = new PassThrough();
        res.statusCode = status;
        res.statusMessage = 'X';
        res.headers = headers;
        cb(res);
        res.end(body);
      };
      req.destroy = jest.fn();
      return req;
    };
    return { calls, impl };
  }

  it('dials through guardedLookup, forwards method, headers and body, and returns a real Response', async () => {
    jest
      .spyOn(dnsModule.promises, 'lookup')
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const f = fakeRequest(200, { 'content-type': 'application/json', 'x-request-id': 'r1' }, '{"ok":true}');
    jest.spyOn(https, 'request').mockImplementation(f.impl as any);

    const res = await egressGuardedFetch('https://api.provider.example/v1/chat?x=1', {
      method: 'POST',
      headers: { authorization: 'Bearer test-placeholder', 'content-type': 'application/json' },
      body: '{"model":"m"}',
    });

    expect(f.calls).toHaveLength(1);
    const { opts, written } = f.calls[0];
    expect(opts.lookup).toBe(guardedLookup);
    expect(opts.hostname).toBe('api.provider.example');
    expect(opts.path).toBe('/v1/chat?x=1');
    expect(opts.method).toBe('POST');
    expect(opts.headers.authorization).toBe('Bearer test-placeholder');
    expect(Buffer.concat(written).toString()).toBe('{"model":"m"}');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('r1');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('never follows a redirect: a 3xx is refused after one request', async () => {
    jest
      .spyOn(dnsModule.promises, 'lookup')
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const f = fakeRequest(302, { location: 'http://169.254.169.254/latest/meta-data/' }, '');
    jest.spyOn(https, 'request').mockImplementation(f.impl as any);

    await expect(
      egressGuardedFetch('https://api.provider.example/v1', { redirect: 'follow' } as any),
    ).rejects.toBeInstanceOf(EgressRefusedError);
    expect(f.calls).toHaveLength(1);
  });

  it('refuses a private literal before any request is opened', async () => {
    const spy = jest.spyOn(http, 'request');
    await expect(egressGuardedFetch('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(
      EgressRefusedError,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('strips the brackets from an IPv6 literal host', async () => {
    const f = fakeRequest(204, {}, '');
    jest.spyOn(https, 'request').mockImplementation(f.impl as any);
    const res = await egressGuardedFetch('https://[2606:4700:4700::1111]/');
    expect(f.calls[0].opts.hostname).toBe('2606:4700:4700::1111');
    expect(res.status).toBe(204);
  });
});
