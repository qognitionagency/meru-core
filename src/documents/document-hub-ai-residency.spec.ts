import { DocumentHubService } from './document-hub.service';
import { DocumentType, DocumentStatus } from './entities/document.entity';

/**
 * `AiService.execute` reads `request.tenantId` — the TOP-LEVEL field — for
 * `clientFor` routing (residency), not `request.context.tenantId`, which
 * only ever reaches prompt templating. All three `aiService.execute` calls
 * in `DocumentHubService` set `context: { tenantId: document.tenantId }`
 * only, so every document AI call always used the platform key regardless of
 * whether the tenant had connected its own provider — fixed to also set the
 * top-level field, verified here rather than trusted by inspection.
 */
describe('DocumentHubService — AI residency (tenantId passed top-level)', () => {
  const T = 'tenant-1';

  function build() {
    const document = {
      id: 'doc-1',
      tenantId: T,
      name: 'Passport scan',
      fileType: DocumentType.PASSPORT,
      status: DocumentStatus.APPROVED,
      metadata: {},
      currentVersionId: null,
    };

    const documentRepo = {
      findOne: jest.fn(async () => document),
    };
    const metadataRepo = {
      create: jest.fn((x: any) => x),
      save: jest.fn(async (x: any) => x),
    };
    const execute = jest
      .fn()
      .mockResolvedValue({ result: JSON.stringify({ ok: true }) });
    const aiService = { execute };
    const searchService = { indexEntityData: jest.fn() };
    const access = {};

    const service = new DocumentHubService(
      documentRepo as any,
      {} as any,
      metadataRepo as any,
      searchService as any,
      aiService as any,
      access as any,
    );

    return { service, execute, document };
  }

  it('analyzeDocument passes tenantId to execute() top-level', async () => {
    const { service, execute, document } = build();

    await service.analyzeDocument(document.id);

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: T }),
    );
  });

  it('extractDocumentData passes tenantId to execute() top-level', async () => {
    const { service, execute, document } = build();

    await service.extractDocumentData(document.id, { field: 'string' });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: T }),
    );
  });

  it('indexDocumentForSearch passes tenantId to execute() top-level', async () => {
    const { service, execute, document } = build();

    await service.indexDocumentForSearch(document as any);

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: T }),
    );
  });
});
