import * as dnsModule from 'node:dns';
import { promises as dns } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';

/**
 * Outbound HTTP to a URL that a tenant, a pack or a request chose.
 *
 * The AI connector's `baseUrl` was checked only for presence (Anton,
 * 2026-11-17, #4), so a firm_admin could point every AI call, carrying the
 * tenant's key, at cloud metadata, loopback or the host's private network.
 * The workflow webhook action (#14) has the same shape. Both go through this.
 *
 * What it refuses: any scheme but http/https; any literal or resolved address
 * in loopback, unspecified, link-local (169.254/16, which holds cloud
 * metadata), RFC1918, CGNAT, benchmark, multicast or reserved space; the IPv6
 * equivalents; every IPv4-mapped and NAT64 IPv6 address; and a hostname whose
 * DNS lookup fails. If ANY resolved address is refused, the URL is refused.
 *
 * The connection is pinned to the address checked: `egressGuardedFetch` and
 * the workflow webhook both dial through `http(s).request` with
 * `guardedLookup`, which checks the addresses Node is about to connect to.
 * The global `fetch` resolved the name again on its own after the check, so
 * a DNS server answering public first and private second could swap the
 * address in between (Owen's gate, w1-08); that window is closed. Neither
 * follows a redirect.
 */

export class EgressRefusedError extends Error {
  constructor(reason: string) {
    super(`Outbound request refused: ${reason}`);
    this.name = 'EgressRefusedError';
  }
}

// Two lists, each checked only for its own family. Node's BlockList treats
// an IPv4 address as matching an `::ffff:0:0/96` rule, so one shared list
// with the mapped range in it refuses every IPv4 address.
const REFUSED_V4 = new BlockList();
const REFUSED_V6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network", incl. 0.0.0.0
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast
] as const) {
  REFUSED_V4.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::ffff:0:0', 96], // IPv4-mapped: refused wholesale, never needed here
  ['64:ff9b::', 96], // NAT64: likewise
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  // Owen's gate (w1-08): ranges that embed or route to IPv4, or are
  // deprecated private space. Each let 169.254.169.254 through as IPv6.
  ['::', 96], // IPv4-compatible (deprecated)
  ['2001::', 32], // Teredo
  ['2002::', 16], // 6to4
  ['64:ff9b:1::', 48], // local-use NAT64 (RFC 8215)
  ['fec0::', 10], // site-local (deprecated)
] as const) {
  REFUSED_V6.addSubnet(net, prefix, 'ipv6');
}

function isRefusedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return REFUSED_V4.check(address, 'ipv4');
  if (family === 6) return REFUSED_V6.check(address, 'ipv6');
  return true; // not an address at all: refuse
}

/**
 * Resolve and check a URL. Resolves to `undefined` when the request may go
 * ahead; rejects with `EgressRefusedError` otherwise. Never throws anything
 * else, so a caller can map one error type to one response.
 */
export async function assertEgressAllowed(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressRefusedError('not a valid URL');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new EgressRefusedError(`scheme ${url.protocol} is not allowed`);
  }

  // WHATWG URL has already normalised decimal/hex/octal IPv4 forms;
  // IPv6 literals keep their brackets in `hostname`.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new EgressRefusedError('no host');

  if (isIP(host)) {
    if (isRefusedAddress(host)) {
      throw new EgressRefusedError('address is not publicly routable');
    }
    return;
  }

  let answers: Array<{ address: string }>;
  try {
    answers = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new EgressRefusedError('host did not resolve');
  }
  if (answers.length === 0) {
    throw new EgressRefusedError('host did not resolve');
  }
  if (answers.some((a) => isRefusedAddress(a.address))) {
    throw new EgressRefusedError('host resolves to a non-public address');
  }
}

/**
 * A `fetch` that checks the target, dials only the address it checked, and
 * never follows a redirect. Shaped to drop into the OpenAI SDK's `fetch`
 * option. Built on `http(s).request` with `lookup: guardedLookup` rather than
 * the global `fetch`, whose own lookup after the check left a DNS-rebinding
 * window; no new dependency.
 *
 * A 3xx is refused (`EgressRefusedError`) rather than returned, matching the
 * `redirect: 'error'` this replaced; the caller's `redirect` is ignored.
 */
export async function egressGuardedFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  // Normalises every header and body shape the SDK may pass (string, bytes,
  // URLSearchParams, FormData with its boundary) into one Request.
  const request = new Request(input, { ...init, redirect: 'manual' });
  await assertEgressAllowed(request.url);

  const url = new URL(request.url);
  const body = request.body
    ? Buffer.from(await request.arrayBuffer())
    : undefined;
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  if (body && !headers['content-length']) {
    headers['content-length'] = String(body.length);
  }

  const lib = url.protocol === 'https:' ? https : http;
  return new Promise<Response>((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        // IP literals keep their brackets in `hostname`; `request` wants none.
        // Node skips `lookup` for a literal, which `assertEgressAllowed`
        // above has already checked.
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: request.method,
        headers,
        lookup: guardedLookup,
        signal: init?.signal ?? undefined,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          reject(new EgressRefusedError(`redirect (HTTP ${status}) not followed`));
          return;
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) {
            responseHeaders.append(name, v);
          }
        }
        const noBody = status === 204 || status === 205 || status === 304;
        if (noBody) res.resume();
        resolve(
          new Response(
            noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>),
            { status, statusText: res.statusMessage, headers: responseHeaders },
          ),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * A `dns.lookup`-shaped function for `http.request` / `https.request`'s
 * `lookup` option. It checks the addresses Node is about to dial, so there
 * is no window between the check and the connect.
 * Node skips `lookup` for an IP-literal host, so callers must also run
 * `assertEgressAllowed` on the URL first.
 */
export function guardedLookup(
  hostname: string,
  options: dnsModule.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dnsModule.LookupAddress[],
    family?: number,
  ) => void,
): void {
  dnsModule.lookup(
    hostname,
    { ...options, all: true },
    (err, addresses: dnsModule.LookupAddress[]) => {
      if (err) return callback(err, []);
      if (!addresses?.length) {
        return callback(new EgressRefusedError('host did not resolve'), []);
      }
      if (addresses.some((a) => isRefusedAddress(a.address))) {
        return callback(
          new EgressRefusedError('host resolves to a non-public address'),
          [],
        );
      }
      if (options?.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    },
  );
}
