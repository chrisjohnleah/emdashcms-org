-- seeds/dev.sql
-- Development seed data for the EmDash Community Marketplace
-- Apply: npm run db:seed
-- WARNING: Deletes all existing data before inserting

DELETE FROM installs;
DELETE FROM plugin_audits;
DELETE FROM plugin_versions;
DELETE FROM plugins;
DELETE FROM themes;
DELETE FROM authors;

-- Authors
INSERT INTO authors (id, github_id, github_username, avatar_url, verified, created_at, updated_at)
VALUES
  ('author-1', 1001, 'alice-dev', 'https://avatars.githubusercontent.com/u/1001', 1, '2026-01-10T08:00:00Z', '2026-03-20T12:00:00Z'),
  ('author-2', 1002, 'bob-plugins', 'https://avatars.githubusercontent.com/u/1002', 0, '2026-01-20T09:00:00Z', '2026-03-15T10:00:00Z'),
  ('author-3', 1003, 'carol-themes', 'https://avatars.githubusercontent.com/u/1003', 1, '2026-02-01T10:00:00Z', '2026-03-25T14:00:00Z');

-- Plugins
INSERT INTO plugins (id, author_id, name, description, category, capabilities, keywords, repository_url, homepage_url, icon_key, license, installs_count, created_at, updated_at)
VALUES
  ('seo-toolkit', 'author-1', 'SEO Toolkit', 'Comprehensive SEO tools for EmDash sites including meta tags, sitemaps, and structured data.', 'content', '["content:write","admin:panels"]', '["seo","meta","sitemap","structured-data"]', 'https://github.com/alice-dev/seo-toolkit', 'https://seo-toolkit.example.com', 'plugins/seo-toolkit/icon.png', 'MIT', 1200, '2026-01-15T10:00:00Z', '2026-03-20T12:00:00Z'),
  ('analytics-pro', 'author-1', 'Analytics Pro', 'Privacy-first analytics dashboard with real-time visitor tracking.', 'analytics', '["admin:panels","storage:read"]', '["analytics","privacy","dashboard"]', 'https://github.com/alice-dev/analytics-pro', NULL, 'plugins/analytics-pro/icon.png', 'MIT', 500, '2026-01-20T14:00:00Z', '2026-03-18T09:00:00Z'),
  ('form-builder', 'author-2', 'Form Builder', 'Drag-and-drop form builder with validation and submission handling.', 'content', '["content:write","storage:write","routes:register"]', '["forms","builder","validation"]', 'https://github.com/bob-plugins/form-builder', NULL, NULL, 'Apache-2.0', 150, '2026-02-01T11:00:00Z', '2026-03-10T16:00:00Z'),
  ('social-share', 'author-2', 'Social Share', 'Add social sharing buttons to any page with customizable appearance.', 'social', '["content:write"]', '["social","sharing","buttons"]', 'https://github.com/bob-plugins/social-share', NULL, NULL, NULL, 10, '2026-02-15T09:00:00Z', '2026-03-05T11:00:00Z'),
  ('security-headers', 'author-3', 'Security Headers', 'Automatically inject security headers into all responses.', 'security', '["routes:register"]', '["security","headers","csp"]', 'https://github.com/carol-themes/security-headers', NULL, NULL, 'MIT', 0, '2026-03-01T08:00:00Z', '2026-03-25T14:00:00Z'),
  ('image-optimizer', 'author-3', 'Image Optimizer', 'Automatic image compression and format conversion for uploaded media.', 'content', '["content:write","storage:write"]', '["images","optimization","compression"]', 'https://github.com/carol-themes/image-optimizer', 'https://img-opt.example.com', 'plugins/image-optimizer/icon.png', 'MIT', 75, '2026-02-20T13:00:00Z', '2026-03-22T10:00:00Z');

