import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  AiService,
  AiTenantContextUnboundError,
  AiTenantIdRequiredError,
} from './ai.service';
import { TenantContext } from '../core/tenancy/tenant-context';
import { AiPrompt, AiEmbedding } from './entities/ai-prompt.entity';
import { CrmService } from '../crm/crm.service';
import { WorkflowEngineService } from '../workflow/workflow.service';
import { TaskService } from '../tasks/task.service';
import { FormBuilderService } from '../forms/form-builder.service';
import { DocumentsService } from '../documents/documents.service';
import { BillingService } from '../billing/billing.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../audit/audit.service';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';
import { ConnectorsService } from '../integrations/services/connectors.service';

/**
 * `createEmbedding` and `semanticSearch` used to call `this.openaiClient`
 * directly — the platform singleton built once at boot from a bare
 * `OPENAI_API_KEY` — regardless of whether the calling tenant had connected
 * its own provider. A tenant that pinned a self-hosted endpoint specifically
 * so case text never left for a US OpenAI account was still sending it there
 * on every embed and every semantic-search query. Both now resolve their
 * client through `AiService.clientFor`, same as `executeOpenAI` already did.
 *
 * The `openai` SDK is mocked at the module boundary so this proves ROUTING —
 * which client got the call, with which `baseURL` — without a real network
 * call. `constructorCalls` is the record of every `new OpenAI(...)`; the
 * fail-closed tests assert its length rather than trusting the mock's return
 * value, because a silent second construction is exactly what a platform
 * fallback would look like.
 */
const embeddingsCreate = jest.fn();
const chatCreate = jest.fn();
const constructorCalls: Array<{ apiKey?: string; baseURL?: string }> = [];

jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation((config: any) => {
    constructorCalls.push(config);
    return {
      embeddings: { create: embeddingsCreate },
      chat: { completions: { create: chatCreate } },
    };
  }),
}));

/**
 * Every real caller of `clientFor` (`AiController`, `EnginesController`'s
 * doc-intel route, and the services above them) runs inside a normally
 * tenant-bound HTTP request — `TenantAlsMiddleware` + `TenantBindingInterceptor`
 * have already set `app.current_tenant_id` to the caller's own tenant by the
 * time a service method runs. This mirrors that binding for a test calling
 * `AiService` directly, the same way production request handling would.
 */
function bound<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return TenantContext.run({ tenantId }, fn);
}

