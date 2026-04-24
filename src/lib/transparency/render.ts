import type { TransparencyWeekRow } from "./transparency-queries";

/**
 * Pure render function for the transparency report aggregate tables.
 *
 * Reads only numeric counters + ISO timestamps from the row — never
 * any entity strings. The TRNS-05 anonymization test asserts that this
 * output contains zero IDENTIFYING_TOKENS even when the underlying
 * entity tables are seeded with identifying values.
 *
 * Plan 2's `/transparency/index.astro` and `/transparency/[iso_week].astro`
 * consume this via `set:html={renderTransparencyHtml(row)}` inside the
 * BaseLayout chrome.
 */
export function renderTransparencyHtml(row: TransparencyWeekRow): string {
  const weekOf = row.iso_week;
  return `
    <section class="space-y-3">
      <h2 class="font-display text-2xl text-ink" style="font-weight: 500;">Submissions</h2>
      <table class="w-full text-left text-sm">
        <caption class="sr-only">Submissions for the week of ${weekOf}</caption>
        <tbody>
          <tr class="border-b border-rule">
            <th scope="row" class="py-2 text-ink-soft font-normal">Versions submitted</th>
            <td class="py-2 text-ink font-mono tabular-nums text-right">${row.versions_submitted}</td>
          </tr>
        </tbody>
      </table>
    </section>
    <section class="space-y-3">
      <h2 class="font-display text-2xl text-ink" style="font-weight: 500;">Audit outcomes</h2>
      <table class="w-full text-left text-sm">
        <caption class="sr-only">Audit outcomes for the week of ${weekOf}</caption>
        <tbody>
          <tr class="border-b border-rule">
            <th scope="row" class="py-2 text-ink-soft font-normal">Versions published</th>
            <td class="py-2 text-ink font-mono tabular-nums text-right">${row.versions_published}</td>
          </tr>
          <tr class="border-b border-rule">
            <th scope="row" class="py-2 text-ink-soft font-normal">Versions flagged</th>
            <td class="py-2 text-ink font-mono tabular-nums text-right">${row.versions_flagged}</td>
          </tr>
          <tr class="border-b border-rule">
            <th scope="row" class="py-2 text-ink-soft font-normal">Versions rejected</th>
            <td class="py-2 text-ink font-mono tabular-nums text-right">${row.versions_rejected}</td>
          </tr>
          <tr class="border-b border-rule">
            <th scope="row" class="py-2 text-ink-soft font-normal">Versions revoked</th>
            <td class="py-2 text-ink font-mono tabular-nums text-right">${row.versions_revoked}</td>
          </tr>
        </tbody>
      </table>
    </section>
    <section class="space-y-3">
      <h2 class="font-display text-2xl text-ink" style="font-weight: 500;">Reports</h2>
      <table class="w-full text-left text-sm">
        <caption class="sr-only">Reports filed and resolved for the week of ${weekOf}</caption>
        <tbody>
          <tr class="border-b border-rule">
            <th scope="row" class="py-2 text-ink-soft font-normal">Security</th>
            <td class="py-2 text-ink font-mono tabular-nums text-right">${row.reports_filed_security}</td>
          </tr>
          <tr class="border-b border-rule">
            <th scope="row" class="py-2 text-ink-soft font-normal">Abuse</th>
            <td class="py-2 text-ink font-mono tabular-nums text-right">${row.reports_filed_abuse}</td>
          </tr>
          <tr class="border-b border-rule">
            <th scope="row" class="py-2 text-ink-soft font-normal">Broken</th>
            <td class="py-2 text-ink font-mono tabular-nums text-right">${row.reports_filed_broken}</td>
          </tr>
          <tr class="border-b border-rule">
            <th scope="row" class="py-2 text-ink-soft font-normal">License</th>
            <td class="py-2 text-ink font-mono tabular-nums text-right">${row.reports_filed_license}</td>
          </tr>
          <tr class="border-b border-rule">
            <th scope="row" class="py-2 text-ink-soft font-normal">Other</th>
            <td class="py-2 text-ink font-mono tabular-nums text-right">${row.reports_filed_other}</td>
          </tr>
          <tr class="border-b border-rule">
            <th scope="row" class="py-2 text-ink-soft font-normal">Resolved</th>
            <td class="py-2 text-ink font-mono tabular-nums text-right">${row.reports_resolved}</td>
          </tr>
          <tr class="border-b border-rule">
            <th scope="row" class="py-2 text-ink-soft font-normal">Dismissed</th>
            <td class="py-2 text-ink font-mono tabular-nums text-right">${row.reports_dismissed}</td>
          </tr>
        </tbody>
      </table>
    </section>
    <section class="space-y-3">
      <h2 class="font-display text-2xl text-ink" style="font-weight: 500;">AI cost</h2>
      <table class="w-full text-left text-sm">
        <caption class="sr-only">AI cost for the week of ${weekOf}</caption>
        <tbody>
          <tr class="border-b border-rule">
            <th scope="row" class="py-2 text-ink-soft font-normal">Neurons spent</th>
            <td class="py-2 text-ink font-mono tabular-nums text-right">${row.neurons_spent}</td>
          </tr>
        </tbody>
      </table>
    </section>
  `;
}
