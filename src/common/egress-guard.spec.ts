import { promises as dns } from 'node:dns';
import {
  assertEgressAllowed,
  EgressRefusedError,
  egressGuardedFetch,
} from './egress-guard';

/**
 * Outbound HTTP to a URL a tenant chose (Anton, 2026-11-17, #4 and #14).
 * A firm_admin could point the AI connector's `baseUrl` at cloud metadata
 * (169.254.169.254), at loopback, or at anything on the host's private
 * network, and every AI call then POSTed there with the tenant's key, the
 * upstream body coming back through the error filter.
 *
 * DNS is stubbed in every case: no test here touches the network.
 */
describe('egress guard', () => {
  let lookup: jest.SpyInstance;
  const resolvesTo = (...addresses: string[]) =>
    lookup.mockResolvedValue(
      addresses.map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      })),
    );

  beforeEach(() => {
    lookup = jest.spyOn(dns, 'lookup');
    resolvesTo('93.184.216.34');
  });
  afterEach(() => lookup.mockRestore());

  it.each([
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'http://127.0.0.1:8000/v1'],
    ['loopback, decimal form', 'http://2130706433/v1'],
    ['unspecified', 'http://0.0.0.0/'],
    ['RFC1918 10/8', 'https://10.1.2.3/v1'],
    ['RFC1918 172.16/12', 'https://172.20.0.1/v1'],
    ['RFC1918 192.168/16', 'https://192.168.1.10/v1'],
    ['CGNAT 100.64/10', 'https://100.100.100.200/'],
    ['IPv6 loopback', 'http://[::1]/v1'],
    ['IPv6 unique-local', 'http://[fd00::1]/v1'],
    ['IPv6 link-local', 'http://[fe80::1]/v1'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/v1'],
  ])('refuses a literal %s address', async (_label, url) => {
    await expect(assertEgressAllowed(url)).rejects.toBeInstanceOf(
      EgressRefusedError,
    );
  });

  it.each([
    ['file', 'file:///etc/passwd'],
    ['gopher', 'gopher://example.com/'],
    ['ftp', 'ftp://example.com/'],
    ['data', 'data:text/plain,hi'],
  ])('refuses the %s scheme', async (_label, url) => {
    await expect(assertEgressAllowed(url)).rejects.toBeInstanceOf(
      EgressRefusedError,
    );
  });

  it('refuses a string that is not a URL', async () => {
    await expect(assertEgressAllowed('not a url')).rejects.toBeInstanceOf(
      EgressRefusedError,
    );
  });

  it('refuses a hostname whose DNS answer includes a private address, even alongside a public one', async () => {
    resolvesTo('93.184.216.34', '10.0.0.7');
    await expect(
      assertEgressAllowed('https://looks-public.example/v1'),
    ).rejects.toBeInstanceOf(EgressRefusedError);
  });

  it('refuses a hostname that resolves to cloud metadata', async () => {
    resolvesTo('169.254.169.254');
    await expect(
      assertEgressAllowed('http://metadata.example/'),
    ).rejects.toBeInstanceOf(EgressRefusedError);
  });

  it('refuses when DNS fails — unknown is not allowed', async () => {
    lookup.mockRejectedValue(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }));
    await expect(
      assertEgressAllowed('https://nowhere.example/v1'),
    ).rejects.toBeInstanceOf(EgressRefusedError);
  });

  it('allows a public https host', async () => {
    await expect(
      assertEgressAllowed('https://api.openai.com/v1'),
    ).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledWith('api.openai.com', { all: true, verbatim: true });
  });

  describe('egressGuardedFetch', () => {
    const realFetch = global.fetch;
    let fetchMock: jest.Mock;
    beforeEach(() => {
      fetchMock = jest.fn(async () => new Response('ok'));
      (global as any).fetch = fetchMock;
    });
    afterEach(() => {
      (global as any).fetch = realFetch;
    });

    it('re-resolves on every request and refuses a host that now points inward', async () => {
      resolvesTo('169.254.169.254');
      await expect(
        egressGuardedFetch('https://rebinding.example/v1/chat/completions', {
          method: 'POST',
        }),
      ).rejects.toBeInstanceOf(EgressRefusedError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never follows a redirect — a public host cannot bounce the request inward', async () => {
      await egressGuardedFetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        redirect: 'follow',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    });

    it('accepts a Request object as the target', async () => {
      await egressGuardedFetch(new Request('https://api.openai.com/v1/models'));
      expect(lookup).toHaveBeenCalledWith('api.openai.com', expect.anything());
    });
  });
});

/**
 * `guardedLookup` is a `dns.lookup`-shaped function for `http.request`'s
 * `lookup` option: it checks the address Node is about to dial, so there is
 * no window between check and connect. Used by the workflow webhook action.
 */
describe('guardedLookup', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dnsCb = require('node:dns');
  let lookup: jest.SpyInstance;
  afterEach(() => lookup?.mockRestore());

  const stub = (...addresses: string[]) => {
    lookup = jest
      .spyOn(dnsCb, 'lookup')
      .mockImplementation((_h: any, _o: any, cb: any) =>
        cb(
          null,
          addresses.map((address) => ({
            address,
            family: address.includes(':') ? 6 : 4,
          })),
        ),
      );
  };

  const call = (options: Record<string, unknown>) =>
    new Promise<{ err: Error | null; address: unknown; family: unknown }>(
      (resolve) =>
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('./egress-guard').guardedLookup(
          'hook.example',
          options,
          (err: Error | null, address: unknown, family: unknown) =>
            resolve({ err, address, family }),
        ),
    );

  it('refuses when the dialled address is private', async () => {
    stub('10.0.0.9');
    const { err } = await call({});
    expect(err).toBeInstanceOf(EgressRefusedError);
  });

  it('refuses when any answer is private, even if the first is public', async () => {
    stub('93.184.216.34', '169.254.169.254');
    const { err } = await call({ all: true });
    expect(err).toBeInstanceOf(EgressRefusedError);
  });

  it('answers in single-address form when all is not requested', async () => {
    stub('93.184.216.34');
    const { err, address, family } = await call({});
    expect(err).toBeNull();
    expect(address).toBe('93.184.216.34');
    expect(family).toBe(4);
  });

  it('answers in array form when all is requested', async () => {
    stub('93.184.216.34');
    const { err, address } = await call({ all: true });
    expect(err).toBeNull();
    expect(address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});
