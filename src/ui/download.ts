/**
 * Saves text as a file from an extension page through a Blob URL and a
 * temporary <a download> link — no `downloads` permission needed.
 */
export function downloadText(fileName: string, text: string, type: 'text/markdown' | 'application/json'): void {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking right away can cancel the download in some browsers; give it a moment.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
