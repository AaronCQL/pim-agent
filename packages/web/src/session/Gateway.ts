import { createContext } from "solid-js";

/**
 * Where the pictures a tool view names are fetched from. Empty is this origin,
 * which is how the served client reads them; a browser pointed at another
 * gateway resolves them against that one instead.
 */
export const GatewayOrigin = createContext<() => string>(() => "");
