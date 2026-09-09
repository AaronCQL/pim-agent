import type { Element } from "solid-js";

import { createDialog } from "./dialog";

/** A left sheet over `<dialog>.showModal()`; a backdrop tap is a click on the dialog box itself. */
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

  return (
    <dialog
      ref={dialog.ref}
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
