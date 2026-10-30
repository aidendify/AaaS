// One place for the customer-facing product name. The final name is not decided yet:
// change DISPLAY_NAME / LEGAL_NAME here, then run `npm test` (brand.test.mjs lists the pages
// whose <title> must match). Internal ids, env vars and package names stay "AaaS"/"aidentify".
export const DISPLAY_NAME = 'AIdentify';
export const LEGAL_NAME = '[Legal entity name TBD]';
export const BRAND = Object.freeze({ displayName: DISPLAY_NAME, legalName: LEGAL_NAME, final: false });

// Replaces {{PRODUCT_NAME}} and {{LEGAL_NAME}} in static pages (privacy.html, terms.html).
export function applyBrandTokens(html) {
  return String(html).replaceAll('{{PRODUCT_NAME}}', DISPLAY_NAME).replaceAll('{{LEGAL_NAME}}', LEGAL_NAME);
}
