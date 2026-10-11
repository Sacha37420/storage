import { defineConfig } from 'vitest/config';

// Tests unitaires de la logique pure (src/app/**/logic/*.spec.ts) : aucun
// composant Angular, aucun navigateur. Les tests de gestes en navigateur réel
// vivent dans e2e/ et sont joués par le runner du lab, pas par vitest.
export default defineConfig({
  test: { include: ['src/**/*.spec.ts'], environment: 'node' },
});
