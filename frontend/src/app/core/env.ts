/**
 * Configuration injectée au démarrage du conteneur (`assets/env.js`, écrit par
 * `nginx-entrypoint.sh`).
 */
export interface LabEnv {
  keycloakUrl?: string;
  keycloakRealm?: string;
  keycloakClientId?: string;
  appUrl?: string;
  apiUrl?: string;
  maxUploadBytes?: number;
}

export function labEnv(): LabEnv {
  return (window as unknown as { __env?: LabEnv }).__env ?? {};
}

/** Base de l'API de storage (`…/storage-api`), sans barre finale. */
export function apiUrl(): string {
  return (labEnv().apiUrl ?? 'http://localhost:8093').replace(/\/+$/, '');
}

/**
 * Les SEULES adresses auxquelles le jeton de l'utilisateur est joint
 * (`auth.interceptor.ts`, `token-scope.ts`) : l'API de storage. Le navigateur
 * n'appelle aucune autre API du lab.
 */
export function tokenBases(): string[] {
  return [apiUrl()];
}
