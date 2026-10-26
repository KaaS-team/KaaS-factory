// The task's risk as one small badge: the level, with the reasons as its tooltip, so a reviewer
// sees why a change is held without opening it. Null risk (not rated yet) shows nothing.
export function riskBadge(h, risk) {
  if (!risk) return null;
  const why = risk.reasons.length ? risk.reasons.join("; ") : `rated ${risk.level}`;
  return h("span", { class: `risk-badge risk-${risk.level}`, title: why }, `${risk.level} risk`);
}
