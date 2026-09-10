import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { MailBrand, UNBRANDED_MAIL, withDisplayName } from './mail-brand';

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain-text body. Always required — never ship HTML-only mail. */
  text: string;
  html?: string;
  /**
   * Overrides the display name on `RESEND_FROM` for this message only — the
   * address is never changed (see `withDisplayName`). Absent means the
   * configured sender goes out as-is.
   */
  from?: string;
}

/**
 * Outbound transactional email, via Resend.
 *
 * One mail path for the whole platform. It was previously AWS SES, and the
 * only SES client lived privately inside `TenantProvisioningService` — so
 * invites and password resets had nowhere to send from, and the welcome email
 * worked while everything else silently did not.
 *
 * When Resend is not configured the service does **not** pretend to send: it
 * logs the full message, including any action link, and reports
 * `delivered: false`. A no-op that returns success is what makes "the invite
 * never arrived" take a day to diagnose, and the logged link is what lets an
 * operator unblock a user before credentials are sorted out.
 */
/**
 * The one place an invite URL is built.
 *
 * Exported because `IamService.resendInvite` now returns this link to the
 * authenticated operator as well as emailing it, and two independently
 * constructed URLs is how a working email and a broken operator fallback end
 * up differing by a path segment nobody notices until onboarding fails.
 */
