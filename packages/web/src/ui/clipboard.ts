/**
 * Copy, in both of the contexts this UI is actually opened in.
 *
 * `navigator.clipboard` exists only in a secure context, and the web client is
 * routinely reached over plain http at a LAN or tailnet address, where the API
 * is not denied but absent — the property itself is `undefined`, so reading it
 * throws before any permission is ever asked for. That is the common case on a
 * phone, which is the case this whole frontend exists for, so a copy that only
 * works on localhost is a copy that does not work.
 *
 * What is left there is `execCommand`, deprecated and still the only thing
 * every browser agrees on. It copies the document's selection rather than a
 * string, so the text is put on the page, selected, and taken away again; the
 * reader's own selection is put back after, since a copy button should not
 * silently eat what someone was in the middle of highlighting.
 *
 * A gesture is what authorises either path, and the fallback keeps it: the
 * clipboard call throws or rejects within the same click, so nothing here ever
 * runs a task later than the event that asked for it.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyBySelection(text);
  }
}

function copyBySelection(text: string): boolean {
  const selection = document.getSelection();
  if (selection === null) {
    return false;
  }
  // Off the page, not hidden: `display:none` and `visibility:hidden` cannot
  // hold a selection, which is the only thing there is to copy. A span with a
  // range beats a focused `<textarea>` because iOS Safari refuses to select
  // one of those on script's say-so. `pre` keeps newlines as newlines.
  const carrier = document.createElement("span");
  carrier.textContent = text;
  carrier.ariaHidden = "true";
  carrier.style.cssText =
    "position:fixed;top:0;left:0;opacity:0;pointer-events:none;white-space:pre;user-select:text";
  document.body.append(carrier);

  const previous =
    selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
  const range = document.createRange();
  range.selectNodeContents(carrier);
  selection.removeAllRanges();
  selection.addRange(range);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  selection.removeAllRanges();
  carrier.remove();
  if (previous !== undefined) {
    selection.addRange(previous);
  }
  return copied;
}
