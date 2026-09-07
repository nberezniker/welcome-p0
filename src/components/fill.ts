/** Client-side {var} interpolation — mirrors interpolate() in src/i18n.
 * Used because server components cannot pass function props to client
 * components; they pass template strings instead. */
export function fill(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const v = vars[key];
    return v === undefined ? match : String(v);
  });
}
