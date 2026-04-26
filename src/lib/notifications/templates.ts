/**
 * Email templates for every notification event type (D-16/D-17/D-18/D-19).
 *
 * Every render function returns `{subject, html, text}`. All interpolated
 * user-supplied values pass through `escapeHtml()` in the HTML version to
 * mitigate T-04 (HTML injection via plugin name / public note / findings).
 * Plaintext versions contain the raw values (plaintext email clients
 * render them literally; no escaping needed).
 *
 * Subject format (D-19):  `[EmDash] <event>: <entity>[ <version>]`
 * Footer (every html body): unsubscribe-style link to the settings page.
 *
 * We deliberately do NOT use react-email, MJML, or Handlebars — tagged
 * template literals give us zero runtime cost and sidestep known
 * Cloudflare Workers bundler issues with the React-email packages.
 */

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape the 5 HTML-significant characters in a user-supplied string.
 * Sufficient for our scope: we only interpolate into element text and
 * double-quoted attribute values, never into scripts or unquoted attrs.
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch] ?? ch);
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Canonical `From` address — caller imports this into the Unosend client. */
export const FROM_ADDRESS =
  "EmDash Notifications <notifications@emdashcms.org>";

/** Canonical `Reply-To` — replies bounce back to a parked address. */
export const REPLY_TO = "no-reply@emdashcms.org";

const SETTINGS_URL = "https://emdashcms.org/dashboard/settings";

/** Shared HTML shell with consistent styling and the settings footer. */
function htmlShell(body: string): string {
  return `<!DOCTYPE html><html><body style="font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
${body}
<hr style="margin-top: 32px; border: none; border-top: 1px solid #e5e5e5;">
<p style="font-size: 12px; color: #666;">You are receiving this because you own or maintain this item on EmDash. Manage notification preferences at <a href="${SETTINGS_URL}">emdashcms.org/dashboard/settings</a>.</p>
</body></html>`;
}

/** Shared plaintext footer. */
function textFooter(): string {
  return `\n\n--\nYou are receiving this because you own or maintain this item on EmDash.\nManage preferences: ${SETTINGS_URL}`;
}

// ---------------------------------------------------------------------------
// renderAuditFail
// ---------------------------------------------------------------------------

export interface AuditFailParams {
  pluginName: string;
  version: string;
  verdict: "fail";
  riskScore: number;
  findingCount: number;
  dashboardUrl: string;
  /** Top 3 findings to preview inline so the author has actionable
   *  context without needing to click through to the dashboard. */
  topFindings?: { severity: string; title: string }[];
  /** Direct link to upload a corrected version against this plugin.
   *  Optional for backwards compatibility — falls back to dashboardUrl. */
  uploadUrl?: string;
}

export function renderAuditFail(p: AuditFailParams): RenderedEmail {
  const name = escapeHtml(p.pluginName);
  const ver = escapeHtml(p.version);
  const url = escapeHtml(p.dashboardUrl);
  const upload = escapeHtml(p.uploadUrl ?? p.dashboardUrl);

  const findingsHtml = p.topFindings && p.topFindings.length > 0
    ? `<p style="margin: 16px 0 8px;"><strong>Top findings:</strong></p>
<ul>
${p.topFindings
  .map(
    (f) =>
      `  <li><strong>${escapeHtml(f.severity.toUpperCase())}</strong> &mdash; ${escapeHtml(f.title)}</li>`,
  )
  .join("\n")}
</ul>`
    : "";

  const findingsText = p.topFindings && p.topFindings.length > 0
    ? `\nTop findings:\n${p.topFindings.map((f) => `  - ${f.severity.toUpperCase()} — ${f.title}`).join("\n")}\n`
    : "";

  const body = `<h1 style="font-size: 20px; margin: 0 0 16px;">Audit failed for ${name} ${ver}</h1>
<p>The automated code audit returned a <strong>fail</strong> verdict. This version has been rejected — no downloads are being served.</p>
<ul>
  <li>Risk score: ${p.riskScore}/100</li>
  <li>Findings: ${p.findingCount}</li>
</ul>
${findingsHtml}
<p>When you've made changes, <a href="${upload}">upload a new version on the same plugin</a> &mdash; the audit re-runs automatically. Don't register a new plugin for the fix; that creates a duplicate.</p>
<p><a href="${url}">Review full findings in the dashboard</a></p>`;
  return {
    subject: `[EmDash] audit fail: ${p.pluginName} ${p.version}`,
    html: htmlShell(body),
    text: `Audit failed for ${p.pluginName} ${p.version}

The automated code audit returned a fail verdict. This version has been rejected — no downloads are being served.

- Risk score: ${p.riskScore}/100
- Findings: ${p.findingCount}
${findingsText}
When you've made changes, upload a new version on the same plugin — the audit re-runs automatically. Don't register a new plugin for the fix; that creates a duplicate.

Upload a fix: ${p.uploadUrl ?? p.dashboardUrl}
Review in dashboard: ${p.dashboardUrl}${textFooter()}`,
  };
}

