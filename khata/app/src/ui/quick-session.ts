/** State of one "Quick entry" sitting (evening paper slips): sticky date, running count and totals. */
export const quick = {
  active: false,
  date: null as string | null,
  count: 0,
  gave: 0,
  got: 0,
};

export function startQuick(date: string | null): void {
  quick.active = true;
  quick.date = date;
  quick.count = 0;
  quick.gave = 0;
  quick.got = 0;
}

export function endQuick(): void {
  quick.active = false;
}
