import assert from "node:assert/strict";
import test from "node:test";
import { monthlyCounts, monthSpan } from "../public/months.js";

test("跨年逐月汇总，区分两个十一月，保留零课时并反映补记与撤销", () => {
  const calendar = {
    first: "2026-11-01", last: "2027-11-30",
    dates: ["2026-11-01", "2026-11-30", "2026-12-31", "2027-01-01", "2027-11-30"]
  };
  const counts = monthlyCounts(calendar);
  assert.deepEqual([...counts.keys()], [
    "2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05",
    "2027-06", "2027-07", "2027-08", "2027-09", "2027-10", "2027-11"
  ]);
  assert.deepEqual([...counts.values()], [2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  calendar.dates.push("2027-02-28");
  assert.equal(monthlyCounts(calendar).get("2027-02"), 1);
  calendar.dates.pop();
  assert.equal(monthlyCounts(calendar).get("2027-02"), 0);
  assert.deepEqual([...monthlyCounts({ ...calendar, dates: [] }).values()], Array(13).fill(0));
});

test("只展示周期内的日期，按实际首日对齐星期", () => {
  assert.deepEqual(monthSpan("2028-02", "2028-02-18", "2028-03-06"), { from: 18, to: 29, leading: 4, partial: true });
  assert.deepEqual(monthSpan("2028-03", "2028-02-18", "2028-03-06"), { from: 1, to: 6, leading: 2, partial: true });
  assert.deepEqual(monthSpan("2027-12", "2027-12-31", "2027-12-31"), { from: 31, to: 31, leading: 4, partial: true });
});