-- Plugin versions
-- seo-toolkit: 3 versions (v1.0.0 published, v1.1.0 published, v2.0.0-beta pending)
INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, file_count, compressed_size, decompressed_size, min_emdash_version, checksum, changelog, readme, published_at, created_at, updated_at)
VALUES
  ('pv-seo-1', 'seo-toolkit', '1.0.0', 'published', 'bundles/seo-toolkit/1.0.0.tar.gz',
   '{"id":"seo-toolkit","version":"1.0.0","capabilities":["content:write","admin:panels"],"allowedHosts":[],"storage":null,"hooks":["onPageRender"],"routes":[],"admin":{"panels":["seo-panel"]}}',
   12, 45000, 120000, '1.0.0', 'sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
   'Initial release with meta tag management and sitemap generation.',
   '# SEO Toolkit\n\nComprehensive SEO tools for EmDash.',
   '2026-01-15T12:00:00Z', '2026-01-15T10:00:00Z', '2026-01-15T12:00:00Z'),

  ('pv-seo-2', 'seo-toolkit', '1.1.0', 'published', 'bundles/seo-toolkit/1.1.0.tar.gz',
   '{"id":"seo-toolkit","version":"1.1.0","capabilities":["content:write","admin:panels"],"allowedHosts":[],"storage":null,"hooks":["onPageRender"],"routes":[],"admin":{"panels":["seo-panel"]}}',
   14, 48000, 130000, '1.0.0', 'sha256:b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
   'Added structured data support and Open Graph tags.',
   '# SEO Toolkit\n\nComprehensive SEO tools for EmDash.\n\n## v1.1.0\n- Structured data\n- Open Graph tags',
   '2026-02-10T14:00:00Z', '2026-02-10T12:00:00Z', '2026-02-10T14:00:00Z'),

  ('pv-seo-3', 'seo-toolkit', '2.0.0-beta', 'pending', 'bundles/seo-toolkit/2.0.0-beta.tar.gz',
   '{"id":"seo-toolkit","version":"2.0.0-beta","capabilities":["content:write","admin:panels","storage:read"],"allowedHosts":[],"storage":{"analytics":{"type":"json"}},"hooks":["onPageRender","onBuild"],"routes":[],"admin":{"panels":["seo-panel","seo-analytics"]}}',
   18, 62000, 180000, '1.1.0', 'sha256:c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
   'Beta: SEO analytics dashboard and automated audits.',
   '# SEO Toolkit\n\n## v2.0.0-beta\n- Analytics dashboard\n- Automated SEO audits',
   NULL, '2026-03-20T10:00:00Z', '2026-03-20T10:00:00Z');

-- analytics-pro: 2 versions (v1.0.0 published, v1.0.1 flagged)
INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, file_count, compressed_size, decompressed_size, min_emdash_version, checksum, changelog, readme, published_at, created_at, updated_at)
VALUES
  ('pv-analytics-1', 'analytics-pro', '1.0.0', 'published', 'bundles/analytics-pro/1.0.0.tar.gz',
   '{"id":"analytics-pro","version":"1.0.0","capabilities":["admin:panels","storage:read"],"allowedHosts":[],"storage":{"visits":{"type":"json"}},"hooks":[],"routes":[],"admin":{"panels":["analytics-dashboard"]}}',
   8, 32000, 85000, '1.0.0', 'sha256:d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5',
   'Initial release with visitor tracking and dashboard.',
   '# Analytics Pro\n\nPrivacy-first analytics for EmDash.',
   '2026-01-25T16:00:00Z', '2026-01-25T14:00:00Z', '2026-01-25T16:00:00Z'),

  ('pv-analytics-2', 'analytics-pro', '1.0.1', 'flagged', 'bundles/analytics-pro/1.0.1.tar.gz',
   '{"id":"analytics-pro","version":"1.0.1","capabilities":["admin:panels","storage:read"],"allowedHosts":["analytics.example.com"],"storage":{"visits":{"type":"json"}},"hooks":[],"routes":[],"admin":{"panels":["analytics-dashboard"]}}',
   9, 33000, 87000, '1.0.0', 'sha256:e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
   'Patch: fixed data retention policy compliance.',
   '# Analytics Pro\n\n## v1.0.1\n- Fixed data retention',
   '2026-03-18T10:00:00Z', '2026-03-18T08:00:00Z', '2026-03-18T10:00:00Z');

