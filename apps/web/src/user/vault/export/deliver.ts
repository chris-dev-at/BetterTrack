/**
 * Browser delivery for client-generated artifacts (PD7). Everything here works
 * on in-memory bytes only: a transient object URL for downloads and a
 * transient hidden frame for print — no artifact ever touches persistent
 * browser storage or leaves the device.
 */

/**
 * How long a download's object URL stays alive before it is revoked. The
 * download navigation the click queues runs in a LATER task, so revoking in the
 * same task can cancel the download outright (historically Firefox/Safari — and
 * Safari is the iOS-first target). This is the paranoid user's only way to get
 * a tax CSV or a cleartext archive off the device, so the URL outlives the
 * click by a wide margin and is then released.
 */
const OBJECT_URL_TTL_MS = 60_000;

/**
 * How long the transient print frame lives. Measured from the `load` event so
 * the print dialog outlives it comfortably — and, if `load` never fires,
 * from creation, so a frame holding cleartext report HTML is never left behind.
 */
const PRINT_FRAME_TTL_MS = 60_000;

/** Hand one client-generated artifact to the browser as a file download. */
export function deliverClientDownload(
  content: BlobPart,
  mediaType: string,
  filename: string,
): void {
  const url = URL.createObjectURL(new Blob([content], { type: mediaType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_TTL_MS);
  }
}

/** Open the browser print dialog over one client-generated HTML document. */
export function printClientDocument(html: string): void {
  const frame = document.createElement('iframe');
  // Off-screen rather than `display: none` — a non-displayed frame renders
  // blank in some browsers, which would print an empty tax report.
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  frame.setAttribute('aria-hidden', 'true');
  frame.srcdoc = html;
  // Deliberately NOT sandboxed: `createPrintableTaxReport` escapes every
  // interpolation, so the document carries no injection path, while a sandbox
  // would put this print — the paranoid account's only route to a PDF — behind
  // per-browser `allow-modals`/`allow-same-origin` quirks on a path no unit
  // test can exercise. Escaping at the source is the guarantee here.
  //
  // Removal is armed at creation, not inside the `load` listener: a frame whose
  // `load` never fires would otherwise hold cleartext report HTML in the DOM
  // forever. Once loaded, the timer restarts so the dialog gets its full window.
  let removal = globalThis.setTimeout(() => frame.remove(), PRINT_FRAME_TTL_MS);
  frame.addEventListener('load', () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      // No print surface (e.g. jsdom) — the scheduled removal still runs.
    }
    globalThis.clearTimeout(removal);
    removal = globalThis.setTimeout(() => frame.remove(), PRINT_FRAME_TTL_MS);
  });
  document.body.append(frame);
}
