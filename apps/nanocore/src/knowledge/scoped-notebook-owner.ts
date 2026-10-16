import { NotebookError } from './notebook.js';

/** Resolves the currently authorized owner of one scoped notebook. */
export function resolveScopedNotebookOwner(_input: unknown): never {
  throw new NotebookError('invalid_request');
}

/** Pins one currently authorized scoped notebook revision. */
export function pinScopedNotebook(_input: unknown): never {
  throw new NotebookError('invalid_request');
}

/** Explicitly initializes a fresh scoped notebook under native creation authority. */
export function initializeScopedNotebook(_input: unknown): never {
  throw new NotebookError('invalid_request');
}