-- form-builder: 2 versions (v1.0.0 published, v1.1.0 published)
INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, file_count, compressed_size, decompressed_size, min_emdash_version, checksum, changelog, readme, published_at, created_at, updated_at)
VALUES
  ('pv-form-1', 'form-builder', '1.0.0', 'published', 'bundles/form-builder/1.0.0.tar.gz',
   '{"id":"form-builder","version":"1.0.0","capabilities":["content:write","storage:write","routes:register"],"allowedHosts":[],"storage":{"submissions":{"type":"json"}},"hooks":[],"routes":["/api/forms"],"admin":null}',
   10, 38000, 95000, '1.0.0', 'sha256:f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1',
   'Initial release with drag-and-drop form builder.',
   '# Form Builder\n\nDrag-and-drop forms for EmDash.',
   '2026-02-05T10:00:00Z', '2026-02-05T08:00:00Z', '2026-02-05T10:00:00Z'),

  ('pv-form-2', 'form-builder', '1.1.0', 'published', 'bundles/form-builder/1.1.0.tar.gz',
   '{"id":"form-builder","version":"1.1.0","capabilities":["content:write","storage:write","routes:register"],"allowedHosts":[],"storage":{"submissions":{"type":"json"}},"hooks":[],"routes":["/api/forms","/api/forms/submit"],"admin":null}',
   13, 42000, 110000, '1.0.0', 'sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
   'Added email notifications and file upload fields.',
   '# Form Builder\n\n## v1.1.0\n- Email notifications\n- File upload fields',
   '2026-03-10T16:00:00Z', '2026-03-10T14:00:00Z', '2026-03-10T16:00:00Z');

-- social-share: 2 versions (v0.9.0 rejected, v1.0.0 published)
INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, file_count, compressed_size, decompressed_size, min_emdash_version, checksum, changelog, readme, published_at, created_at, updated_at)
VALUES
  ('pv-social-1', 'social-share', '0.9.0', 'rejected', 'bundles/social-share/0.9.0.tar.gz',
   '{"id":"social-share","version":"0.9.0","capabilities":["content:write"],"allowedHosts":["*.facebook.com","*.twitter.com"],"storage":null,"hooks":[],"routes":[],"admin":null}',
   5, 15000, 40000, NULL, 'sha256:b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
   'Pre-release with social integrations.',
   '# Social Share\n\nSocial sharing buttons for EmDash.',
   NULL, '2026-02-15T09:00:00Z', '2026-02-15T09:00:00Z'),

  ('pv-social-2', 'social-share', '1.0.0', 'published', 'bundles/social-share/1.0.0.tar.gz',
   '{"id":"social-share","version":"1.0.0","capabilities":["content:write"],"allowedHosts":[],"storage":null,"hooks":["onPageRender"],"routes":[],"admin":null}',
   6, 18000, 45000, '1.0.0', 'sha256:c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
   'Stable release without external host dependencies.',
   '# Social Share\n\n## v1.0.0\n- Removed external host dependencies\n- Added Open Graph support',
   '2026-03-05T12:00:00Z', '2026-03-05T10:00:00Z', '2026-03-05T12:00:00Z');

-- security-headers: 1 version (v0.1.0 pending) - edge case: no published version
INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, file_count, compressed_size, decompressed_size, min_emdash_version, checksum, changelog, readme, published_at, created_at, updated_at)
VALUES
  ('pv-security-1', 'security-headers', '0.1.0', 'pending', 'bundles/security-headers/0.1.0.tar.gz',
   '{"id":"security-headers","version":"0.1.0","capabilities":["routes:register"],"allowedHosts":[],"storage":null,"hooks":[],"routes":["/*"],"admin":null}',
   4, 12000, 30000, '1.0.0', 'sha256:d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5',
   'Initial submission with CSP, HSTS, and X-Frame-Options.',
   '# Security Headers\n\nAutomatic security headers for EmDash.',
   NULL, '2026-03-25T14:00:00Z', '2026-03-25T14:00:00Z');

