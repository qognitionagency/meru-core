import { TaskService } from '../tasks/task.service';
import { WorkflowEngineService } from '../workflow/workflow.service';
import { DocumentHubService } from '../documents/document-hub.service';
import { FormBuilderService } from '../forms/form-builder.service';

/**
 * w1-07 leftovers (Owen's gate, 2026-11-17). These methods catch a failure
 * and answer a 200 with `{ success: false, error: error.message }`. The
 * global filter's generic-5xx rule never sees them, because nothing is
 * thrown, so the upstream text — an AI provider's error, which can carry a
 * host, a model id or a key prefix — went straight to the caller (and, for
 * form submissions and workflow instances, into stored JSON). Each now
 * answers a fixed reason and logs the detail.
 *
 * Instances are built from the prototype with only the collaborators each
 * method touches, so the spec does not depend on constructor arity.
 */
const LEAK = 'upstream https://internal-ai.example/v1 rejected key sk-live-123';
const boom = async () => {
  throw new Error(LEAK);
};
const logger = () => ({ error: jest.fn(), warn: jest.fn(), log: jest.fn(), debug: jest.fn() });

function make<T>(cls: { prototype: T }, fields: Record<string, unknown>): T {
  return Object.assign(Object.create(cls.prototype as object), { logger: logger(), ...fields });
}

function expectGeneric(body: unknown, svc: any) {
  expect(JSON.stringify(body)).not.toContain('internal-ai.example');
  expect(JSON.stringify(body)).not.toContain('sk-live');
  expect(JSON.stringify(svc.logger.error.mock.calls)).toContain('internal-ai.example');
}

describe('No upstream error text in 200 bodies', () => {
  it('TaskService.suggestTaskFromContext', async () => {
    const svc: any = make(TaskService, { aiService: { execute: boom } });
    const out = await svc.suggestTaskFromContext('t1', { description: 'x' });
    expect(out).toMatchObject({ success: false, suggestion: null });
    expect(typeof out.error).toBe('string');
    expectGeneric(out, svc);
  });

  it('WorkflowEngineService.getWorkflowRecommendations', async () => {
    const svc: any = make(WorkflowEngineService, {
      aiService: { execute: boom },
      listWorkflows: async () => [],
    });
    const out = await svc.getWorkflowRecommendations('t1', 'case', {});
    expect(out).toMatchObject({ success: false, recommendation: null });
    expectGeneric(out, svc);
  });

  it('WorkflowEngineService.processDocumentsWithAI, per document', async () => {
    let saved: any;
    const instance = { id: 'wi1', tenantId: 't1', context: {} };
    const svc: any = make(WorkflowEngineService, {
      findInstanceOrThrow: async () => instance,
      documentHubService: { extractDocumentData: boom },
      instanceRepo: { save: async (i: any) => (saved = i) },
    });
    const out = await svc.processDocumentsWithAI('t1', 'wi1', ['d1'], {}).catch((e: Error) => e);
    expectGeneric(out, svc);
    if (saved) expectGeneric(saved, svc);
  });

  it('DocumentHubService.extractDocumentData', async () => {
    const svc: any = make(DocumentHubService, {
      documentRepo: { findOne: async () => ({ id: 'd1', tenantId: 't1', name: 'n', fileType: 'pdf' }) },
      aiService: { execute: boom },
    });
    const out = await svc.extractDocumentData('d1', {});
    expect(out).toMatchObject({ success: false });
    expectGeneric(out, svc);
  });

  it('FormBuilderService.extractFormDataWithAI and validateFormWithAI', async () => {
    const form = { fields: [{ key: 'a', label: 'A', type: 'text' }] };
    const svc: any = make(FormBuilderService, {
      getForm: async () => form,
      aiService: { extractFromDocument: boom, validateFormData: boom },
    });
    const a = await svc.extractFormDataWithAI('doc', 'f1', 't1');
    const b = await svc.validateFormWithAI({}, 'f1', 't1');
    expect(a).toMatchObject({ success: false, extractedData: null });
    expect(b).toMatchObject({ success: false, validationResult: null });
    expectGeneric(a, svc);
    expectGeneric(b, svc);
  });

  it('FormBuilderService.processSubmissionDocuments — neither the body nor the stored metadata', async () => {
    let saved: any;
    const svc: any = make(FormBuilderService, {
      documentHubService: { analyzeDocument: boom },
      getSubmission: async () => ({ id: 's1', metadata: {} }),
      submissionRepo: { save: async (s: any) => (saved = s) },
    });
    const out = await svc.processSubmissionDocuments('t1', 's1', ['d1']);
    expect(out.failed).toBe(1);
    expectGeneric(out, svc);
    expectGeneric(saved, svc);
  });

  it('FormBuilderService.extractDataFromSubmissionDocuments', async () => {
    const svc: any = make(FormBuilderService, {
      getSubmissionDocuments: async () => [{ id: 'd1' }],
      documentHubService: { extractDocumentData: boom },
    });
    const out = await svc.extractDataFromSubmissionDocuments('t1', 's1', {});
    expectGeneric(out, svc);
  });
});
