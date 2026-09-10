import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * No credential may reach a log line.
 *
 * `MailService.send` logged `message.text` verbatim at three sites, with the
 * comment "so an operator can still recover an action link". An invite body
 * reads `Set your password to get started: <url>` and the URL carries the
 * plaintext token. Invite and signup tokens live 7 days; a signup token
 * provisions a whole tenant; a reset link targets an **active** account,
 * including `platform_admin`.
 *
 * And it was not the rare branch. With a valid Resend key and no verified
 * sender domain, Resend rejects every non-owner recipient in the response
 * body — so the failure path ran on every message to a real customer, and each
 * one wrote a working credential into the runtime log stream.
 *
 * The definition of done says: no secrets, tokens, or personal data in code,
 * **logs**, fixtures, or error messages.
 *
 * The legitimate recovery route is the API — `POST /tenants` and
 * `resendInvite` return `inviteUrl` to an authenticated caller over TLS.
 */
const MAIL_DIR = __dirname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((p) => statSync(p).isFile() && p.endsWith('.ts') && !p.endsWith('.spec.ts'));
}

/** Strip comments — they discuss the hazard and must not trip the check. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('mail service never logs a credential', () => {
  const files = sourceFiles(MAIL_DIR);

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s logs no message body', (file) => {
    const src = code(readFileSync(file, 'utf8'));
    const logCalls = src.match(/this\.logger\.\w+\(([\s\S]*?)\);/g) ?? [];
    const offending = logCalls.filter((c) =>
      /message\.text|message\.html|\$\{url\}|\btoken\b/.test(c),
    );
    expect(offending).toEqual([]);
  });

  it.each(files)('%s builds no log line from a token or action URL', (file) => {
    const src = code(readFileSync(file, 'utf8'));
    // Catches a rename — logging a local `body`/`actionUrl` is the same defect.
    const logCalls = src.match(/this\.logger\.\w+\(([\s\S]*?)\);/g) ?? [];
    const offending = logCalls.filter((c) =>
      /\b(actionUrl|inviteUrl|resetUrl|body|plaintext)\b/.test(c),
    );
    expect(offending).toEqual([]);
  });
});
