import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AiService } from './ai.service';
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
import { egressGuardedFetch } from '../common/egress-guard';

/**
 * A tenant connector's `baseUrl` is checked when it is saved
 * (`connector-egress.spec.ts`), but DNS can change after that. So the client
 * built for a tenant connector sends every request through
 * `egressGuardedFetch`, which re-resolves and re-checks the host and never
 * follows a redirect (Anton, 2026-11-17, #4). Same harness as
 * `ai-client-residency.spec.ts`: the `openai` SDK is mocked at the module
 * boundary and `constructorCalls` records every `new OpenAI(...)`.
 */
const embeddingsCreate = jest.fn();
const chatCreate = jest.fn();
const constructorCalls: Array<{ apiKey?: string; baseURL?: string; fetch?: unknown }> = [];

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

describe('AiService.clientFor — tenant connector egress', () => {
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

  it('builds a tenant-connector client whose every request goes through the egress guard', async () => {
    resolveAiProvider.mockResolvedValue({
      apiKey: 'tenant-key',
      baseUrl: 'https://llm.tenant-a.example/v1',
      model: 'm',
    });

    await bound('tenant-a', () => service.clientFor('tenant-a'));

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0].fetch).toBe(egressGuardedFetch);
  });

  it('applies the guard to a catalogue provider too, not only custom endpoints', async () => {
    resolveAiProvider.mockResolvedValue({
      apiKey: 'tenant-key',
      baseUrl: 'https://api.openai.com/v1',
      model: null,
    });

    await bound('tenant-a', () => service.clientFor('tenant-a'));

    expect(constructorCalls[0].fetch).toBe(egressGuardedFetch);
  });
});
