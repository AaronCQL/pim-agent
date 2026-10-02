// Colour the sides individually: `border-indigo-400` would also paint the top.
export function Spinner() {
  return (
    <span
      class="size-3 shrink-0 animate-spin rounded-full border-1.5 border-x-indigo-400 border-b-indigo-400 border-t-transparent"
      aria-hidden="true"
    />
  );
}