-- image-optimizer: 2 versions (v1.0.0 published, v1.1.0 published)
INSERT INTO plugin_versions (id, plugin_id, version, status, bundle_key, manifest, file_count, compressed_size, decompressed_size, min_emdash_version, checksum, changelog, readme, published_at, created_at, updated_at)
VALUES
  ('pv-image-1', 'image-optimizer', '1.0.0', 'published', 'bundles/image-optimizer/1.0.0.tar.gz',
   '{"id":"image-optimizer","version":"1.0.0","capabilities":["content:write","storage:write"],"allowedHosts":[],"storage":{"cache":{"type":"json"}},"hooks":["onMediaUpload"],"routes":[],"admin":null}',
   7, 28000, 70000, '1.0.0', 'sha256:e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
   'Initial release with WebP and AVIF conversion.',
   '# Image Optimizer\n\nAutomatic image optimization for EmDash.',
   '2026-02-25T10:00:00Z', '2026-02-25T08:00:00Z', '2026-02-25T10:00:00Z'),

  ('pv-image-2', 'image-optimizer', '1.1.0', 'published', 'bundles/image-optimizer/1.1.0.tar.gz',
   '{"id":"image-optimizer","version":"1.1.0","capabilities":["content:write","storage:write"],"allowedHosts":[],"storage":{"cache":{"type":"json"}},"hooks":["onMediaUpload"],"routes":[],"admin":null}',
   9, 31000, 78000, '1.0.0', 'sha256:f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1',
   'Added responsive image generation and lazy loading.',
   '# Image Optimizer\n\n## v1.1.0\n- Responsive image generation\n- Lazy loading support',
   '2026-03-22T11:00:00Z', '2026-03-22T09:00:00Z', '2026-03-22T11:00:00Z');

-- Plugin audits (for published and flagged versions)
-- seo-toolkit v1.0.0: pass
INSERT INTO plugin_audits (id, plugin_version_id, status, model, prompt_tokens, completion_tokens, neurons_used, raw_response, issues, verdict, risk_score, findings, created_at)
VALUES ('audit-seo-1', 'pv-seo-1', 'completed', '@cf/qwen/qwq-32b', 3200, 800, 450, NULL, '[]', 'pass', 5,
  '[{"severity":"info","title":"Standard DOM manipulation","description":"Plugin uses standard content:write capability for meta tag injection.","category":"permissions","location":"src/index.ts:15"}]',
  '2026-01-15T11:00:00Z');

-- seo-toolkit v1.1.0: pass
INSERT INTO plugin_audits (id, plugin_version_id, status, model, prompt_tokens, completion_tokens, neurons_used, raw_response, issues, verdict, risk_score, findings, created_at)
VALUES ('audit-seo-2', 'pv-seo-2', 'completed', '@cf/qwen/qwq-32b', 3400, 850, 470, NULL, '[]', 'pass', 8,
  '[{"severity":"info","title":"JSON-LD injection","description":"Structured data injection uses safe JSON serialization.","category":"data-handling","location":"src/structured-data.ts:42"},{"severity":"low","title":"Large DOM queries","description":"querySelectorAll on page load may impact performance on large pages.","category":"performance","location":"src/meta-tags.ts:28"}]',
  '2026-02-10T13:00:00Z');

-- analytics-pro v1.0.0: pass
INSERT INTO plugin_audits (id, plugin_version_id, status, model, prompt_tokens, completion_tokens, neurons_used, raw_response, issues, verdict, risk_score, findings, created_at)
VALUES ('audit-analytics-1', 'pv-analytics-1', 'completed', '@cf/qwen/qwq-32b', 2800, 700, 400, NULL, '[]', 'pass', 12,
  '[{"severity":"low","title":"Local storage usage","description":"Stores visitor fingerprint in localStorage for session tracking.","category":"privacy","location":"src/tracker.ts:55"},{"severity":"info","title":"No external requests","description":"All data stays within EmDash storage API.","category":"network","location":null}]',
  '2026-01-25T15:00:00Z');

