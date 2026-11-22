import { useRef, useState } from "react";

/**
 * A list sorted by urgency moves under the cursor. While someone is pointing at it or
 * tabbing through it, the order they saw is kept; newcomers join at the end.
 */
export function useSteadyOrder<T>(items: T[], id: (item: T) => string) {
  const [held, setHeld] = useState(false);
  const inside = useRef({ pointer: false, focus: false });
  const order = useRef<string[]>([]);
  const update = () => setHeld(inside.current.pointer || inside.current.focus);

  let shown = items;
  if (held) {
    const rank = new Map(order.current.map((key, i) => [key, i]));
    shown = [...items].sort((a, b) => (rank.get(id(a)) ?? Infinity) - (rank.get(id(b)) ?? Infinity) || 0);
  } else {
    order.current = items.map(id);
  }
  const hold = {
    onPointerEnter: () => {
      inside.current.pointer = true;
      update();
    },
    onPointerLeave: () => {
      inside.current.pointer = false;
      update();
    },
    onFocus: (e: { target: EventTarget & Element }) => {
      // A mouse press also focuses; only the keyboard should hold the order after the pointer has gone.
      inside.current.focus = e.target.matches(":focus-visible");
      update();
    },
    onBlur: () => {
      inside.current.focus = false;
      update();
    },
  };
  return { shown, hold };
}
