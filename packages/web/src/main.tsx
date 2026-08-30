import { render } from "@solidjs/web";
import "virtual:uno.css";

import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("missing #root");
}
render(() => <App />, root);
