/// <reference types="vite/client" />

// NOTE: these VITE_* vars are a LOCAL-DEV fallback only (see runtime-config.ts).
// Production config is delivered at runtime via /config.json written by
// `cdk deploy`; the deployed bundle does NOT depend on any VITE_* value.
interface ImportMetaEnv {
  /** Base URL of the deployed API Gateway stage, e.g. https://…/prod. */
  readonly VITE_API_BASE?: string;
  /**
   * Cognito OIDC issuer (authority), e.g.
   * https://cognito-idp.<region>.amazonaws.com/<userPoolId>.
   */
  readonly VITE_COGNITO_AUTHORITY?: string;
  /** Cognito app client id (public SPA client — no client secret). */
  readonly VITE_COGNITO_CLIENT_ID?: string;
  /**
   * Cognito hosted UI domain, e.g. https://<prefix>.auth.<region>.amazoncognito.com.
   * Used for the RP-initiated logout endpoint.
   */
  readonly VITE_COGNITO_DOMAIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
