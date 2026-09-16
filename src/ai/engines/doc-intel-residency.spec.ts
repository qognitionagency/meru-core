import { ServiceUnavailableException } from '@nestjs/common';
import { DocIntelEngine } from './doc-intel.engine';
import { AiService, AiTenantContextUnboundError } from '../ai.service';

/**
 * `DocIntelEngine` used to build its own `OpenAI` client at constructor time
 * off a bare `OPENAI_API_KEY` and never consulted a tenant's connector — a
 * tenant that connected a self-hosted or residency-scoped provider
 * specifically so passports, payslips and health assessments never reached
 * OpenAI still had every document sent there. Fixed by routing through
 * `AiService.clientFor` per request, which this file proves does three
 * things: resolves per tenant, degrades to the heuristic path (never a
 * platform fallback) when nothing is configured, and — the part that
 * actually matters for residency — never retries against the platform key
 * when a resolved tenant connector's own call fails.
 */
describe('DocIntelEngine — data residency', () => {
  const chatCreate = jest.fn();
  const clientFor = jest.fn();
  let engine: DocIntelEngine;

  const baseRequest = {
    tenantId: 'tenant-a',
    documentId: 'doc-1',
    kind: 'passport' as const,
    base64Image: 'ZmFrZS1pbWFnZS1ieXRlcw==',
    mimeType: 'image/jpeg',
  };

  const fakeVisionResponse = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            rawText: 'P<AUS...',
            confidence: 0.9,
            fields: { passportNumber: 'PA1234567' },
          }),
        },
      },
    ],
  };

  beforeEach(() => {
    chatCreate.mockReset();
    clientFor.mockReset();
    engine = new DocIntelEngine({ clientFor } as unknown as AiService);
  });

  it('asks AiService.clientFor for THIS request\'s tenant, not a shared singleton', async () => {
    clientFor.mockRejectedValue(
      new ServiceUnavailableException('AI is not configured'),
    );

    await engine.process(baseRequest);

    expect(clientFor).toHaveBeenCalledWith('tenant-a');
  });

  it('routes extraction through the tenant connector when one is resolved', async () => {
    chatCreate.mockResolvedValue(fakeVisionResponse);
    clientFor.mockResolvedValue({
      client: { chat: { completions: { create: chatCreate } } },
      defaultModel: null,
      source: 'tenant_connector',
    });

    const result = await engine.process(baseRequest);

    expect(chatCreate).toHaveBeenCalledTimes(1);
    expect(result.modelUsed).toBe('gpt-4o');
    // The evidence a residency-scoped tenant needs: which credential answered.
    expect(result.provenance).toEqual({ source: 'tenant_connector' });
  });

  it('falls back to heuristic extraction, not the platform key, when nothing is configured', async () => {
    clientFor.mockRejectedValue(
      new ServiceUnavailableException(
        'AI is not configured: this tenant has no AI provider connected ' +
          'and the platform has no OPENAI_API_KEY set.',
      ),
    );

    const result = await engine.process(baseRequest);

    expect(chatCreate).not.toHaveBeenCalled();
    expect(result.modelUsed).toBe('heuristic');
    // Absent, not 'platform' — no document content left this process at all.
    expect(result.provenance).toBeNull();
  });

  /**
   * §7.3: a 0.45-confidence heuristic result LOOKS like an ordinary,
   * honestly-labelled low-quality extraction. That is the correct answer to
   * "nothing is configured for this tenant" and the WRONG answer to "a real
   * connector might exist and could not be reached or trusted" — the second
   * case must surface as a failure, not a result that merely looks worse.
   * Only `clientFor`'s own `ServiceUnavailableException` ("nothing anywhere
   * is configured") may degrade to heuristic; every other error — an unbound
   * tenant context being the one this pass closes — must fail the request.
   */
  it('FAILS THE REQUEST (does not degrade to heuristic) when clientFor throws anything other than "nothing configured"', async () => {
    clientFor.mockRejectedValue(
      new AiTenantContextUnboundError('tenant-a', undefined, false),
    );

    await expect(engine.process(baseRequest)).rejects.toBeInstanceOf(
      AiTenantContextUnboundError,
    );

    // Never silently substituted with the heuristic path.
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it('FAILS THE REQUEST on an undecryptable/broken connector row, same reasoning', async () => {
    clientFor.mockRejectedValue(new Error('bad decrypt: invalid auth tag'));

    await expect(engine.process(baseRequest)).rejects.toThrow(
      /bad decrypt/,
    );

    expect(chatCreate).not.toHaveBeenCalled();
  });

  it('FAIL CLOSED: a resolved tenant connector that errors is never retried against the platform key', async () => {
    chatCreate.mockRejectedValue(new Error('ECONNREFUSED self-hosted endpoint down'));
    clientFor.mockResolvedValue({
      client: { chat: { completions: { create: chatCreate } } },
      defaultModel: null,
      source: 'tenant_connector',
    });

    const result = await engine.process(baseRequest);

    // clientFor is called exactly once for this request — there is no second
    // resolution attempt (which would be the only way a platform fallback
    // could happen), and the failure is reported rather than silently routed
    // around.
    expect(clientFor).toHaveBeenCalledTimes(1);
    expect(chatCreate).toHaveBeenCalledTimes(1);
    expect(result.modelUsed).toBe('error');
    expect(result.extractedFields).toEqual([]);
    // Provenance stays set to the connector that actually failed, so the
    // failure is attributable rather than looking like "nothing configured".
    expect(result.provenance).toEqual({ source: 'tenant_connector' });
  });

  it('never calls the vision model at all when the request carries no image', async () => {
    await engine.process({ ...baseRequest, base64Image: undefined, fileUrl: undefined });

    expect(clientFor).not.toHaveBeenCalled();
    expect(chatCreate).not.toHaveBeenCalled();
  });
});
