import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { promises as dns } from 'node:dns';
import { ConnectorsService } from './connectors.service';
import { ConnectorsController } from '../connectors.controller';
import type { Actor } from '../../common/access';

/**
 * Anton, 2026-11-17, #4: a firm_admin could set an AI connector's `baseUrl`
 * to any URL — cloud metadata, loopback, the host's private network — and
 * every AI call then POSTed there with the tenant's key.
 *
 * Until a provider allow-list exists:
 *  - only `platform_admin` may set or change a `baseUrl` (firm_admins can
 *    still connect the named providers, which use the catalogue's URL);
 *  - every `baseUrl`, whoever sets it, must pass the egress guard
 *    (`src/common/egress-guard.ts`), resolved at write time here and again
 *    before every request in `AiService.clientFor`.
 */
describe('ConnectorsService.upsert — baseUrl egress', () => {
  const firmAdmin: Actor = { id: 'fa-1', roles: ['firm_admin'] };
  const operator: Actor = { id: 'op-1', roles: ['platform_admin'] };

  let lookup: jest.SpyInstance;
  beforeAll(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = 'a'.repeat(64);
  });
  beforeEach(() => {
    lookup = jest
      .spyOn(dns, 'lookup')
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
  });
  afterEach(() => lookup.mockRestore());

  function build() {
    const save = jest.fn(async (x: unknown) => x);
    const repo = {
      findOne: jest.fn(async () => null),
      create: jest.fn((x: Record<string, unknown>) => ({
        enabled: false,
        mode: 'sandbox',
        credentials: null,
        ...x,
      })),
      save,
    };
    const service = new ConnectorsService(repo as any, {
      listAdapters: () => [],
    } as any);
    return { service, save };
  }

  it('refuses a firm_admin setting a custom endpoint — 403, nothing saved', async () => {
    const { service, save } = build();

    await expect(
      service.upsert(
        't1',
        'immigration',
        'custom-openai-compatible',
        {
          enabled: true,
          credentials: { baseUrl: 'https://llm.example.com/v1', model: 'm' },
        },
        firmAdmin,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a firm_admin overriding a named provider’s baseUrl', async () => {
    const { service, save } = build();

    await expect(
      service.upsert(
        't1',
        'immigration',
        'openai',
        {
          enabled: true,
          credentials: { apiKey: 'sk-x', baseUrl: 'http://169.254.169.254/' },
        },
        firmAdmin,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(save).not.toHaveBeenCalled();
  });

  it('treats a missing actor as not platform_admin — fails closed', async () => {
    const { service } = build();

    await expect(
      service.upsert('t1', 'immigration', 'custom-openai-compatible', {
        enabled: true,
        credentials: { baseUrl: 'https://llm.example.com/v1', model: 'm' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('still lets a firm_admin connect a named provider with just a key', async () => {
    const { service, save } = build();

    await expect(
      service.upsert(
        't1',
        'immigration',
        'openai',
        { enabled: true, credentials: { apiKey: 'sk-x' } },
        firmAdmin,
      ),
    ).resolves.toMatchObject({ hasCredentials: true });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['cloud metadata', 'http://169.254.169.254/latest/'],
    ['loopback', 'http://127.0.0.1:11434/v1'],
    ['RFC1918', 'http://10.0.0.5:8000/v1'],
    ['a non-http scheme', 'file:///etc/passwd'],
  ])('refuses even a platform_admin pointing it at %s — 400, nothing saved', async (_l, baseUrl) => {
    const { service, save } = build();

    await expect(
      service.upsert(
        't1',
        'immigration',
        'custom-openai-compatible',
        { enabled: true, credentials: { baseUrl, model: 'm' } },
        operator,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a hostname that resolves to a private address', async () => {
    lookup.mockResolvedValue([{ address: '10.0.0.7', family: 4 }] as any);
    const { service, save } = build();

    await expect(
      service.upsert(
        't1',
        'immigration',
        'custom-openai-compatible',
        {
          enabled: true,
          credentials: { baseUrl: 'https://vllm.internal/v1', model: 'm' },
        },
        operator,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });

  it('accepts a platform_admin setting a public https endpoint', async () => {
    const { service, save } = build();

    await expect(
      service.upsert(
        't1',
        'immigration',
        'custom-openai-compatible',
        {
          enabled: true,
          credentials: { baseUrl: 'https://llm.example.com/v1', model: 'm' },
        },
        operator,
      ),
    ).resolves.toMatchObject({ hasCredentials: true });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('the controller passes the caller to the service', async () => {
    const upsert = jest.fn(async () => ({}));
    const controller = new ConnectorsController({ upsert } as any);
    const user = { id: 'fa-1', tenantId: 't1', roles: ['firm_admin'] };

    await controller.upsert(
      { user, tenantVertical: 'immigration' } as any,
      'openai',
      { credentials: { apiKey: 'k' } } as any,
    );

    expect(upsert).toHaveBeenCalledWith(
      't1',
      'immigration',
      'openai',
      { credentials: { apiKey: 'k' } },
      expect.objectContaining({ id: 'fa-1', roles: ['firm_admin'] }),
    );
  });
});
