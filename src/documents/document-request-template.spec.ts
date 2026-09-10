import * as fs from 'fs';
import * as path from 'path';

/**
 * The `document_request` template must be **sendable** by the route that
 * recommends it.
 *
 * `POST /documents/checklist/request` stamped `documentsRequestedAt`, called
 * `renderTemplate`, found `entityLabel` and `uploadUrl` unrendered, and
 * refused to send — every time, for every tenant, because the route supplied
 * neither. The refusal was correct: a client receiving a literal
 * `{{uploadUrl}}` is worse than no email. The consequence was not: the record
 * said the documents had been asked for, so `chase_outstanding_documents`
 * fired 72 hours later reminding an applicant about a request that had never
 * reached them.
 *
 * A unit test of the service cannot catch the recurrence, because the service
 * mocks the pack. Only the two artefacts compared against each other can: the
 * template's declared `variables`, from the JSON on disk, against the exact set
 * `DocumentRequestService` can put in the map. Either side moving alone breaks
 * this — a pack author adding `{{caseOfficer}}` silences the email as
 * completely as core dropping `entityLabel` would.
 */
const PACKS = path.resolve(__dirname, '../../packages/config-packs');

/**
 * Everything `DocumentRequestService.sendRequestTemplate` puts in `variables`.
 *
 * Kept in this literal, mirrored-by-hand form on purpose: importing it from the
 * service would make the test agree with the code by construction and assert
 * nothing. Changing the service means changing this line, which is the moment
 * to check the packs still validate against it.
 */
const SUPPLIED = new Set([
  'firstName',
  'lastName',
  'firmName',
  'entityId',
  'entityType',
  'documentCount',
  'documentList',
  // Added with `uiConfig.clientDocumentUploadUrl`; `entityLabel` is derived in
  // core from `recordNumber`, then the applicant's name.
  'entityLabel',
  'uploadUrl',
]);

/**
 * `entityLabel` and `uploadUrl` are supplied CONDITIONALLY — omitted, never
 * blanked, when there is no record number, no name, or no pack URL. So a pack
 * declaring them is necessary for a send but not sufficient; these two also
 * need the pack to carry the URL, which is the next test.
 */
const CONDITIONAL = ['entityLabel', 'uploadUrl'];

function readPack(rel: string): any {
  return JSON.parse(fs.readFileSync(path.join(PACKS, rel), 'utf8'));
}

function documentRequestTemplate(pack: any) {
  return (pack.messaging?.templates ?? []).find(
    (t: any) => t.key === 'document_request',
  );
}

describe('the document_request template can actually be sent', () => {
  const verticals = ['verticals/immigration.json', 'verticals/grc.json'];

  it.each(verticals)(
    '%s declares only variables the request route can supply',
    (rel) => {
      const template = documentRequestTemplate(readPack(rel));
      expect(template).toBeDefined();

      const undeclarable = template.variables.filter(
        (v: string) => !SUPPLIED.has(v),
      );
      expect(undeclarable).toEqual([]);
    },
  );

  it.each(verticals)(
    '%s uses no placeholder in the body that it has not declared',
    (rel) => {
      // The `variables` array is the contract; the body is what is actually
      // rendered. A placeholder present in one and not the other is how a
      // template passes review and still arrives half-written.
      const template = documentRequestTemplate(readPack(rel));
      const inBody = new Set<string>();
      for (const part of [template.subject, template.body]) {
        for (const m of String(part).matchAll(/{{(\w+)}}/g)) inBody.add(m[1]);
      }
      expect([...inBody].sort()).toEqual([...template.variables].sort());
    },
  );

  it('the immigration pack carries the upload URL, so the email sends', () => {
    // Without this key the route records the request, refuses to send, and
    // names `uploadUrl` in the reason — safe, but it is the state that made
    // "documents requested" mean nothing on ImmiStack.
    const pack = readPack('verticals/immigration.json');
    const url = pack.uiConfig?.clientDocumentUploadUrl;

    expect(typeof url).toBe('string');
    // A complete absolute URL, authored by the pack. Core appends nothing.
    expect(() => new URL(url)).not.toThrow();
    expect(url).toMatch(/^https:\/\//);
  });

  /**
   * **A known gap, recorded rather than papered over.** The GRC pack ships the
   * same `document_request` template and no `clientDocumentUploadUrl`, so a
   * GovernanceX tenant still records the request and sends nothing.
   *
   * That is deliberate: whether GovernanceX has a counterparty-facing upload
   * surface at all is an open question, and inventing a URL for it would put a
   * dead link in a bank's outbound mail. The failure is loud — `notified:
   * false`, `uploadUrl` named in the reason — not silent.
   *
   * When GovX gets one, add the key to `verticals/grc.json`, bump its version
   * and its four country overlays, and delete this test.
   */
  it('GRC has no upload URL yet, and that is a recorded gap not an oversight', () => {
    const pack = readPack('verticals/grc.json');
    expect(pack.uiConfig?.clientDocumentUploadUrl).toBeUndefined();
  });

  /**
   * A country overlay that pins itself to an old version never receives a base
   * pack change: `upsertPack` writes only on a strictly greater version and
   * otherwise reports `up-to-date` (CLAUDE.md §6, rule 4). The overlays inherit
   * `uiConfig` wholesale, so the value reaches them — but only if each one's
   * own version moved too. Four immigration overlays exist and a fifth would
   * silently miss out.
   */
  it('every immigration overlay inherits uiConfig rather than overriding it', () => {
    const dir = path.join(PACKS, 'countries');
    const overlays = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('-immigration.json'));

    expect(overlays.length).toBeGreaterThan(0);
    for (const file of overlays) {
      const pack = readPack(path.join('countries', file));
      expect(pack.extends).toBe('immigration');
      // If an overlay ever declares its own `uiConfig`, the merge is key by
      // key and it would still inherit this key — but a *sibling* key added
      // there is the moment to re-check that the upload URL is still right for
      // that country's portal.
      expect(pack.uiConfig?.clientDocumentUploadUrl).toBeUndefined();
    }
  });

  it('conditional variables are the two that can be legitimately absent', () => {
    // Pins the intent: everything else in SUPPLIED is always present, so the
    // only reason a send is refused is a record with no label or a pack with
    // no URL — both diagnosable from the reason string.
    for (const v of CONDITIONAL) expect(SUPPLIED.has(v)).toBe(true);
  });
});
