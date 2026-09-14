import QRCode from 'qrcode';

/**
 * Inline SVG data URL for a QR code.
 *
 * SVG rather than PNG because a badge is printed: vector output stays sharp at
 * any printer resolution, and the data URL means the sheet pulls no external
 * asset — a printed page can never depend on a network fetch.
 *
 * Server-only (uses Buffer); `qrcode`'s `toString` is the typed path for SVG,
 * `toDataURL` only accepts raster types.
 */
export async function qrSvgDataUrl(text: string, width = 256): Promise<string> {
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, width });
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
