/**
 * Browser delivery for client-generated artifacts (PD7). Everything here works
 * on in-memory bytes only: a transient object URL for downloads and a
 * transient hidden frame for print — no artifact ever touches persistent
 * browser storage or leaves the device.
 */

/** Hand one client-generated artifact to the browser as a file download. */
export function deliverClientDownload(
  content: BlobPart,
  mediaType: string,
  filename: string,
): void {
  const url = URL.createObjectURL(new Blob([content], { type: mediaType }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Open the browser print dialog over one client-generated HTML document. */
export function printClientDocument(html: string): void {
  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  frame.setAttribute('aria-hidden', 'true');
  frame.srcdoc = html;
  frame.addEventListener('load', () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      // No print surface (e.g. jsdom) — fall through to the removal below.
    }
    globalThis.setTimeout(() => frame.remove(), 60_000);
  });
  document.body.append(frame);
}