-- analytics-pro v1.0.1: warn (flagged version)
INSERT INTO plugin_audits (id, plugin_version_id, status, model, prompt_tokens, completion_tokens, neurons_used, raw_response, issues, verdict, risk_score, findings, created_at)
VALUES ('audit-analytics-2', 'pv-analytics-2', 'completed', '@cf/qwen/qwq-32b', 3000, 750, 420, NULL, '[]', 'warn', 38,
  '[{"severity":"medium","title":"External host communication","description":"Plugin declares allowedHosts including analytics.example.com. Data may be exfiltrated.","category":"network","location":"manifest.json:allowedHosts"},{"severity":"high","title":"Unvalidated external endpoint","description":"fetch() call to external analytics endpoint without certificate pinning.","category":"security","location":"src/sync.ts:12"},{"severity":"low","title":"Data retention unclear","description":"No clear data deletion mechanism for stored visitor data.","category":"privacy","location":"src/storage.ts:30"}]',
  '2026-03-18T09:00:00Z');

-- form-builder v1.0.0: pass
INSERT INTO plugin_audits (id, plugin_version_id, status, model, prompt_tokens, completion_tokens, neurons_used, raw_response, issues, verdict, risk_score, findings, created_at)
VALUES ('audit-form-1', 'pv-form-1', 'completed', '@cf/qwen/qwq-32b', 3100, 780, 440, NULL, '[]', 'pass', 10,
  '[{"severity":"low","title":"Route registration","description":"Registers /api/forms endpoint for form submissions.","category":"permissions","location":"src/routes.ts:5"},{"severity":"info","title":"Input sanitization present","description":"HTML input is sanitized before storage.","category":"security","location":"src/sanitize.ts:18"}]',
  '2026-02-05T09:00:00Z');

-- form-builder v1.1.0: pass
INSERT INTO plugin_audits (id, plugin_version_id, status, model, prompt_tokens, completion_tokens, neurons_used, raw_response, issues, verdict, risk_score, findings, created_at)
VALUES ('audit-form-2', 'pv-form-2', 'completed', '@cf/qwen/qwq-32b', 3300, 820, 460, NULL, '[]', 'pass', 15,
  '[{"severity":"low","title":"File upload handling","description":"Accepts file uploads via multipart form data. Files stored in EmDash storage.","category":"data-handling","location":"src/upload.ts:22"},{"severity":"info","title":"Email integration","description":"Uses EmDash notification API for email delivery, no direct SMTP.","category":"network","location":"src/notify.ts:8"}]',
  '2026-03-10T15:00:00Z');

-- social-share v0.9.0: fail (rejected version)
INSERT INTO plugin_audits (id, plugin_version_id, status, model, prompt_tokens, completion_tokens, neurons_used, raw_response, issues, verdict, risk_score, findings, created_at)
VALUES ('audit-social-1', 'pv-social-1', 'completed', '@cf/qwen/qwq-32b', 2500, 650, 380, NULL, '[]', 'fail', 72,
  '[{"severity":"critical","title":"Unrestricted external hosts","description":"Declares wildcard allowedHosts for facebook.com and twitter.com subdomains. Could be used for data exfiltration.","category":"security","location":"manifest.json:allowedHosts"},{"severity":"high","title":"DOM content extraction","description":"Reads full page content before sharing, potential data leak to external services.","category":"privacy","location":"src/share.ts:34"}]',
  '2026-02-15T10:00:00Z');

-- social-share v1.0.0: pass
INSERT INTO plugin_audits (id, plugin_version_id, status, model, prompt_tokens, completion_tokens, neurons_used, raw_response, issues, verdict, risk_score, findings, created_at)
VALUES ('audit-social-2', 'pv-social-2', 'completed', '@cf/qwen/qwq-32b', 2600, 680, 390, NULL, '[]', 'pass', 3,
  '[{"severity":"info","title":"No external hosts","description":"Sharing uses native Web Share API and client-side URL construction only.","category":"network","location":"src/share.ts:10"}]',
  '2026-03-05T11:00:00Z');

