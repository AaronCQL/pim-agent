import { createContext } from "solid-js";

/** Base URL for tool-view images; empty means this origin. */
export const GatewayOrigin = createContext<() => string>(() => "");
