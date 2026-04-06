-- Build provenance for webhook-sourced versions.
-- release_url is the GitHub Release page URL (html_url), captured so the
-- public plugin detail can link directly to the release notes.
-- commit_sha is populated when the release payload carries one directly;
-- GitHub's release.target_commitish is usually a branch name, not a SHA,
-- so this column is often NULL and that's expected.

ALTER TABLE plugin_versions ADD COLUMN release_url TEXT;
ALTER TABLE plugin_versions ADD COLUMN commit_sha TEXT;
