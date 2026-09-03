import "virtual:uno.css";
import "./styles.css";

// Interactivity for mockup preview
const sidebar = document.getElementById("sidebar");
const btnCollapse = document.getElementById("btn-collapse-sidebar");
const btnExpand = document.getElementById("btn-expand-sidebar");

btnCollapse?.addEventListener("click", () => {
  sidebar?.classList.toggle("hidden");
});
btnExpand?.addEventListener("click", () => {
  sidebar?.classList.toggle("hidden");
});