export function inviteUrlFor(appUrl: string, token: string): string {
  return `${appUrl}/accept-invite?token=${encodeURIComponent(token)}`;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend | null;
  private readonly from: string;
  readonly appUrl: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = config.get<string>('RESEND_API_KEY');

    // Resend requires the sender to be on a domain verified in the account.
    // `onboarding@resend.dev` is Resend's own sandbox sender, which works
    // without domain verification but only delivers to the account owner —
    // fine for a first smoke test, useless in production, hence the warning.
    this.from =
      config.get<string>('RESEND_FROM') ?? 'Meru <onboarding@resend.dev>';
    // `app.meru.com` used to be the fallback. It is **NXDOMAIN** — the
    // workspace `CLAUDE.md` §4 domain table records that it does not resolve
    // and the dashboard has no public hostname today. Every link in every
    // email this service sends is one a customer clicks, so a fallback that
    // cannot resolve turns an unset variable into a dead link rather than a
    // loud failure. `app.immistack.com` is the one product hostname that is
    // verified live and serving the app the invite flow actually lives in.
    this.appUrl = config.get<string>('APP_URL') ?? 'https://app.immistack.com';

    if (!config.get<string>('APP_URL')) {
      this.logger.warn(
        `APP_URL is unset — every emailed link will point at ${this.appUrl}. ` +
          'Set it explicitly per environment rather than relying on this.',
      );
    }

    if (apiKey) {
      this.resend = new Resend(apiKey);
      this.logger.log(`Mail enabled via Resend — from: ${this.from}`);

      if (this.from.includes('onboarding@resend.dev')) {
        this.logger.warn(
          'RESEND_FROM is unset, using Resend’s sandbox sender. It only ' +
            'delivers to the Resend account owner — set RESEND_FROM to an ' +
            'address on a verified domain before relying on this.',
        );
      }
    } else {
      this.resend = null;
      this.logger.warn(
        'Mail disabled — set RESEND_API_KEY to send. Messages will be logged ' +
          'in full (including action links) instead of delivered.',
      );
    }
  }

  isConfigured(): boolean {
    return this.resend !== null;
  }

  /**
   * Send a message. Never throws.
   *
   * Mail is a side effect of flows that must complete regardless — a user has
   * still been invited even if Resend is down, and a password-reset request must
   * not leak "this address exists" through a 500. Failures are logged and
   * reported in the return value.
   */
  async send(message: MailMessage): Promise<{ delivered: boolean }> {
    if (!this.resend) {
      this.logger.warn(
        `[mail-not-configured] to=${message.to} subject="${message.subject}"\n${message.text}`,
      );
      return { delivered: false };
    }

    try {
      const { data, error } = await this.resend.emails.send({
        from: message.from ?? this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      });

      // Resend reports failures in the response body rather than by throwing.
      // Treating a populated `error` as success is exactly the 200-with-error
      // trap the government adapters had — the send would look fine and the
      // mail would never arrive.
      if (error) {
        this.logger.error(
          `Mail to ${message.to} rejected by Resend: ${error.name} — ${error.message}`,
        );
        // Log the body so an operator can still recover an action link.
        this.logger.warn(`[mail-undelivered] ${message.text}`);
        return { delivered: false };
      }

      this.logger.log(
        `Mail sent to ${message.to}: ${message.subject} (id: ${data?.id})`,
      );
      return { delivered: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Mail to ${message.to} failed: ${detail}`);
      this.logger.warn(`[mail-undelivered] ${message.text}`);
      return { delivered: false };
    }
  }

  /** Escape interpolated values for the HTML bodies below. */
  escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Shared chrome, signed by the tenant rather than by the platform.
   *
   * The footer used to read "Meru Regulatory OS — meru.com" on every email
   * including the ones sent to a firm's own clients. An applicant has no
   * relationship with Meru, so the footer now carries the brand the recipient
   * recognises, and carries nothing at all when there is no tenant to name.
   */
  private layout(heading: string, bodyHtml: string, brand: MailBrand): string {
    const footer = brand.name
      ? `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
        <p style="color:#6b7280;font-size:12px">${this.escapeHtml(brand.name)}</p>`
      : '';

    return `
      <html><body style="font-family:sans-serif;max-width:600px;margin:auto;color:#111">
        <h2>${this.escapeHtml(heading)}</h2>
        ${bodyHtml}
        ${footer}
      </body></html>
    `;
  }

  /**
   * The plain-text sign-off lines, or none.
   *
   * `— The Meru Team` was on every invitation, welcome and reset. Nothing is
   * better than a wrong name: an unbranded email simply ends after its last
   * sentence.
   */
  private signOff(brand: MailBrand): string[] {
    return brand.name ? ['', `— ${brand.name}`] : [];
  }

  /**
   * The `From` header for a branded message. The verified address from
   * `RESEND_FROM` is preserved; only the display name becomes the tenant's.
   */
  private fromFor(brand: MailBrand): string | undefined {
    return brand.name ? withDisplayName(this.from, brand.name) : undefined;
  }

  private actionButton(url: string, label: string): string {
    return `<p><a href="${url}" style="background:#0f172a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">${this.escapeHtml(label)}</a></p>`;
  }

  /**
   * Invitation to join a tenant.
   *
   * Carries a set-password link rather than a temporary password. The invite
   * used to return a generated plaintext password to whoever called the API,
   * which meant anyone who could invite could immediately authenticate as the
   * invitee. A single-use token the invitee alone receives closes that.
   */
  async sendInvite(params: {
    to: string;
    inviterName: string;
    tenantName: string;
    /** The recipient's own tenant, resolved by the caller. */
    brand: MailBrand;
    token: string;
    expiresAt: Date;
  }): Promise<{ delivered: boolean }> {
    const url = inviteUrlFor(this.appUrl, params.token);
    const expiry = params.expiresAt.toUTCString();

    return this.send({
      to: params.to,
      from: this.fromFor(params.brand),
      subject: `${params.inviterName} invited you to join ${params.tenantName}`,
      text: [
        `${params.inviterName} has invited you to join ${params.tenantName}.`,
        '',
        `Set your password to get started: ${url}`,
        '',
        `This link can be used once and expires on ${expiry}.`,
        'If you were not expecting this invitation you can ignore this email.',
        ...this.signOff(params.brand),
      ].join('\n'),
      html: this.layout(
        `You have been invited to ${params.tenantName}`,
        `<p><strong>${this.escapeHtml(params.inviterName)}</strong> has invited you to join
           <strong>${this.escapeHtml(params.tenantName)}</strong>.</p>
         ${this.actionButton(url, 'Set your password')}
         <p style="color:#6b7280;font-size:13px">This link can be used once and expires on ${expiry}.
            If you were not expecting this invitation you can ignore this email.</p>`,
        params.brand,
      ),
    });
  }

  /** Welcome email for a freshly provisioned workspace. */
  async sendWelcome(params: {
    to: string;
    firstName?: string | null;
    tenantName: string;
    tenantSlug: string;
    /** The newly provisioned tenant's own brand. */
    brand: MailBrand;
    plan: string;
    trialEndsAt?: Date | null;
  }): Promise<{ delivered: boolean }> {
    const loginUrl = `${this.appUrl}/login?tenant=${params.tenantSlug}`;
    const trial = params.trialEndsAt
      ? `Trial ends: ${params.trialEndsAt.toDateString()}`
      : '';

    return this.send({
      to: params.to,
      from: this.fromFor(params.brand),
      subject: `Welcome — your ${params.tenantName} workspace is ready`,
      text: [
        `Hi${params.firstName ? ` ${params.firstName}` : ''},`,
        '',
        `Your workspace for ${params.tenantName} has been created.`,
        '',
        `Log in here: ${loginUrl}`,
        '',
        `Workspace: ${params.tenantSlug}`,
        `Plan: ${params.plan}`,
        trial,
        '',
        'If you have questions, reply to this email.',
        ...this.signOff(params.brand),
      ]
        .filter(Boolean)
        .join('\n'),
      html: this.layout(
        `Welcome to ${params.tenantName}`,
        `<p>Your workspace for <strong>${this.escapeHtml(params.tenantName)}</strong> is ready.</p>
         ${this.actionButton(loginUrl, 'Log in to your workspace')}
         <p style="color:#6b7280;font-size:13px">
           Workspace: ${this.escapeHtml(params.tenantSlug)}<br>
           Plan: ${this.escapeHtml(params.plan)}${trial ? `<br>${trial}` : ''}
         </p>`,
        params.brand,
      ),
    });
  }

  /**
   * Where a DEF-1 signup invite actually lands.
   *
   * `/signup` — what this used to build — **does not exist in the ImmiStack
   * app.** The provisioning wizard lives at `app/(auth)/onboarding`, and it
   * reads `?token=` from its own query string. Every invite email sent before
   * this was a 404 for the recipient: a dead link is worse than no email,
   * because the operator's side reports `delivered: true`.
   *
   * Public so `TenantProvisioningService` can hand the operator the identical
   * URL it emailed (H3's recovery path) instead of assembling a second one
   * that could drift from this.
   */
  signupInviteUrl(token: string): string {
    return `${this.appUrl}/onboarding?token=${encodeURIComponent(token)}`;
  }

  /**
   * Invitation to self-provision a new workspace via `POST /tenants/signup`
   * (DEF-1). Distinct from `sendInvite` above, which invites a user *into* an
   * existing tenant — this invites someone to *create* one, and the link goes
   * to the onboarding wizard rather than accept-invite.
   */
  async sendTenantSignupInvite(params: {
    to: string;
    token: string;
    expiresAt: Date;
  }): Promise<{ delivered: boolean }> {
    const url = this.signupInviteUrl(params.token);
    const expiry = params.expiresAt.toUTCString();

    // The one genuinely unbranded email in the product: the recipient has no
    // tenant yet — they are being invited to create one — so there is no firm
    // to sign it for, and naming the platform to someone who was sold a
    // vertical product would be as wrong as it is on the other three.
    return this.send({
      to: params.to,
      subject: 'You are invited to create a workspace',
      text: [
        'You have been invited to create a workspace.',
        '',
        `Get started here: ${url}`,
        '',
        `This link can be used once and expires on ${expiry}.`,
        'If you were not expecting this invitation you can ignore this email.',
      ].join('\n'),
      html: this.layout(
        'You are invited to create a workspace',
        `<p>You have been invited to create a workspace.</p>
         ${this.actionButton(url, 'Create your workspace')}
         <p style="color:#6b7280;font-size:13px">This link can be used once and expires on ${expiry}.
            If you were not expecting this invitation you can ignore this email.</p>`,
        UNBRANDED_MAIL,
      ),
    });
  }

  /** Password-reset link. Same single-use token machinery as the invite. */
  async sendPasswordReset(params: {
    to: string;
    firstName?: string | null;
    /** The account holder's own tenant, resolved by the caller. */
    brand: MailBrand;
    token: string;
    expiresAt: Date;
  }): Promise<{ delivered: boolean }> {
    const url = `${this.appUrl}/reset-password?token=${params.token}`;
    const expiry = params.expiresAt.toUTCString();
    // "Reset your <firm> password" when the firm is known; a bare "Reset your
    // password" otherwise. The account is the firm's, not the platform's.
    const account = params.brand.name ? `${params.brand.name} ` : '';

    return this.send({
      to: params.to,
      from: this.fromFor(params.brand),
      subject: `Reset your ${account}password`,
      text: [
        `Hi${params.firstName ? ` ${params.firstName}` : ''},`,
        '',
        `We received a request to reset your ${account}password.`,
        '',
        `Reset it here: ${url}`,
        '',
        `This link can be used once and expires on ${expiry}.`,
        'If you did not request this, you can ignore this email — your password will not change.',
        ...this.signOff(params.brand),
      ].join('\n'),
      html: this.layout(
        'Reset your password',
        `<p>We received a request to reset your ${this.escapeHtml(account)}password.</p>
         ${this.actionButton(url, 'Reset password')}
         <p style="color:#6b7280;font-size:13px">This link can be used once and expires on ${expiry}.
            If you did not request this, ignore this email — your password will not change.</p>`,
        params.brand,
      ),
    });
  }
}
