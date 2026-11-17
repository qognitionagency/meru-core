import { assertEgressAllowed, guardedLookup } from './egress-guard';
import * as dnsMod from 'node:dns';

/**
 * Owen's adversarial probes against the egress guard (gate on w1-08,
 * 2026-11-17), ported from his scratch spec. The last block is the five
 * IPv6 ranges that embed or route to IPv4 (or are deprecated private space)
 * and were not refused: IPv4-compatible `::/96`, Teredo `2001::/32`, 6to4
 * `2002::/16`, local-use NAT64 `64:ff9b:1::/48` and site-local `fec0::/10`.
 * Each of those let `169.254.169.254` through in an IPv6 coat.
 */
const dnsAnswers: Record<string, Array<{ address: string; family: number }>> = {
  'mixed.example': [
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.5', family: 4 },
  ],
  'public.example': [{ address: '93.184.216.34', family: 4 }],
  localhost: [{ address: '127.0.0.1', family: 4 }],
  'v6mapped.example': [{ address: '::ffff:169.254.169.254', family: 6 }],
  'sixtofour.example': [{ address: '2002:a9fe:a9fe::1', family: 6 }],
  'compat.example': [{ address: '::a9fe:a9fe', family: 6 }],
  'teredo.example': [{ address: '2001:0:4136:e378:8000:63bf:3fff:fdd2', family: 6 }],
  'nat64local.example': [{ address: '64:ff9b:1::a9fe:a9fe', family: 6 }],
  'sitelocal.example': [{ address: 'fec0::1', family: 6 }],
  'public6.example': [{ address: '2606:4700:4700::1111', family: 6 }],
};

let lookupSpy: jest.SpyInstance;
beforeAll(() => {
  lookupSpy = jest
    .spyOn(dnsMod.promises, 'lookup')
    .mockImplementation(async (h: any) => {
      const a = dnsAnswers[String(h).replace(/\.$/, '')];
      if (!a) {
        const e: any = new Error('ENOTFOUND');
        e.code = 'ENOTFOUND';
        throw e;
      }
      return a as any;
    });
});
afterAll(() => lookupSpy.mockRestore());

const cases: Array<[string, 'refuse' | 'allow']> = [
  ['http://2130706433/', 'refuse'],
  ['http://0x7f.1/', 'refuse'],
  ['http://017700000001/', 'refuse'],
  ['http://127.1/', 'refuse'],
  ['http://0/', 'refuse'],
  ['http://0.0.0.0/', 'refuse'],
  ['http://169.254.169.254./', 'refuse'],
  ['http://user:pw@127.0.0.1/', 'refuse'],
  ['http://evil.example\\@127.0.0.1/', 'refuse'],
  ['http://127.0.0.1#@public.example/', 'refuse'],
  ['http://[::ffff:127.0.0.1]/', 'refuse'],
  ['http://[0:0:0:0:0:ffff:a9fe:a9fe]/', 'refuse'],
  ['http://[::]/', 'refuse'],
  ['http://[::1]/', 'refuse'],
  ['http://[fe80::1%25eth0]/', 'refuse'],
  ['http://[fd00::1]/', 'refuse'],
  ['http://[64:ff9b::a9fe:a9fe]/', 'refuse'],
  ['HTTP://127.0.0.1/', 'refuse'],
  ['file:///etc/passwd', 'refuse'],
  ['gopher://public.example/', 'refuse'],
  ['http://mixed.example/', 'refuse'],
  ['http://localhost/', 'refuse'],
  ['http://localhost./', 'refuse'],
  ['http://nxdomain.example/', 'refuse'],
  ['http://v6mapped.example/', 'refuse'],
  ['http://12\t7.0.0.1/', 'refuse'],
  ['https://public.example/v1', 'allow'],
  ['https://public6.example/v1', 'allow'],
  ['https://[2606:4700:4700::1111]/', 'allow'],
  // The five ranges added after Owen's probes.
  ['http://[::a9fe:a9fe]/', 'refuse'], // IPv4-compatible ::/96
  ['http://[::7f00:1]/', 'refuse'], // IPv4-compatible loopback
  ['http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', 'refuse'], // Teredo
  ['http://[2002:a9fe:a9fe::1]/', 'refuse'], // 6to4 embedding 169.254.169.254
  ['http://[2002:7f00:1::]/', 'refuse'], // 6to4 embedding 127.0.0.1
  ['http://[64:ff9b:1::a9fe:a9fe]/', 'refuse'], // local-use NAT64 (RFC 8215)
  ['http://[fec0::1]/', 'refuse'], // deprecated site-local
  ['http://[feff::1]/', 'refuse'], // top of fec0::/10
  ['http://compat.example/', 'refuse'],
  ['http://teredo.example/', 'refuse'],
  ['http://sixtofour.example/', 'refuse'],
  ['http://nat64local.example/', 'refuse'],
  ['http://sitelocal.example/', 'refuse'],
];

describe('egress guard — adversarial URLs', () => {
  it.each(cases)('%j → %s', async (url, want) => {
    let outcome: 'refuse' | 'allow';
    try {
      await assertEgressAllowed(url);
      outcome = 'allow';
    } catch {
      outcome = 'refuse';
    }
    expect(outcome).toBe(want);
  });

  it('guardedLookup refuses localhost through the real resolver, with and without all:true', (done) => {
    guardedLookup('localhost', {}, (err1) => {
      guardedLookup('localhost', { all: true }, (err2) => {
        expect(err1).toBeTruthy();
        expect(err2).toBeTruthy();
        done();
      });
    });
  });
});