// ---------------------------------------------------------------------------
// renderAuditError
// ---------------------------------------------------------------------------

export interface AuditErrorParams {
  pluginName: string;
  version: string;
  errorMessage: string;
  dashboardUrl: string;
}

export function renderAuditError(p: AuditErrorParams): RenderedEmail {
  const name = escapeHtml(p.pluginName);
  const ver = escapeHtml(p.version);
  const errMsg = escapeHtml(p.errorMessage);
  const url = escapeHtml(p.dashboardUrl);
  const body = `<h1 style="font-size: 20px; margin: 0 0 16px;">Audit errored for ${name} ${ver}</h1>
<p>The automated audit could not complete, so this version has been held in a pending state pending operator action.</p>
<p><strong>Error:</strong> ${errMsg}</p>
<p><a href="${url}">Open the version in the dashboard</a></p>`;
  return {
    subject: `[EmDash] audit error: ${p.pluginName} ${p.version}`,
    html: htmlShell(body),
    text: `Audit errored for ${p.pluginName} ${p.version}

The automated audit could not complete, so this version is on hold pending operator action.

Error: ${p.errorMessage}

Open in dashboard: ${p.dashboardUrl}${textFooter()}`,
  };
}

// ---------------------------------------------------------------------------
// renderAuditWarn
// ---------------------------------------------------------------------------

export interface AuditWarnParams {
  pluginName: string;
  version: string;
  verdict: "warn";
  riskScore: number;
  findingCount: number;
  dashboardUrl: string;
}

export function renderAuditWarn(p: AuditWarnParams): RenderedEmail {
  const name = escapeHtml(p.pluginName);
  const ver = escapeHtml(p.version);
  const url = escapeHtml(p.dashboardUrl);
  const body = `<h1 style="font-size: 20px; margin: 0 0 16px;">Audit warning for ${name} ${ver}</h1>
<p>The automated code audit returned a <strong>warn</strong> verdict. The version has been published with a caution badge visible to users browsing the marketplace.</p>
<ul>
  <li>Risk score: ${p.riskScore}/100</li>
  <li>Findings: ${p.findingCount}</li>
</ul>
<p><a href="${url}">Review findings in the dashboard</a></p>`;
  return {
    subject: `[EmDash] audit warn: ${p.pluginName} ${p.version}`,
    html: htmlShell(body),
    text: `Audit warning for ${p.pluginName} ${p.version}

The automated code audit returned a warn verdict. The version has been published with a caution badge.

- Risk score: ${p.riskScore}/100
- Findings: ${p.findingCount}

Review in dashboard: ${p.dashboardUrl}${textFooter()}`,
  };
}

// ---------------------------------------------------------------------------
// renderAuditPass
// ---------------------------------------------------------------------------

export interface AuditPassParams {
  pluginName: string;
  version: string;
  riskScore: number;
  dashboardUrl: string;
}