-- image-optimizer v1.0.0: pass
INSERT INTO plugin_audits (id, plugin_version_id, status, model, prompt_tokens, completion_tokens, neurons_used, raw_response, issues, verdict, risk_score, findings, created_at)
VALUES ('audit-image-1', 'pv-image-1', 'completed', '@cf/qwen/qwq-32b', 2900, 720, 410, NULL, '[]', 'pass', 8,
  '[{"severity":"info","title":"Media hook usage","description":"Listens to onMediaUpload hook for automatic processing.","category":"permissions","location":"src/index.ts:5"},{"severity":"low","title":"CPU-intensive operation","description":"Image conversion may be CPU-intensive for large files.","category":"performance","location":"src/convert.ts:45"}]',
  '2026-02-25T09:00:00Z');

-- image-optimizer v1.1.0: pass
INSERT INTO plugin_audits (id, plugin_version_id, status, model, prompt_tokens, completion_tokens, neurons_used, raw_response, issues, verdict, risk_score, findings, created_at)
VALUES ('audit-image-2', 'pv-image-2', 'completed', '@cf/qwen/qwq-32b', 3100, 760, 430, NULL, '[]', 'pass', 10,
  '[{"severity":"low","title":"Multiple output formats","description":"Generates WebP, AVIF, and responsive variants which increases storage usage.","category":"resource-usage","location":"src/responsive.ts:20"},{"severity":"info","title":"Lazy loading injection","description":"Adds loading=lazy attribute to img tags via content:write.","category":"permissions","location":"src/lazy.ts:8"}]',
  '2026-03-22T10:00:00Z');

-- Themes
INSERT INTO themes (id, author_id, name, description, keywords, repository_url, demo_url, thumbnail_key, npm_package, preview_url, homepage_url, license, created_at, updated_at)
VALUES
  ('minimal-blog', 'author-3', 'Minimal Blog', 'A clean, fast blog theme with excellent typography and reading experience.', '["blog","minimal"]', 'https://github.com/carol-themes/minimal-blog', NULL, 'themes/minimal-blog/thumbnail.png', '@emdash-themes/minimal-blog', NULL, NULL, 'MIT', '2026-02-01T10:00:00Z', '2026-03-20T08:00:00Z'),
  ('portfolio-starter', 'author-1', 'Portfolio Starter', 'Showcase your work with a beautiful portfolio layout and project galleries.', '["portfolio","creative"]', 'https://github.com/alice-dev/portfolio-starter', 'https://portfolio-demo.example.com', NULL, '@emdash-themes/portfolio-starter', NULL, 'https://portfolio-starter.example.com', 'MIT', '2026-02-10T12:00:00Z', '2026-03-15T14:00:00Z'),
  ('docs-theme', 'author-2', 'Docs Theme', 'Technical documentation theme with sidebar navigation and code highlighting.', '["documentation","technical"]', 'https://github.com/bob-plugins/docs-theme', NULL, NULL, NULL, NULL, NULL, 'Apache-2.0', '2026-02-20T09:00:00Z', '2026-03-10T11:00:00Z'),
  ('ecommerce-starter', 'author-1', 'E-Commerce Starter', 'A full-featured e-commerce theme with product listings and cart functionality.', '["ecommerce","shop"]', 'https://github.com/alice-dev/ecommerce-starter', NULL, 'themes/ecommerce-starter/thumbnail.png', '@emdash-themes/ecommerce-starter', 'https://ecommerce-preview.example.com', 'https://ecommerce-starter.example.com', 'MIT', '2026-03-01T14:00:00Z', '2026-03-25T16:00:00Z'),
  ('dark-mode', 'author-3', 'Dark Mode', 'A modern dark theme with smooth transitions and excellent contrast ratios.', '["dark","modern"]', 'https://github.com/carol-themes/dark-mode', NULL, NULL, NULL, NULL, NULL, NULL, '2026-03-10T08:00:00Z', '2026-03-28T12:00:00Z');
