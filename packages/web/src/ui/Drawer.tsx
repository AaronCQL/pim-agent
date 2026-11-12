import type { Element } from "solid-js";

import { createDialog } from "./dialog";
import { createSwipe } from "./swipe";

export function Drawer(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly label: string;
  readonly children: Element;
}) {
  const dialog = createDialog({
    open: () => props.open,
    onClose: () => {
      props.onClose();
    },
  });
  const swipe = createSwipe("left", dialog.close);

  return (
    <dialog
      ref={(element) => {
        dialog.ref(element);
        swipe(element);
      }}
      aria-label={props.label}
      onClose={dialog.onNativeClose}
      onClick={(event: MouseEvent) => {
        if (dialog.isHost(event.target)) {
          dialog.close();
        }
      }}
      class="m-0 h-full max-h-none w-[85vw] max-w-xs border-r border-neutral-700 bg-neutral-950 p-0 text-neutral-100 backdrop:bg-black/60"
    >
      {props.children}
    </dialog>
  );
}
