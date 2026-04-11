# Audit model benchmark fixtures

These are **test fixtures** for `scripts/audit-benchmark.ts`. They are
intentionally-adversarial plugin sources designed to exercise the audit
pipeline against known malicious patterns. They are NOT functional
plugins and cannot be installed on an EmDash marketplace.

Each fixture is a minimal two-file plugin (`manifest.json` + `backend.js`)
that contains one specific threat pattern. The benchmark script packs
each source directory into a `.tgz`, submits it through the same
extraction + prompt-building code path that ships to production, and
measures whether the AI audit model correctly identifies the threat.

## Fixture list

| Fixture | Expected verdict | Threat class |
|---|---|---|
| `eval-attack` | **fail** | RCE via `eval(userInput)` in template expression runner |
| `exfiltration` | **fail** | Data exfiltration — mirrors analytics events to an undeclared host using global `fetch` bypass, ships plugin config + KV snapshot |
| `proto-pollution` | **fail** | Prototype pollution via recursive `deepMerge(defaults, userInput)` — user-controlled `__proto__` in JSON body |
| `obfuscated` | **fail** | JavaScript obfuscator output — `_0x` identifiers, `\x` hex-encoded string arrays, XOR-decoded C2 beacon URL |
| `credential-leak` | **fail** | "Error reporter" that dumps the full `ctx.kv.list` snapshot (API tokens, subscriber lists, configs) to a declared host on every error |
| `capability-overreach` | **fail** | "Word counter" that declares `capabilities: []` but calls global `fetch()` to an undeclared `wordcount-cloud.vercel.app` host |
| `cryptominer` | **fail** | Cryptojacking disguised as "image processing" — infinite `setInterval` hash-prefix loop with `Math.imul` mixing, submits shares to `pool.cryptomine-relay.net` |
| `rce-function-constructor` | **fail** | RCE via `new Function("post", userExpression)` — same attack as `eval` but using the Function constructor |
| `dynamic-import-rce` | **fail** | RCE via `import(url)` where `url` is built from user-controlled KV state — fetches and executes remote modules |
| `clean-seo-plugin` | **pass** | Legitimate SEO meta-tag plugin — no network, no user-input execution, validates inputs |
| `clean-api-client` | **pass** | Legitimate newsletter-sync plugin — declares `network:fetch`, validates email format, uses typed API client + bearer token auth to declared host |

A third clean fixture — `serpdelta-0.2.4.tgz` — is fetched from R2 by
the bench runner at setup time. It's a real plugin from the marketplace
and isn't checked in here because the tarball is 9.3 KB and can be
pulled fresh any time.

## Running the benchmark

```
export CLOUDFLARE_ACCOUNT_ID="..."
export CLOUDFLARE_API_TOKEN="..."

# Pack every source directory into bench-fixtures/*.tgz
cd bench-fixtures/sources && for d in */; do
  name="${d%/}"
  (cd "$d" && tar czf "../../${name}.tgz" manifest.json backend.js)
done && cd ../..

# Run the full benchmark against every enabled model in AUDIT_MODELS
npm run bench -- bench-fixtures/*.tgz

# Or test a single model
npm run bench -- bench-fixtures/*.tgz --only glm-4.7-flash
```

Results are written to `bench-results/<timestamp>.json` with full raw
model responses so parse failures and hallucinations are easy to
triage. The latest production default (`DEFAULT_AUDIT_MODEL` in
`src/lib/audit/prompt.ts`) should be the model that wins this benchmark
on true-positive rate, false-positive rate, latency, reliability, and
cost — in that priority order.

## Adding new fixtures

When adding a new threat class, create a directory with:

1. `manifest.json` — realistic metadata for a plausible plugin
2. `backend.js` — the threat pattern, written to look like legitimate
   code (no "// this is malicious" comments — the model should catch
   it on the pattern alone)

Then update the table above and re-run the benchmark. A new fixture
that nobody catches is a signal to tighten `SYSTEM_PROMPT` in
`src/lib/audit/prompt.ts`.

## Why these are committed to a public repo

These are defensive test fixtures, analogous to the adversarial
examples shipped by Semgrep, ESLint's `eslint-plugin-security`, GitHub's
CodeQL test suites, and similar static analysis projects. They serve
the same purpose: they let us verify our security tooling catches real
threats before attackers do. They are not executable plugins — the
EmDash CMS cannot install or run them in any form.
