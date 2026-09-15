'use client';

import { formatReasonLine, type ReasonV4, type ReasonV4Templates } from '../domain/reasons-v4';
import { reasonLabelOfV4, type TaxonomyCatalog, type UiLocale } from '../domain/picker';

/**
 * The two-line explanation of a v4 recommendation (design §B3):
 *
 *   Польза:   «Закрывает твою цель „войти в EU-рынок“ · она в retail в Испании»
 *   Развитие: «Можешь научиться: RAG-системы»
 *
 * A line renders only when it has at least one sentence — the design allows
 * either half to stand alone, and a label with nothing under it would read as a
 * missing feature rather than an honest "nothing to add".
 */
export function UsefulnessLines({
  useful,
  growth,
  templates,
  catalog,
  locale,
  labels,
  className,
  testId,
}: {
  useful: readonly ReasonV4[];
  growth: readonly ReasonV4[];
  templates: ReasonV4Templates;
  catalog: TaxonomyCatalog | null;
  locale: UiLocale;
  labels: { useful: string; growth: string };
  className?: string;
  testId?: string;
}) {
  if (!catalog) return null;
  const labelOf = reasonLabelOfV4(catalog, locale);
  const usefulLines = formatReasonLine(useful, templates, labelOf);
  const growthLines = formatReasonLine(growth, templates, labelOf);
  if (usefulLines.length === 0 && growthLines.length === 0) return null;

  return (
    <div className={className} data-testid={testId}>
      {usefulLines.length > 0 ? (
        <div className="flex flex-col gap-0.5" data-testid={testId ? `${testId}-useful` : undefined}>
          <span className="text-[10px] font-bold uppercase tracking-wide text-pine">{labels.useful}</span>
          <ul className="flex flex-col gap-0.5">
            {usefulLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {growthLines.length > 0 ? (
        <div className="mt-2 flex flex-col gap-0.5" data-testid={testId ? `${testId}-growth` : undefined}>
          <span className="text-[10px] font-bold uppercase tracking-wide text-muted">{labels.growth}</span>
          <ul className="flex flex-col gap-0.5">
            {growthLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
