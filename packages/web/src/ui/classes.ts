export const ICON =
  "flex size-8 shrink-0 items-center justify-center rounded-lg text-neutral-350 hover:bg-neutral-850 hover:text-neutral-50";

const FIELD_PAINT = "bg-neutral-850 ring-1 ring-transparent";

/** `FIELD` without the box size. */
export const FIELD_SKIN = `${FIELD_PAINT} outline-none focus:ring-neutral-600`;

export const FIELD = `h-8 min-w-0 flex-1 rounded-lg px-3 text-sm ${FIELD_SKIN}`;

/** A field wrapping an input plus icons; rings when anything inside has focus. */
export const FIELD_BOX = `flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 text-sm ${FIELD_PAINT} focus-within:ring-neutral-600`;

/** The input inside a `FIELD_BOX`. */
export const FIELD_BARE =
  "min-w-0 flex-1 bg-transparent outline-none placeholder:text-neutral-500";

export const ACTION =
  "h-8 shrink-0 rounded-lg bg-indigo-500 px-3 text-sm font-semibold text-white hover:bg-indigo-400 disabled:bg-neutral-850 disabled:text-neutral-500";

export const QUIET =
  "h-8 shrink-0 rounded-lg bg-neutral-850 px-3 text-sm text-neutral-350 hover:bg-neutral-800 hover:text-neutral-50 disabled:text-neutral-500 disabled:hover:bg-neutral-850";

const CHIP =
  "flex h-8 max-w-max min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-neutral-850 px-2 text-sm text-neutral-350";

export const CHIP_BUTTON = `${CHIP} hover:bg-neutral-800 hover:text-neutral-50`;

export const CHIP_GROUP =
  "flex h-8 max-w-max min-w-0 items-center rounded-lg bg-neutral-850 text-sm text-neutral-350";

/** The caller rounds the end segments. */
export const CHIP_SEGMENT =
  "flex h-8 min-w-0 items-center gap-1.5 px-2 hover:bg-neutral-800 hover:text-neutral-50";

export const PILL =
  "flex items-center justify-center gap-1.5 rounded-full bg-neutral-900 text-neutral-350 ring-neutral-600 hover:text-neutral-100 hover:ring-1";

/** The active list row, whether reached by pointer or keyboard. */
export const ROW_ACTIVE = "bg-neutral-800";
