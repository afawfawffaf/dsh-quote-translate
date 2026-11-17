/**
 * Browser-only bundle: the plugin contributes no Host rows.
 *
 * The DSH desktop deployment resolves its own packages from inside `app.asar`,
 * which an installed workspace bundle cannot import, so no Host half exists.
 */
export function apply() {}
