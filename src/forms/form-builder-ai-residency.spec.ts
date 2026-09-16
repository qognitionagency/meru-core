import { FormBuilderService } from './form-builder.service';
import { FormLayout, FormStatus } from './entities/form-schema.entity';

/**
 * `AiService.extractFromDocument` / `.validateFormData` took no `tenantId`
 * parameter at all before this pass — not even inside `context` — so every
 * call always used the platform key, unconditionally. `FormBuilderService`'s
 * `extractFormDataWithAI` / `validateFormWithAI` already had a `tenantId` in
 * scope (used to load the form) and simply never threaded it through.
 *
 * `[UNVERIFIED: neither wrapper method has a caller anywhere in src today —
 * `extractFormDataWithAI`'s own pre-existing comment already says so —
 * grepped again to confirm. Fixed for correctness and specced so a future
 * caller inherits it right.]`
 */
describe('FormBuilderService — AI residency (tenantId passed top-level)', () => {
  const T = 'tenant-1';
  const FORM_ID = 'form-1';

  function build() {
    const form = {
      id: FORM_ID,
      tenantId: T,
      name: 'Subclass 482 nomination',
      entityType: 'case',
      layout: FormLayout.SINGLE_COLUMN,
      status: FormStatus.DRAFT,
      version: 1,
      fields: [{ key: 'passportNumber', label: 'Passport number', type: 'text' }],
    };

    const formSchemaRepo = {
      findOne: async ({ where }: any) =>
        where.id === FORM_ID && where.tenantId === T ? form : null,
    };

    const extractFromDocument = jest
      .fn()
      .mockResolvedValue({ result: JSON.stringify({ passportNumber: 'PA1' }) });
    const validateFormData = jest
      .fn()
      .mockResolvedValue({ result: JSON.stringify({ valid: true }) });
    const aiService = { extractFromDocument, validateFormData };

    const unused = {} as any;
    const service = new FormBuilderService(
      formSchemaRepo as any,
      unused, // formFieldRepo
      unused, // submissionRepo
      unused, // dataSource
      unused, // searchService
      aiService as any,
      unused, // documentHubService
    );

    return { service, extractFromDocument, validateFormData };
  }

  it('extractFormDataWithAI passes the form\'s own tenant to extractFromDocument', async () => {
    const { service, extractFromDocument } = build();

    await service.extractFormDataWithAI('raw ocr text', FORM_ID, T);

    expect(extractFromDocument).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      T,
    );
  });

  it('validateFormWithAI passes the form\'s own tenant to validateFormData', async () => {
    const { service, validateFormData } = build();

    await service.validateFormWithAI({ passportNumber: 'PA1' }, FORM_ID, T);

    expect(validateFormData).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      T,
    );
  });
});
