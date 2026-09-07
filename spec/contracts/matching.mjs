/** Reference pure core. Production eligibility MUST be verified server-side.
 * No LLM, external calls, inferred sensitive attributes, or private contact fields.
 */
export function normalTags(value) {
  if (!Array.isArray(value)) throw new TypeError('Tags must be an array');
  return [...new Set(value.map(x => {
    if (typeof x !== 'string' || x.length > 80) throw new TypeError('Invalid tag');
    return x.trim().toLowerCase();
  }).filter(Boolean))];
}
export function scorePair(a, b) {
  if (!a || !b || typeof a.id !== 'string' || typeof b.id !== 'string') throw new TypeError('Profile IDs required');
  if (a.id === b.id) return null;
  if (a.eligible !== true || b.eligible !== true || a.blocked === true || b.blocked === true) return null;
  const an = normalTags(a.needs), ao = normalTags(a.offers), bn = normalTags(b.needs), bo = normalTags(b.offers);
  const reasonsForA = an.filter(t => bo.includes(t));
  const reasonsForB = bn.filter(t => ao.includes(t));
  const dAB = reasonsForA.length / Math.max(1, an.length);
  const dBA = reasonsForB.length / Math.max(1, bn.length);
  if (!dAB || !dBA) return null;
  return Object.freeze({
    score: Math.round(100 * (0.6 * Math.min(dAB, dBA) + 0.4 * (dAB + dBA) / 2)),
    reasonsForA, reasonsForB,
    algorithm: 'welcome_mutual_tags_v1',
    // Relevance does not assert actual interest or acceptance by either side.
    mutualConsent: false
  });
}
export function recommend(me, candidates, limit = 3) {
  if (!Array.isArray(candidates) || !Number.isInteger(limit) || limit < 0 || limit > 3) throw new TypeError('Limit must be 0..3');
  const seen = new Set();
  return candidates.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; })
    .map(c => ({ id: c.id, pending: Math.max(0, Number(c.pending) || 0), match: scorePair(me, c) }))
    .filter(x => x.match)
    .sort((a,b) => b.match.score-a.match.score || a.pending-b.pending || (a.id < b.id ? -1 : a.id>b.id ? 1 : 0))
    .slice(0,limit);
}
export function canRevealPrivate(intro, currentPolicy) {
  return intro?.state === 'mutually_accepted' && intro.aAccepted === true && intro.bAccepted === true
    && intro.revoked !== true && currentPolicy?.allowed === true
    && intro.consentVersion === currentPolicy.consentVersion;
}
export function escapeVCard(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}
