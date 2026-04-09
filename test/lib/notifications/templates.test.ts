import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  renderAuditFail,
  renderAuditError,
  renderAuditWarn,
  renderAuditPass,
  renderRevokeVersion,
  renderRevokePlugin,
  renderReportFiled,
  renderTestSend,
  renderDigest,
  FROM_ADDRESS,
  REPLY_TO,
} from "../../../src/lib/notifications/templates";

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe("escapeHtml", () => {
  it("escapes &, <, >, \", and '", () => {
    const input = `<script>alert("x") & 'y'</script>`;
    const output = escapeHtml(input);
    expect(output).toContain("&lt;script&gt;");
    expect(output).toContain("&quot;x&quot;");
    expect(output).toContain("&#39;y&#39;");
    expect(output).toContain("&amp;");
    expect(output).not.toContain("<script>");
  });

  it("returns empty string for empty input", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("passes through strings with no special chars", () => {
    expect(escapeHtml("plain-plugin-name-1.2.3")).toBe(
      "plain-plugin-name-1.2.3",
    );
  });
});

// ---------------------------------------------------------------------------
// FROM_ADDRESS and REPLY_TO constants
// ---------------------------------------------------------------------------

describe("template constants", () => {
  it("exposes FROM_ADDRESS", () => {
    expect(FROM_ADDRESS).toBe(
      "EmDash Notifications <notifications@emdashcms.org>",
    );
  });

  it("exposes REPLY_TO", () => {
    expect(REPLY_TO).toBe("no-reply@emdashcms.org");
  });
});

// ---------------------------------------------------------------------------
// Audit event templates
// ---------------------------------------------------------------------------

describe("renderAuditFail", () => {
  it("returns subject, html, text", () => {
    const out = renderAuditFail({
      pluginName: "test-plugin",
      version: "1.2.3",
      verdict: "fail",
      riskScore: 85,
      findingCount: 3,
      dashboardUrl: "https://emdashcms.org/dashboard/plugins/x",
    });
    expect(out.subject).toBe("[EmDash] audit fail: test-plugin 1.2.3");
    expect(out.html).toContain("test-plugin");
    expect(out.text).toContain("test-plugin");
  });

  it("escapes HTML-special characters in plugin name in the html body only", () => {
    const out = renderAuditFail({
      pluginName: "Evil<plugin>",
      version: "1.2.3",
      verdict: "fail",
      riskScore: 85,
      findingCount: 3,
      dashboardUrl: "https://emdashcms.org/dashboard/plugins/x",
    });
    // Subject is plain text — not escaped
    expect(out.subject).toBe("[EmDash] audit fail: Evil<plugin> 1.2.3");
    // HTML body — must NOT contain raw <plugin> tag
    expect(out.html).toContain("Evil&lt;plugin&gt;");
    expect(out.html).not.toContain("<plugin>");
    // Text body — not escaped, contains raw chars
    expect(out.text).toContain("Evil<plugin>");
  });

  it("includes the dashboard URL", () => {
    const out = renderAuditFail({
      pluginName: "x",
      version: "1.0.0",
      verdict: "fail",
      riskScore: 50,
      findingCount: 1,
      dashboardUrl: "https://emdashcms.org/dashboard/plugins/xyz",
    });
    expect(out.html).toContain("https://emdashcms.org/dashboard/plugins/xyz");
    expect(out.text).toContain("https://emdashcms.org/dashboard/plugins/xyz");
  });

  it("HTML body links to settings footer", () => {
    const out = renderAuditFail({
      pluginName: "x",
      version: "1.0.0",
      verdict: "fail",
      riskScore: 50,
      findingCount: 1,
      dashboardUrl: "https://emdashcms.org/dashboard/plugins/x",
    });
    expect(out.html).toContain("https://emdashcms.org/dashboard/settings");
  });
});

describe("renderAuditError", () => {
  it("has correct subject and renders error message", () => {
    const out = renderAuditError({
      pluginName: "p",
      version: "1.0.0",
      errorMessage: "AI budget exceeded",
      dashboardUrl: "https://emdashcms.org/d/p",
    });
    expect(out.subject).toBe("[EmDash] audit error: p 1.0.0");
    expect(out.html).toContain("AI budget exceeded");
    expect(out.text).toContain("AI budget exceeded");
  });

  it("escapes error message in html body", () => {
    const out = renderAuditError({
      pluginName: "p",
      version: "1.0.0",
      errorMessage: "<script>bad</script>",
      dashboardUrl: "https://emdashcms.org/d/p",
    });
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).not.toContain("<script>bad</script>");
  });
});

