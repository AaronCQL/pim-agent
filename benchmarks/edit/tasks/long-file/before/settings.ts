// Application settings. Grouped by subsystem.

export const APP_NAME = "atlas";
export const APP_VERSION = "2.4.1";
export const APP_ENV = "production";

// --- HTTP server ---
export const SERVER_HOST = "0.0.0.0";
export const SERVER_PORT = 8443;
export const SERVER_BACKLOG = 511;
export const KEEP_ALIVE_MS = 5000;
export const REQUEST_TIMEOUT_MS = 15000;

// --- Cache ---
export const CACHE_ENABLED = true;
export const CACHE_TTL_SECONDS = 300;
export const CACHE_MAX_ENTRIES = 10000;
export const CACHE_EVICTION = "lru";

// --- Logging ---
export const LOG_LEVEL = "info";
export const LOG_FORMAT = "json";
export const LOG_SAMPLING = 0.1;
export const LOG_DESTINATION = "stdout";

// --- Database ---
export const DB_POOL_MIN = 2;
export const DB_POOL_MAX = 16;
export const DB_IDLE_MS = 10000;
export const DB_STATEMENT_TIMEOUT_MS = 30000;

// --- Feature flags ---
export const FLAG_NEW_ONBOARDING = false;
export const FLAG_BETA_SEARCH = true;
export const FLAG_DARK_MODE = true;
export const FLAG_EXPORT_V2 = false;

// --- Rate limiting ---
export const RATE_WINDOW_MS = 60000;
export const RATE_MAX_REQUESTS = 120;
export const RATE_BURST = 20;
