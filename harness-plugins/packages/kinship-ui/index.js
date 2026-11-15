/**
 * Host half of the Kinship Web panel row.
 *
 * The browser module (`./client.js`) owns the page and the sidebar row; this
 * Host entry exists only so the Client module graph has a Loader row for it.
 * Keeping it separate from `kinship-bridge` is deliberate: saving bridge
 * configuration reloads that row, and a browser module bound to it would
 * unmount the panel while its own save was still settling.
 */

/** No host behavior: the panel talks to `kinship-bridge` over its JSON API. */
export function apply() {}
