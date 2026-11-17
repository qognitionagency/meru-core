// eslint-disable-next-line @typescript-eslint/no-require-imports
const https = require('https');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dnsModule = require('node:dns');
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { egressGuardedFetch } from './egress-guard';

// Owen's gate r6: the OpenAI SDK enforces its timeout and user aborts only
// through init.signal. Dropping `signal` from the http(s).request options
// passed the whole suite; this pins it.
describe('egressGuardedFetch — the caller\'s AbortSignal reaches the socket', () => {
  afterEach(() => jest.restoreAllMocks());
  it('passes init.signal to https.request', async () => {
    jest.spyOn(dnsModule.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const seen: any[] = [];
    jest.spyOn(https, 'request').mockImplementation(((opts: any, cb: any) => {
      seen.push(opts);
      const req: any = new EventEmitter();
      req.end = () => {
        const res: any = new PassThrough();
        res.statusCode = 200;
        res.headers = {};
        cb(res);
        res.end('ok');
      };
      return req;
    }) as any);
    const ac = new AbortController();
    await egressGuardedFetch('https://api.provider.example/v1', { signal: ac.signal });
    expect(seen).toHaveLength(1);
    expect(seen[0].signal).toBe(ac.signal);
  });
});
