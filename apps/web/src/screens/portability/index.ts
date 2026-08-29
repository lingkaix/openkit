/**
 * Portability — user-scoped import plus selected-Workspace export and vault rebind.
 *
 * Live Tier-A projection through existing Core Client methods. Vault reads reuse
 * the Settings `useVault` owner. Host paths, runtime handles, and password Vault
 * material stay out of TanStack Query and the DOM.
 */
export { PortabilityScreen } from './PortabilityScreen';
