import * as fs from 'fs';
import * as path from 'path';

/**
 * `welcome_client` declares `{{portalUrl}}` and, before this change, nothing
 * in `src` supplied it — grepped: zero matches for `portalUrl` anywhere
 * under `src`. Same defect class as `document_request` and `{{uploadUrl}}`
 * (`src/documents/document-request-template.spec.ts`), fixed the same way:
 * `uiConfig.clientPortalUrl`, a complete absolute URL authored by the pack,
 * read by `SequenceRunnerService.portalUrlFor` and supplied CONDITIONALLY by
 * both `send()` and the `POST /messaging/templates/:key/preview` route —
 * never to a placeholder, since `renderTemplate` does `String(value)` and an
 * empty or `undefined` value would render as `''` or the literal text
 * `"undefined"` and pass the unrendered-variable check.
 *
 * **Narrower than the `document_request` fix, and this file says so rather
 * than pretending otherwise.** `welcome_client` also declares `entityLabel`,
 * `contactName` and `contactEmail`, and nothing in `src` supplies any of the
 * three today. This pass closes only `portalUrl` — the one variable named in
 * the brief. Inventing a `contactName`/`contactEmail` source (which staff
 * user? which field?) is a product decision, not something to guess at.
 * `welcome_client` therefore still cannot be fully sent; it is one
 * unrendered variable closer than it was, and the last test below pins the
 * remaining gap so it is noticed rather than silently re-discovered.
 *
 * **Scope: ImmiStack only.** `grc.json`'s `welcome_client` template declares
 * the identical `{{portalUrl}}` and nothing supplies it either — same
 * defect, deliberately untouched here (operator instruction: GovX is a
 * separate project). See the last test.
 */
const PACKS = path.resolve(__dirname, '../../packages/config-packs');

function readPack(rel: string): any {
  return JSON.parse(fs.readFileSync(path.join(PACKS, rel), 'utf8'));
}

function welcomeClientTemplate(pack: any) {
  return (pack.messaging?.templates ?? []).find(
    (t: any) => t.key === 'welcome_client',
  );
}

describe('welcome_client: portalUrl is now suppliable (ImmiStack only)', () => {
  it('the immigration pack carries a complete absolute clientPortalUrl', () => {
    // Without this key `portalUrlFor` returns null, `portalUrl` is never set,
    // and `{{portalUrl}}` reaches `unrendered` — safe, but it is the state
    // that made every client-portal invitation this route could send
    // literally undeliverable.
    const pack = readPack('verticals/immigration.json');
    const url = pack.uiConfig?.clientPortalUrl;

    expect(typeof url).toBe('string');
    // A complete absolute URL, authored by the pack. Core appends nothing.
    expect(() => new URL(url)).not.toThrow();
    expect(url).toMatch(/^https:\/\//);
  });

  it('every immigration overlay inherits clientPortalUrl rather than overriding it', () => {
    const dir = path.join(PACKS, 'countries');
    const overlays = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('-immigration.json'));

    expect(overlays.length).toBeGreaterThan(0);
    for (const file of overlays) {
      const pack = readPack(path.join('countries', file));
      expect(pack.extends).toBe('immigration');
      // If an overlay ever declares its own `uiConfig`, key-by-key merge
      // would still inherit this — but a *sibling* key added there is the
      // moment to re-check the portal URL is still right for that country.
      expect(pack.uiConfig?.clientPortalUrl).toBeUndefined();
    }
  });

  it('every immigration overlay version moved so the loader actually re-resolves it', () => {
    // `upsertPack` only writes on a strictly greater version than what is
    // already stored (CLAUDE.md §6, rule 4). Overlays inherit `uiConfig`
    // wholesale in the source tree, but a pinned tenant on an unmoved
    // overlay version would never receive the new key at runtime — the exact
    // gap `clientDocumentUploadUrl`'s own fix already had to close once.
    const PRE_FIX_VERSION: Record<string, string> = {
      'au-immigration.json': '2.8.2',
      'ca-immigration.json': '2.4.1',
      'uk-immigration.json': '2.4.1',
      'nz-immigration.json': '2.4.1',
    };
    const dir = path.join(PACKS, 'countries');
    const overlays = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('-immigration.json'));

    expect(overlays.length).toBe(Object.keys(PRE_FIX_VERSION).length);
    for (const file of overlays) {
      const pack = readPack(path.join('countries', file));
      expect(pack.version).not.toBe(PRE_FIX_VERSION[file]);
    }
  });

  it('records the three variables this pass does not close', () => {
    // Not a claim that the template sends end to end — see the file doc
    // comment. If this list ever shrinks to `[]`, this test should be
    // updated (or deleted) in the same change that closes the gap, not left
    // to quietly pass on a stale assumption.
    const template = welcomeClientTemplate(readPack('verticals/immigration.json'));
    expect(template).toBeDefined();

    const suppliedByCore = new Set([
      // SequenceRunnerService.variablesFor
      'firstName',
      'lastName',
      'firmName',
      'entityId',
      'entityType',
      'dueDate',
      // This pass
      'portalUrl',
    ]);
    const stillUnsuppliable = (template.variables as string[]).filter(
      (v) => !suppliedByCore.has(v),
    );
    expect(stillUnsuppliable.sort()).toEqual([
      'contactEmail',
      'contactName',
      'entityLabel',
    ]);
  });

  it('uses no placeholder in the body it has not declared', () => {
    const template = welcomeClientTemplate(readPack('verticals/immigration.json'));
    const inBody = new Set<string>();
    for (const part of [template.subject, template.body]) {
      for (const m of String(part).matchAll(/{{(\w+)}}/g)) inBody.add(m[1]);
    }
    expect([...inBody].sort()).toEqual([...template.variables].sort());
  });

  it('GRC still has no clientPortalUrl — a recorded gap, not an oversight', () => {
    // grc.json's own welcome_client template (line ~1385) declares the
    // identical {{portalUrl}} and nothing supplies it either. Left
    // deliberately untouched: operator scope for this pass is ImmiStack
    // only, GovX is a separate project.
    const pack = readPack('verticals/grc.json');
    expect(pack.uiConfig?.clientPortalUrl).toBeUndefined();
  });
});
