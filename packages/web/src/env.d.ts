declare module "virtual:uno.css";
declare module "*.css";

interface ImportMetaEnv {
  /** Overrides the gateway URL; only needed when the client is not served by it. */
  readonly VITE_PIM_SERVER?: string;
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
