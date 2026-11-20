export const monthOf = date => date.slice(0, 7);

export function monthSpan(month, first, last) {
  const beginning = month + "-01";
  const end = new Date(beginning + "T00:00:00Z");
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  const endDay = end.getUTCDate();
  const from = month === monthOf(first) ? Number(first.slice(-2)) : 1;
  const to = month === monthOf(last) ? Number(last.slice(-2)) : endDay;
  const weekday = new Date(month + "-" + String(from).padStart(2, "0") + "T00:00:00Z").getUTCDay();
  return { from, to, leading: (weekday + 6) % 7, partial: from > 1 || to < endDay };
}

export function monthlyCounts({ first, last, dates }, year = null) {
  if (year !== null) {
    const prefix = String(year).padStart(4, "0");
    if (first < prefix + "-01-01") first = prefix + "-01-01";
    if (last > prefix + "-12-31") last = prefix + "-12-31";
  }
  const counts = new Map();
  const cursor = new Date(monthOf(first) + "-01T00:00:00Z");
  const end = new Date(last + "T00:00:00Z");
  while (cursor <= end) {
    counts.set(monthOf(cursor.toISOString()), 0);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  for (const date of dates) {
    const key = monthOf(date);
    if (counts.has(key)) counts.set(key, counts.get(key) + 1);
  }
  return counts;
}