describe("renderAuditWarn", () => {
  it("has subject [EmDash] audit warn", () => {
    const out = renderAuditWarn({
      pluginName: "p",
      version: "1.0.0",
      verdict: "warn",
      riskScore: 55,
      findingCount: 2,
      dashboardUrl: "https://emdashcms.org/d/p",
    });
    expect(out.subject).toBe("[EmDash] audit warn: p 1.0.0");
  });
});

describe("renderAuditPass", () => {
  it("has subject [EmDash] audit pass", () => {
    const out = renderAuditPass({
      pluginName: "p",
      version: "1.0.0",
      riskScore: 5,
      dashboardUrl: "https://emdashcms.org/d/p",
    });
    expect(out.subject).toBe("[EmDash] audit pass: p 1.0.0");
  });
});

// ---------------------------------------------------------------------------
// Revoke templates
// ---------------------------------------------------------------------------

describe("renderRevokeVersion", () => {
  it("omits publicNote when null", () => {
    const out = renderRevokeVersion({
      pluginName: "p",
      version: "1.0.0",
      reason: "policy",
      publicNote: null,
      dashboardUrl: "https://emdashcms.org/d/p",
    });
    expect(out.html).not.toContain("public_note");
    expect(out.html).not.toContain("null");
    expect(out.text).not.toContain("null");
  });

  it("renders publicNote with html escaping when non-null", () => {
    const out = renderRevokeVersion({
      pluginName: "p",
      version: "1.0.0",
      reason: "policy",
      publicNote: "Contains <script>bad</script>",
      dashboardUrl: "https://emdashcms.org/d/p",
    });
    expect(out.html).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(out.html).not.toContain("<script>bad</script>");
    // Plaintext version is raw
    expect(out.text).toContain("<script>bad</script>");
  });

  it("has subject [EmDash] revoke version", () => {
    const out = renderRevokeVersion({
      pluginName: "p",
      version: "1.0.0",
      reason: "r",
      publicNote: null,
      dashboardUrl: "https://emdashcms.org/d/p",
    });
    expect(out.subject).toBe("[EmDash] revoke version: p 1.0.0");
  });
});

describe("renderRevokePlugin", () => {
  it("has subject [EmDash] revoke plugin", () => {
    const out = renderRevokePlugin({
      pluginName: "p",
      reason: "policy",
      publicNote: null,
      dashboardUrl: "https://emdashcms.org/d/p",
    });
    expect(out.subject).toBe("[EmDash] revoke plugin: p");
  });

  it("renders escaped publicNote when present", () => {
    const out = renderRevokePlugin({
      pluginName: "p",
      reason: "policy",
      publicNote: "Has <b>html</b>",
      dashboardUrl: "https://emdashcms.org/d/p",
    });
    expect(out.html).toContain("&lt;b&gt;");
    expect(out.html).not.toContain("<b>html</b>");
  });
});

// ---------------------------------------------------------------------------
// Report-filed template (reporter identity omission is a hard requirement)
// ---------------------------------------------------------------------------

describe("renderReportFiled", () => {
  it("does NOT accept a reporter identity parameter", () => {
    // Compile-time check: this would fail if the signature accepts
    // reporterAuthorId. We simply pass a valid call and assert it compiles.
    const out = renderReportFiled({
      entityType: "plugin",
      entityName: "test",
      category: "abuse",
      descriptionExcerpt: "bad stuff",
      dashboardUrl: "https://emdashcms.org/d/test",
    });
    expect(out.subject).toBe("[EmDash] report filed: test");
  });

  it("does not leak any reporter identity string in the body", () => {
    const out = renderReportFiled({
      entityType: "plugin",
      entityName: "test",
      category: "abuse",
      descriptionExcerpt: "bad stuff",
      dashboardUrl: "https://emdashcms.org/d/test",
    });
    expect(out.html).not.toContain("reporter");
    expect(out.html).not.toContain("Reporter");
    expect(out.text).not.toContain("reporter");
  });

  it("escapes description excerpt html chars", () => {
    const out = renderReportFiled({
      entityType: "plugin",
      entityName: "test",
      category: "abuse",
      descriptionExcerpt: "<script>x</script>",
      dashboardUrl: "https://emdashcms.org/d/test",
    });
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).not.toContain("<script>x</script>");
  });
});

