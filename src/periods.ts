// Period shorthand resolver. Mirrors the frontend Accounting view's preset
// list at splits-teams/app/accounting/period-utils.ts:32-94.
//
// Resolution happens in the user's local timezone (via native Date math)
// and the result is serialized to ISO 8601 UTC for the API. ISO-week start
// (Monday) matches the frontend's moment().isoWeek() usage.

export const PERIODS = [
  "thisWeek",
  "thisMonth",
  "thisYear",
  "lastWeek",
  "lastMonth",
  "lastYear",
  "last30Days",
  "last90Days",
  "last6Months",
] as const;

export type Period = (typeof PERIODS)[number];

const startOfDay = (d: Date): Date => {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
};

const startOfIsoWeek = (d: Date): Date => {
  // getDay: 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  // ISO week starts on Monday.
  const day = d.getDay();
  const offsetToMonday = day === 0 ? -6 : 1 - day;
  const r = startOfDay(d);
  r.setDate(r.getDate() + offsetToMonday);
  return r;
};

const startOfMonth = (d: Date): Date =>
  new Date(d.getFullYear(), d.getMonth(), 1);

const startOfYear = (d: Date): Date => new Date(d.getFullYear(), 0, 1);

const subDays = (d: Date, n: number): Date => {
  const r = new Date(d);
  r.setDate(r.getDate() - n);
  return r;
};

const subMonths = (d: Date, n: number): Date => {
  const r = new Date(d);
  r.setMonth(r.getMonth() - n);
  return r;
};

const subYears = (d: Date, n: number): Date => {
  const r = new Date(d);
  r.setFullYear(r.getFullYear() - n);
  return r;
};

export function resolvePeriod(
  period: Period,
  now: Date = new Date(),
): { startDate?: string; endDate?: string } {
  switch (period) {
    case "thisWeek":
      return { startDate: startOfIsoWeek(now).toISOString() };
    case "thisMonth":
      return { startDate: startOfMonth(now).toISOString() };
    case "thisYear":
      return { startDate: startOfYear(now).toISOString() };
    case "lastWeek": {
      const thisWeekStart = startOfIsoWeek(now);
      const lastWeekStart = startOfIsoWeek(subDays(thisWeekStart, 1));
      return {
        startDate: lastWeekStart.toISOString(),
        endDate: thisWeekStart.toISOString(),
      };
    }
    case "lastMonth": {
      const thisMonthStart = startOfMonth(now);
      const lastMonthStart = startOfMonth(subMonths(thisMonthStart, 1));
      return {
        startDate: lastMonthStart.toISOString(),
        endDate: thisMonthStart.toISOString(),
      };
    }
    case "lastYear": {
      const thisYearStart = startOfYear(now);
      const lastYearStart = startOfYear(subYears(thisYearStart, 1));
      return {
        startDate: lastYearStart.toISOString(),
        endDate: thisYearStart.toISOString(),
      };
    }
    case "last30Days":
      return { startDate: subDays(startOfDay(now), 30).toISOString() };
    case "last90Days":
      return { startDate: subDays(startOfDay(now), 90).toISOString() };
    case "last6Months":
      return { startDate: subMonths(startOfDay(now), 6).toISOString() };
  }
}
