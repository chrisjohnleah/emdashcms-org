-- Admin rejection notes can now be made publicly visible on the plugin
-- detail page. Defaults to 0 (PRIVATE) so existing admin-action audit
-- records stay hidden until explicitly marked public. New admin reject
-- and revoke actions default the checkbox to on (public=1) because
-- transparency is the policy, but the admin can uncheck it for notes
-- that reference private context (e.g. an out-of-band conversation).

ALTER TABLE plugin_audits ADD COLUMN public_note INTEGER NOT NULL DEFAULT 0;
