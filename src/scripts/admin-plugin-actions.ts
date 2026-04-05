document.querySelectorAll('[data-retry-audit]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const el = btn as HTMLButtonElement;
    const pluginId = el.dataset.pluginId;
    const version = el.dataset.version;
    if (!pluginId || !version) return;

    if (!confirm(`Re-audit ${pluginId}@${version}? This will re-queue the AI audit.`))
      return;

    el.disabled = true;
    el.textContent = 'Queuing...';

    const res = await fetch(
      `/api/v1/admin/plugins/${pluginId}/retry-audit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      },
    );

    if (res.ok) {
      window.location.reload();
    } else {
      const body = (await res
        .json()
        .catch(() => ({ error: 'Unknown error' }))) as { error: string };
      alert(`Failed: ${body.error}`);
      el.disabled = false;
      el.textContent = 'Re-audit';
    }
  });
});

document.querySelectorAll('[data-admin-action]').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLFormElement;
    const action = el.dataset.adminAction;
    const pluginId = el.dataset.pluginId;
    if (!pluginId) return;

    if (
      action === 'delete' &&
      !confirm(`Permanently delete "${pluginId}"? This cannot be undone.`)
    )
      return;
    if (
      action === 'revoke' &&
      !confirm(
        `Revoke "${pluginId}"? It will be hidden from public listings.`,
      )
    )
      return;

    const url =
      action === 'delete'
        ? `/api/v1/admin/plugins/${pluginId}`
        : `/api/v1/admin/plugins/${pluginId}/${action}`;

    const method = action === 'delete' ? 'DELETE' : 'POST';

    const res = await fetch(url, { method });
    if (res.ok) {
      window.location.reload();
    } else {
      const body = (await res
        .json()
        .catch(() => ({ error: 'Unknown error' }))) as { error: string };
      alert(`Failed: ${body.error}`);
    }
  });
});