export function renderAuditPass(p: AuditPassParams): RenderedEmail {
  const name = escapeHtml(p.pluginName);
  const ver = escapeHtml(p.version);
  const url = escapeHtml(p.dashboardUrl);
  const body = `<h1 style="font-size: 20px; margin: 0 0 16px;">Audit passed for ${name} ${ver}</h1>
<p>The automated code audit returned a clean pass. This version is live on the marketplace.</p>
<ul>
  <li>Risk score: ${p.riskScore}/100</li>
</ul>
<p><a href="${url}">View in the dashboard</a></p>`;
  return {
    subject: `[EmDash] audit pass: ${p.pluginName} ${p.version}`,
    html: htmlShell(body),
    text: `Audit passed for ${p.pluginName} ${p.version}

The automated code audit returned a clean pass. This version is live on the marketplace.

- Risk score: ${p.riskScore}/100

View in dashboard: ${p.dashboardUrl}${textFooter()}`,
  };
}

// ---------------------------------------------------------------------------
// renderRevokeVersion
// ---------------------------------------------------------------------------

export interface RevokeVersionParams {
  pluginName: string;
  version: string;
  reason: string;
  /** Admin's public note (D-16). `null` means don't include it in the body. */
  publicNote: string | null;
  dashboardUrl: string;
}

export function renderRevokeVersion(p: RevokeVersionParams): RenderedEmail {
  const name = escapeHtml(p.pluginName);
  const ver = escapeHtml(p.version);
  const reason = escapeHtml(p.reason);
  const url = escapeHtml(p.dashboardUrl);
  const hasNote = typeof p.publicNote === "string" && p.publicNote.length > 0;
  const noteHtml = hasNote
    ? `<p><strong>Admin note:</strong> ${escapeHtml(p.publicNote!)}</p>`
    : "";
  const noteText = hasNote ? `\n\nAdmin note: ${p.publicNote}` : "";

  const body = `<h1 style="font-size: 20px; margin: 0 0 16px;">Version ${ver} of ${name} revoked</h1>
<p>This version has been revoked. Downloads are no longer being served for it.</p>
<p><strong>Reason:</strong> ${reason}</p>
${noteHtml}
<p><a href="${url}">Open in dashboard</a></p>`;
  return {
    subject: `[EmDash] revoke version: ${p.pluginName} ${p.version}`,
    html: htmlShell(body),
    text: `Version ${p.version} of ${p.pluginName} revoked

This version has been revoked. Downloads are no longer being served.

Reason: ${p.reason}${noteText}

Open in dashboard: ${p.dashboardUrl}${textFooter()}`,
  };
}

// ---------------------------------------------------------------------------
// renderRevokePlugin
// ---------------------------------------------------------------------------

export interface RevokePluginParams {
  pluginName: string;
  reason: string;
  publicNote: string | null;
  dashboardUrl: string;
}

export function renderRevokePlugin(p: RevokePluginParams): RenderedEmail {
  const name = escapeHtml(p.pluginName);
  const reason = escapeHtml(p.reason);
  const url = escapeHtml(p.dashboardUrl);
  const hasNote = typeof p.publicNote === "string" && p.publicNote.length > 0;
  const noteHtml = hasNote
    ? `<p><strong>Admin note:</strong> ${escapeHtml(p.publicNote!)}</p>`
    : "";
  const noteText = hasNote ? `\n\nAdmin note: ${p.publicNote}` : "";

  const body = `<h1 style="font-size: 20px; margin: 0 0 16px;">${name} has been revoked</h1>
<p>This plugin has been revoked at the plugin level. Every version is no longer being served, and the listing has been tombstoned.</p>
<p><strong>Reason:</strong> ${reason}</p>
${noteHtml}
<p><a href="${url}">Open in dashboard</a></p>`;
  return {
    subject: `[EmDash] revoke plugin: ${p.pluginName}`,
    html: htmlShell(body),
    text: `${p.pluginName} has been revoked

This plugin has been revoked at the plugin level. Every version is no longer being served, and the listing has been tombstoned.

Reason: ${p.reason}${noteText}

Open in dashboard: ${p.dashboardUrl}${textFooter()}`,
  };
}

// ---------------------------------------------------------------------------
// renderReportFiled
//
// Reporter identity is DELIBERATELY not accepted as a parameter — D-18:
// publishers should not learn who reported them, only that a report exists.
// ---------------------------------------------------------------------------