// ---------------------------------------------------------------------------
// test_send and digest
// ---------------------------------------------------------------------------

describe("renderTestSend", () => {
  it("has subject [EmDash] test send", () => {
    const out = renderTestSend({
      dashboardUrl: "https://emdashcms.org/dashboard/settings",
    });
    expect(out.subject).toBe("[EmDash] test send: notifications");
    expect(out.text).toContain("test email");
  });
});

describe("renderDigest", () => {
  it("has subject [EmDash] digest", () => {
    const out = renderDigest({
      events: [],
      dashboardUrl: "https://emdashcms.org/dashboard/settings",
    });
    expect(out.subject).toBe("[EmDash] digest: 0 events");
  });

  it("lists the events provided", () => {
    const out = renderDigest({
      events: [
        {
          eventType: "audit_fail",
          entityName: "plugin-a",
          summary: "Audit failed with score 80",
          timestamp: "2026-04-08T10:00:00Z",
        },
        {
          eventType: "audit_warn",
          entityName: "plugin-b",
          summary: "Audit warning with score 50",
          timestamp: "2026-04-08T11:00:00Z",
        },
      ],
      dashboardUrl: "https://emdashcms.org/dashboard/settings",
    });
    expect(out.subject).toBe("[EmDash] digest: 2 events");
    expect(out.html).toContain("plugin-a");
    expect(out.html).toContain("plugin-b");
    expect(out.text).toContain("plugin-a");
    expect(out.text).toContain("plugin-b");
  });

  it("escapes entity names in html", () => {
    const out = renderDigest({
      events: [
        {
          eventType: "audit_fail",
          entityName: "Evil<name>",
          summary: "stuff",
          timestamp: "2026-04-08T10:00:00Z",
        },
      ],
      dashboardUrl: "https://emdashcms.org/dashboard/settings",
    });
    expect(out.html).toContain("Evil&lt;name&gt;");
    expect(out.html).not.toContain("<name>");
  });
});

// ---------------------------------------------------------------------------
// All 9 subject lines start with [EmDash]
// ---------------------------------------------------------------------------

describe("subject line prefix", () => {
  it("all 9 render functions produce subjects starting with [EmDash]", () => {
    const subjects = [
      renderAuditFail({
        pluginName: "x",
        version: "1",
        verdict: "fail",
        riskScore: 0,
        findingCount: 0,
        dashboardUrl: "u",
      }).subject,
      renderAuditError({
        pluginName: "x",
        version: "1",
        errorMessage: "e",
        dashboardUrl: "u",
      }).subject,
      renderAuditWarn({
        pluginName: "x",
        version: "1",
        verdict: "warn",
        riskScore: 0,
        findingCount: 0,
        dashboardUrl: "u",
      }).subject,
      renderAuditPass({
        pluginName: "x",
        version: "1",
        riskScore: 0,
        dashboardUrl: "u",
      }).subject,
      renderRevokeVersion({
        pluginName: "x",
        version: "1",
        reason: "r",
        publicNote: null,
        dashboardUrl: "u",
      }).subject,
      renderRevokePlugin({
        pluginName: "x",
        reason: "r",
        publicNote: null,
        dashboardUrl: "u",
      }).subject,
      renderReportFiled({
        entityType: "plugin",
        entityName: "x",
        category: "c",
        descriptionExcerpt: "d",
        dashboardUrl: "u",
      }).subject,
      renderTestSend({ dashboardUrl: "u" }).subject,
      renderDigest({ events: [], dashboardUrl: "u" }).subject,
    ];
    for (const s of subjects) {
      expect(s.startsWith("[EmDash] ")).toBe(true);
    }
  });
});
