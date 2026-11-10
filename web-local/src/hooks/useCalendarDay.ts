import { useEffect, useState } from "react";

function calendarDay(now = new Date()): string {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

/**
 * Today's local date, changing at midnight (and when the window returns
 * after sleep), for views memoised on their data that print "Today" or
 * "Yesterday".
 */
export function useCalendarDay(): string {
  const [day, setDay] = useState(() => calendarDay());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => { setDay(calendarDay()); };
    const schedule = () => {
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(() => { check(); schedule(); }, Math.max(1_000, midnight.getTime() - now.getTime() + 1_000));
    };
    schedule();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return day;
}
