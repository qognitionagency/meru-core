// The real module objects: `import * as` yields a frozen namespace that
// jest cannot redefine `request` on, while the service's own `import * as`
// reads through to these at call time.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require('http');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const https = require('https');
import { EventEmitter } from 'events';
import { WorkflowEngineService } from './workflow.service';
import { EgressRefusedError, guardedLookup } from '../common/egress-guard';

/**
 * The workflow `webhook` action sent the instance's full `context` to any URL
 * in its config, with no host check (Anton, 2026-11-17, #14). Latent today —
 * pack materialisation writes `actions: []` and `POST /workflows` rejects
 * every body — but it becomes reachable the moment either changes, so it
 * shares the connector guard now:
 *  - the URL is checked (scheme, literal address, DNS) before anything is sent;
 *  - the request dials through `guardedLookup`, so the address actually
 *    connected to is the one that was checked. `http.request` never follows
 *    a redirect.
 */
describe('WorkflowEngineService webhook action — egress', () => {
  const instance = {
    id: 'i1',
    workflowId: 'w1',
    tenantId: 't1',
    entityId: 'e1',
    entityType: 'case',
    context: { applicantName: 'synthetic' },
  } as any;

  function build() {
    const args = new Array(15).fill({});
    return new (WorkflowEngineService as any)(...args) as WorkflowEngineService;
  }

  let httpRequest: jest.SpyInstance;
  let httpsRequest: jest.SpyInstance;
  function fakeRequest(_opts: any, cb: (res: any) => void) {
    const req: any = new EventEmitter();
    req.write = jest.fn();
    req.end = () => {
      const res: any = new EventEmitter();
      res.statusCode = 200;
      res.resume = jest.fn();
      cb(res);
    };
    req.destroy = jest.fn();
    return req;
  }
  beforeEach(() => {
    httpRequest = jest.spyOn(http, 'request').mockImplementation(fakeRequest as any);
    httpsRequest = jest.spyOn(https, 'request').mockImplementation(fakeRequest as any);
  });
  afterEach(() => {
    httpRequest.mockRestore();
    httpsRequest.mockRestore();
  });

  const fire = (url: string) =>
    (build() as any).executeWebhookAction({ url }, instance);

  it.each([
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'http://127.0.0.1:9000/hook'],
    ['RFC1918', 'https://192.168.0.10/hook'],
    ['a non-http scheme', 'file:///etc/passwd'],
  ])('refuses %s before any request is opened', async (_l, url) => {
    await expect(fire(url)).rejects.toBeInstanceOf(EgressRefusedError);
    expect(httpRequest).not.toHaveBeenCalled();
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  it('dials a public host through the guarded lookup', async () => {
    // DNS for the pre-check is stubbed; the dial-time lookup is the
    // guardedLookup function itself, asserted by identity.
    const lookup = jest
      .spyOn(require('node:dns').promises, 'lookup')
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    await fire('https://hooks.example.com/meru');

    lookup.mockRestore();
    expect(httpsRequest).toHaveBeenCalledTimes(1);
    expect(httpsRequest.mock.calls[0][0]).toMatchObject({
      hostname: 'hooks.example.com',
      lookup: guardedLookup,
    });
  });
});
