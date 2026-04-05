document.getElementById('repo_select')?.addEventListener('change', function (this: HTMLSelectElement) {
  const selected = this.options[this.selectedIndex];
  const repoIdInput = document.getElementById('repo_id') as HTMLInputElement | null;
  if (repoIdInput) {
    repoIdInput.value = selected.getAttribute('data-repo-id') || '';
  }
});