export interface ReportFiledParams {
  entityType: "plugin" | "theme";
  entityName: string;
  category: string;
  /** First 200 chars of the report description. Caller enforces the trim. */
  descriptionExcerpt: string;
  dashboardUrl: string;
}

export function renderReportFiled(p: ReportFiledParams): RenderedEmail {
  const name = escapeHtml(p.entityName);
  const category = escapeHtml(p.category);
  const excerpt = escapeHtml(p.descriptionExcerpt);
  const url = escapeHtml(p.dashboardUrl);
  const entityLabel = p.entityType === "plugin" ? "plugin" : "theme";

  const body = `<h1 style="font-size: 20px; margin: 0 0 16px;">A report was filed against your ${entityLabel} ${name}</h1>
<p><strong>Category:</strong> ${category}</p>
<p><strong>Excerpt:</strong> ${excerpt}</p>
<p>The marketplace moderators will review the report and take any action required. You don't need to respond to this email.</p>
<p><a href="${url}">Open in dashboard</a></p>`;
  return {
    subject: `[EmDash] report filed: ${p.entityName}`,
    html: htmlShell(body),
    text: `A report was filed against your ${entityLabel} ${p.entityName}

Category: ${p.category}
Excerpt: ${p.descriptionExcerpt}

The marketplace moderators will review the report. You don't need to respond.

Open in dashboard: ${p.dashboardUrl}${textFooter()}`,
  };
}

// ---------------------------------------------------------------------------
// renderTestSend
// ---------------------------------------------------------------------------

export interface TestSendParams {
  dashboardUrl: string;
}

export function renderTestSend(p: TestSendParams): RenderedEmail {
  const url = escapeHtml(p.dashboardUrl);
  const body = `<h1 style="font-size: 20px; margin: 0 0 16px;">EmDash notifications test email</h1>
<p>This is a test email from EmDash marketplace notifications. Delivery is working.</p>
<p>If you received this, your address is configured correctly and you will start receiving publisher notifications as events occur.</p>
<p><a href="${url}">Back to settings</a></p>`;
  return {
    subject: "[EmDash] test send: notifications",
    html: htmlShell(body),
    text: `EmDash notifications test email

This is a test email from EmDash marketplace notifications. Delivery is working.

If you received this, your address is configured correctly.

Back to settings: ${p.dashboardUrl}${textFooter()}`,
  };
}

// ---------------------------------------------------------------------------
// renderDigest
// ---------------------------------------------------------------------------

export interface DigestEvent {
  eventType: string;
  entityName: string;
  summary: string;
  timestamp: string;
}

export interface DigestParams {
  events: DigestEvent[];
  dashboardUrl: string;
}

export function renderDigest(p: DigestParams): RenderedEmail {
  const url = escapeHtml(p.dashboardUrl);
  const count = p.events.length;

  const itemsHtml = p.events
    .map((e) => {
      const name = escapeHtml(e.entityName);
      const summary = escapeHtml(e.summary);
      const when = escapeHtml(e.timestamp);
      const type = escapeHtml(e.eventType);
      return `<li style="margin-bottom: 12px;"><strong>${type}</strong> — ${name}<br><span style="color: #555;">${summary}</span><br><span style="color: #999; font-size: 12px;">${when}</span></li>`;
    })
    .join("\n");

  const itemsText = p.events
    .map(
      (e) =>
        `- [${e.eventType}] ${e.entityName}: ${e.summary} (${e.timestamp})`,
    )
    .join("\n");

  const body = `<h1 style="font-size: 20px; margin: 0 0 16px;">Your daily EmDash digest (${count} events)</h1>
<p>The following events happened for items you own or maintain in the last 24 hours.</p>
<ul style="padding-left: 16px;">
${itemsHtml}
</ul>
<p><a href="${url}">Open the dashboard</a></p>`;
  return {
    subject: `[EmDash] digest: ${count} events`,
    html: htmlShell(body),
    text: `Your daily EmDash digest (${count} events)

The following events happened for items you own or maintain in the last 24 hours.

${itemsText}

Open the dashboard: ${p.dashboardUrl}${textFooter()}`,
  };
}
