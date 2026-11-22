// The warnings of the safe values (src/core/safe-view.ts): a sign that opens each source's value in a popover. Without
// this script the sign still opens its list on a click, a tap, Enter or Space (`popovertarget`), in the middle of the
// window. This places the list beside its sign, keeps it inside the window while the page scrolls, and opens it when a
// mouse rests on the sign. One set of handlers for the whole page, rows drawn later included.

const GAP = 6;
const EDGE = 12;
const HOVER_OPEN_MS = 120;
const HOVER_CLOSE_MS = 220;

/** The open list and its sign, and whether a mouse opened it (a click then keeps it open instead of closing it). */
let current: { sign: HTMLButtonElement; tip: HTMLElement; byHover: boolean } | null = null;
let timer: number | undefined;
/** A press on the sign of an open list: the browser closes the list on the press, so the click must not open it again. */
let pressedOpen: HTMLButtonElement | null = null;

const tipOf = (sign: HTMLButtonElement): HTMLElement | null => {
  const id = sign.getAttribute("popovertarget");
  return id ? document.getElementById(id) : null;
};

/** Under the sign, its left edge near the sign's; above it where there is no room below; always inside the window. */
function place(sign: HTMLElement, tip: HTMLElement): void {
  tip.classList.add("placed");
  const at = sign.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const left = Math.max(EDGE, Math.min(at.left - 10, window.innerWidth - width - EDGE));
  const below = at.bottom + GAP;
  const top = below + height > window.innerHeight - EDGE && at.top - GAP - height >= EDGE ? at.top - GAP - height : below;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(Math.max(EDGE, top))}px`;
}

function show(sign: HTMLButtonElement, byHover: boolean): void {
  const tip = tipOf(sign);
  if (!tip || !("showPopover" in tip)) return;
  if (!tip.matches(":popover-open")) {
    // With its sign as the source where the browser knows it: a press on the sign then does not count as a press outside.
    try {
      (tip.showPopover as (options?: { source?: HTMLElement }) => void)({ source: sign });
    } catch {
      tip.showPopover();
    }
  }
  current = { sign, tip, byHover };
  sign.setAttribute("aria-expanded", "true");
  place(sign, tip);
}

function hide(): void {
  if (current?.tip.matches(":popover-open")) current.tip.hidePopover();
}

document.addEventListener(
  "pointerdown",
  (event) => {
    const sign = (event.target as Element | null)?.closest<HTMLButtonElement>("button.warn-sign");
    pressedOpen = sign && current?.sign === sign && !current.byHover ? sign : null;
  },
  true,
);

document.addEventListener("click", (event) => {
  const sign = (event.target as Element | null)?.closest<HTMLButtonElement>("button.warn-sign");
  if (!sign) return;
  const tip = tipOf(sign);
  if (!tip || !("showPopover" in tip)) return;
  // The script opens and places it itself, so that the list is never drawn in the middle of the window first.
  event.preventDefault();
  clearTimeout(timer);
  const wasOpen = pressedOpen === sign || (tip.matches(":popover-open") && !(current?.tip === tip && current.byHover));
  pressedOpen = null;
  if (wasOpen) hide();
  else show(sign, false);
});

document.addEventListener(
  "toggle",
  (event) => {
    const tip = event.target as HTMLElement;
    if (!tip.classList?.contains("warn-tip") || (event as ToggleEvent).newState !== "closed") return;
    document.querySelector(`button.warn-sign[popovertarget="${CSS.escape(tip.id)}"]`)?.setAttribute("aria-expanded", "false");
    if (current?.tip === tip) current = null;
  },
  true,
);

// A mouse resting on the sign opens the list; leaving both the sign and the list closes it, unless a click kept it open.
document.addEventListener("pointerover", (event) => {
  if (event.pointerType !== "mouse") return;
  const target = event.target as Element;
  const sign = target.closest<HTMLButtonElement>("button.warn-sign");
  if (current?.byHover && (target.closest(".warn-tip") === current.tip || sign === current.sign)) {
    clearTimeout(timer);
    return;
  }
  if (!sign) return;
  clearTimeout(timer);
  timer = window.setTimeout(() => show(sign, current?.sign === sign ? current.byHover : true), HOVER_OPEN_MS);
});
document.addEventListener("pointerout", (event) => {
  if (event.pointerType !== "mouse") return;
  const target = event.target as Element;
  if (!target.closest("button.warn-sign, .warn-tip")) return;
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    if (current?.byHover && !current.sign.matches(":hover") && !current.tip.matches(":hover")) hide();
  }, HOVER_CLOSE_MS);
});

// The list follows its sign while the page or a table scrolls, and stays inside the window when it changes size.
const follow = (): void => {
  if (current && current.tip.matches(":popover-open")) place(current.sign, current.tip);
};
document.addEventListener("scroll", follow, { capture: true, passive: true });
window.addEventListener("resize", follow, { passive: true });

export {};
