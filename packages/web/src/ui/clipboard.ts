/** Copy text, falling back to a selection copy where `navigator.clipboard` is absent (plain http). */
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
  // Off the page, not hidden: `display:none`/`visibility:hidden` cannot hold a selection, and iOS Safari refuses to select a scripted `<textarea>`.
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