describe('AiService — data residency (clientFor routing)', () => {
  const embeddingCreate = jest.fn();
  const embeddingFind = jest.fn();
  const resolveAiProvider = jest.fn();
  let service: AiService;

  beforeEach(async () => {
    embeddingsCreate.mockReset();
    chatCreate.mockReset();
    constructorCalls.length = 0;
    embeddingCreate.mockReset();
    embeddingFind.mockReset();
    resolveAiProvider.mockReset();
    // A platform key IS set for this whole file — every fail-closed test's
    // point is that a tenant connector, once resolved, is used INSTEAD of
    // this, not that this is unavailable.
    process.env.OPENAI_API_KEY = 'sk-platform-test-key';

    embeddingCreate.mockImplementation(
      (row: Record<string, unknown>) => ({ id: 'emb-1', ...row }) as any,
    );

    const stub = {};
    const moduleRef = await Test.createTestingModule({
      providers: [
        AiService,
        {
          provide: getRepositoryToken(AiPrompt),
          useValue: { findOne: jest.fn(), find: jest.fn(), save: jest.fn() },
        },
        {
          provide: getRepositoryToken(AiEmbedding),
          useValue: {
            create: embeddingCreate,
            save: jest.fn(async (row: unknown) => row),
            find: embeddingFind,
          },
        },
        { provide: CrmService, useValue: stub },
        { provide: WorkflowEngineService, useValue: stub },
        { provide: TaskService, useValue: stub },
        { provide: FormBuilderService, useValue: stub },
        { provide: DocumentsService, useValue: stub },
        { provide: BillingService, useValue: stub },
        { provide: AnalyticsService, useValue: stub },
        { provide: AuditService, useValue: stub },
        { provide: VerticalPackService, useValue: {} },
        { provide: ConnectorsService, useValue: { resolveAiProvider } },
      ],
    }).compile();

    service = moduleRef.get(AiService);
    // AiService's own constructor builds the platform `OpenAI` client at boot
    // (from `OPENAI_API_KEY`, unconditionally when it is set) — clear that
    // baseline call so each test's assertions are about what ITS call to
    // `clientFor` constructed, not about service bootstrap.
    constructorCalls.length = 0;
  });

  afterAll(() => {
    delete process.env.OPENAI_API_KEY;
  });

  describe('clientFor', () => {
    it('resolves the platform key when the tenant has no connector', async () => {
      resolveAiProvider.mockResolvedValue(null);

      const { source } = await bound('tenant-a', () => service.clientFor('tenant-a'));

      expect(source).toBe('platform');
      // No NEW client is built for this path — it reuses the singleton
      // AiService already constructed from OPENAI_API_KEY at boot.
      expect(constructorCalls).toHaveLength(0);
    });

    it('resolves the tenant connector, with its own baseUrl, when one exists', async () => {
      resolveAiProvider.mockResolvedValue({
        apiKey: 'tenant-key',
        baseUrl: 'https://self-hosted.tenant-a.internal/v1',
        model: 'llama-70b',
      });

      const { source } = await bound('tenant-a', () => service.clientFor('tenant-a'));

      expect(source).toBe('tenant_connector');
      expect(constructorCalls).toContainEqual(
        expect.objectContaining({
          baseURL: 'https://self-hosted.tenant-a.internal/v1',
        }),
      );
    });

    it('503s naming both remedies when neither a connector nor a platform key exists', async () => {
      delete process.env.OPENAI_API_KEY;
      resolveAiProvider.mockResolvedValue(null);
      // AiService reads OPENAI_API_KEY at construction; rebuild it here with
      // the key already gone so its internal `openaiClient` is really null.
      const moduleRef = await Test.createTestingModule({
        providers: [
          AiService,
          { provide: getRepositoryToken(AiPrompt), useValue: {} },
          { provide: getRepositoryToken(AiEmbedding), useValue: {} },
          { provide: CrmService, useValue: {} },
          { provide: WorkflowEngineService, useValue: {} },
          { provide: TaskService, useValue: {} },
          { provide: FormBuilderService, useValue: {} },
          { provide: DocumentsService, useValue: {} },
          { provide: BillingService, useValue: {} },
          { provide: AnalyticsService, useValue: {} },
          { provide: AuditService, useValue: {} },
          { provide: VerticalPackService, useValue: {} },
          { provide: ConnectorsService, useValue: { resolveAiProvider } },
        ],
      }).compile();
      const unconfigured = moduleRef.get(AiService);

      await expect(
        bound('tenant-a', () => unconfigured.clientFor('tenant-a')),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        bound('tenant-a', () => unconfigured.clientFor('tenant-a')),
      ).rejects.toThrow(/no AI provider connected.*no OPENAI_API_KEY set/s);
    });

    it('FAIL CLOSED: refuses rather than falls to the platform key when the connection is unbound', async () => {
      resolveAiProvider.mockResolvedValue(null);

      // No TenantContext.run at all — the state a bug in the middleware, a
      // background job missing its per-tenant wrapper, or a stray call from
      // outside a request would leave the connection in.
      await expect(service.clientFor('tenant-a')).rejects.toBeInstanceOf(
        AiTenantContextUnboundError,
      );
      // The platform key IS configured in this test — if there were any path
      // from "unbound" to "fall back to platform", this is exactly where it
      // would fire.
      expect(constructorCalls).toHaveLength(0);
      expect(resolveAiProvider).not.toHaveBeenCalled();
    });

    it('FAIL CLOSED: refuses when the connection is bound to a DIFFERENT tenant', async () => {
      resolveAiProvider.mockResolvedValue(null);

      await expect(
        bound('tenant-OTHER', () => service.clientFor('tenant-a')),
      ).rejects.toBeInstanceOf(AiTenantContextUnboundError);
      expect(constructorCalls).toHaveLength(0);
      expect(resolveAiProvider).not.toHaveBeenCalled();
    });

    it('FAIL CLOSED: refuses under a runAsSystem/runAsGod bypass, even bound to the right tenant', async () => {
      resolveAiProvider.mockResolvedValue(null);

      await expect(
        TenantContext.run(
          { tenantId: 'tenant-a', bypass: { kind: 'system', reason: 'test' } },
          () => service.clientFor('tenant-a'),
        ),
      ).rejects.toBeInstanceOf(AiTenantContextUnboundError);
      expect(constructorCalls).toHaveLength(0);
      expect(resolveAiProvider).not.toHaveBeenCalled();
    });

    it('FAIL CLOSED: refuses with a distinct error when called with no tenantId at all', async () => {
      // Every real caller has a tenant — audited across `execute()`,
      // `createEmbedding()`, `semanticSearch()` and `DocIntelEngine`. A bare
      // `clientFor(undefined)` used to mean "skip the tenant lookup and go
      // straight to the platform key", which is exactly how the top-level-
      // vs-`context`-only defect reached the platform key silently at eight
      // call sites. It must now throw a DIFFERENT error than an unbound
      // context — this is "no tenant was even named", not "a tenant was
      // named but the connection can't be trusted to have looked at it".
      await expect(service.clientFor(undefined)).rejects.toBeInstanceOf(
        AiTenantIdRequiredError,
      );
      await expect(service.clientFor(undefined)).rejects.not.toBeInstanceOf(
        AiTenantContextUnboundError,
      );
      expect(constructorCalls).toHaveLength(0);
      expect(resolveAiProvider).not.toHaveBeenCalled();
    });
  });

  describe('createEmbedding', () => {
    it('embeds through the tenant connector, not the platform key, when one is connected', async () => {
      resolveAiProvider.mockResolvedValue({
        apiKey: 'tenant-key',
        baseUrl: 'https://self-hosted.tenant-a.internal/v1',
        model: null,
      });
      embeddingsCreate.mockResolvedValue({
        data: [{ embedding: [0.1, 0.2], index: 0 }],
      });

      const result = await bound('tenant-a', () =>
        service.createEmbedding('tenant-a', 'case notes', 'entity', 'e-1'),
      );

      // Exactly one client was ever constructed for this call, and it is the
      // tenant's own endpoint — never a second, platform-backed client.
      expect(constructorCalls).toHaveLength(1);
      expect(constructorCalls[0]).toEqual(
        expect.objectContaining({
          baseURL: 'https://self-hosted.tenant-a.internal/v1',
        }),
      );
      expect(result.provenance).toEqual({ source: 'tenant_connector' });
    });

    it('FAIL CLOSED: a tenant connector whose embed call fails is never retried on the platform key', async () => {
      resolveAiProvider.mockResolvedValue({
        apiKey: 'tenant-key',
        baseUrl: 'https://self-hosted.tenant-a.internal/v1',
        model: null,
      });
      embeddingsCreate.mockRejectedValue(
        new Error('404 no /embeddings route on this endpoint'),
      );

      await expect(
        bound('tenant-a', () =>
          service.createEmbedding('tenant-a', 'case notes', 'entity', 'e-1'),
        ),
      ).rejects.toThrow(/no \/embeddings route/);

      // The platform key IS set in this test (see beforeEach) — if a
      // fallback existed, this is exactly where it would fire. It must not:
      // one client constructed, one embeddings call, both against the
      // tenant's own endpoint.
      expect(constructorCalls).toHaveLength(1);
      expect(embeddingsCreate).toHaveBeenCalledTimes(1);
    });

    it('uses the platform key when the tenant has no connector at all', async () => {
      resolveAiProvider.mockResolvedValue(null);
      embeddingsCreate.mockResolvedValue({
        data: [{ embedding: [0.1, 0.2], index: 0 }],
      });

      const result = await bound('tenant-b', () =>
        service.createEmbedding('tenant-b', 'case notes', 'entity', 'e-1'),
      );

      expect(result.provenance).toEqual({ source: 'platform' });
      // No new client construction — reuses the boot-time platform singleton.
      expect(constructorCalls).toHaveLength(0);
    });
  });

  describe('semanticSearch', () => {
    it('embeds the query through the tenant connector when one is connected', async () => {
      resolveAiProvider.mockResolvedValue({
        apiKey: 'tenant-key',
        baseUrl: 'https://self-hosted.tenant-a.internal/v1',
        model: null,
      });
      embeddingsCreate.mockResolvedValue({
        data: [{ embedding: [1, 0] }],
      });
      embeddingFind.mockResolvedValue([]);

      await bound('tenant-a', () =>
        service.semanticSearch('tenant-a', 'passport expiry'),
      );

      expect(constructorCalls).toEqual([
        expect.objectContaining({
          baseURL: 'https://self-hosted.tenant-a.internal/v1',
        }),
      ]);
    });

    it('FAIL CLOSED: a tenant connector query-embed failure is never retried on the platform key', async () => {
      resolveAiProvider.mockResolvedValue({
        apiKey: 'tenant-key',
        baseUrl: 'https://self-hosted.tenant-a.internal/v1',
        model: null,
      });
      embeddingsCreate.mockRejectedValue(new Error('connector endpoint down'));

      await expect(
        bound('tenant-a', () =>
          service.semanticSearch('tenant-a', 'passport expiry'),
        ),
      ).rejects.toThrow(/connector endpoint down/);

      expect(constructorCalls).toHaveLength(1);
    });
  });

  describe('executeOpenAI (via execute) — provenance on the AiResponse', () => {
    it('reports provenance.source so a caller can prove which credential answered', async () => {
      const promptRepo = service['promptRepo'] as unknown as {
        findOne: jest.Mock;
      };
      promptRepo.findOne = jest.fn().mockResolvedValue({
        key: 'k',
        prompt: 'Summarise: {{INPUT}}',
        preferredProvider: 'openai',
        modelConfig: {},
      });
      resolveAiProvider.mockResolvedValue({
        apiKey: 'tenant-key',
        baseUrl: 'https://self-hosted.tenant-a.internal/v1',
        model: 'llama-70b',
      });
      chatCreate.mockResolvedValue({
        choices: [{ message: { content: 'summary text' } }],
        usage: { total_tokens: 12 },
      });

      const response = await bound('tenant-a', () =>
        service.execute({
          category: 'entity_analysis' as any,
          input: 'hello',
          tenantId: 'tenant-a',
        }),
      );

      expect(response.provenance).toEqual({ source: 'tenant_connector' });
    });
  });
});
