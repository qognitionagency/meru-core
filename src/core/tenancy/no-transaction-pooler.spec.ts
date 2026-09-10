import { DataSource } from 'typeorm';
import { applyRlsToDataSource } from './rls.datasource';

/**
 * Guards the failure observed on 2026-09-10, which passed every other gate.
 *
 * A `-pooler` connection string looks identical to a direct one, the app boots,
 * and every query succeeds. The only symptom is that `set_config(..., false)` —
 * session-scoped — leaks the tenant binding to whichever client inherits the
 * backend next. Measured on a freshly opened pooled connection:
 * `app.rls_bypassed()` came back `true` and `app.current_tenant_id()` returned
 * a tenant id from an earlier session. `rls:verify` went 10/10 → 4/10, with
 * every write-containment check failing; the direct host passed immediately.
 *
 * `rls:verify` does catch it, but only when somebody runs it against the right
 * URL. This fails at boot instead.
 */
describe('RLS binding refuses a transaction-pooled host', () => {
  const ds = (url: string) =>
    ({ options: { url }, driver: {} }) as unknown as DataSource;

  const POOLED =
    'postgresql://u:p@ep-small-darkness-aeyx0p5j-pooler.c-2.us-east-2.aws.neon.tech/neondb';
  const DIRECT =
    'postgresql://u:p@ep-small-darkness-aeyx0p5j.c-2.us-east-2.aws.neon.tech/neondb';

  it('throws on a -pooler host', () => {
    expect(() => applyRlsToDataSource(ds(POOLED))).toThrow(/transaction-pooled/i);
  });

  it('names the fix in the message, not just the problem', () => {
    // Whoever hits this is mid-deploy and needs the answer, not a diagnosis.
    expect(() => applyRlsToDataSource(ds(POOLED))).toThrow(/drop\s+"?-pooler/i);
  });

  it('says WHY, so nobody "fixes" it by relaxing the check', () => {
    expect(() => applyRlsToDataSource(ds(POOLED))).toThrow(/bypass_rls/);
  });

  it('allows the direct host', () => {
    // Reaches the driver patch, which this stub does not implement — proving it
    // got past the guard rather than being rejected by it.
    expect(() => applyRlsToDataSource(ds(DIRECT))).not.toThrow(
      /transaction-pooled/i,
    );
  });

  it('does not false-positive on a host merely containing the word', () => {
    const lookalike =
      'postgresql://u:p@pooler-metrics.internal.example.com/neondb';
    expect(() => applyRlsToDataSource(ds(lookalike))).not.toThrow(
      /transaction-pooled/i,
    );
  });
});
