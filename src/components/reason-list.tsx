'use client';

import { formatReasons, type Reason, type ReasonAudience, type ReasonTemplates } from '../domain/reasons';
import { reasonLabelOf, type TaxonomyCatalog, type UiLocale } from '../domain/picker';

/**
 * Renders structural reasons (code + catalogue ids) as sentences in the viewer's
 * language. This is the ONLY reason renderer in the app: the API never returns
 * sentences, so reasons_for_me and reasons_for_them render through different
 * templates and cannot come out identical.
 */
export function ReasonList({
  reasons,
  audience,
  templates,
  catalog,
  locale,
  className,
  testId,
}: {
  reasons: readonly Reason[];
  audience: ReasonAudience;
  templates: ReasonTemplates;
  catalog: TaxonomyCatalog | null;
  locale: UiLocale;
  className?: string;
  testId?: string;
}) {
  if (reasons.length === 0 || !catalog) return null;
  const lines = formatReasons(reasons, audience, templates, reasonLabelOf(catalog, locale));
  if (lines.length === 0) return null;
  return (
    <ul className={className} data-testid={testId}>
      {lines.map((line) => (
        <li key={line} className="flex gap-1.5">
          <span aria-hidden="true">·</span>
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}
