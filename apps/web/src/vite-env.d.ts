/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Git commit the web bundle was built from — baked in at build time by the
   * Docker build (the `VITE_BUILD_SHA` build arg). `undefined` in dev/test,
   * where the admin-login footer falls back to `"unknown"`.
   */
  readonly VITE_BUILD_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
