/**
 * Minimum length for the app password. Single source for the renderer
 * (SecuritySection). Electron main cannot import from lib/ (separate tsconfig
 * rootDir), so electron/password-prompt.ts owns the mirror constant that
 * main.ts also imports; tests/auth/password-policy.test.ts pins the two equal
 * and forbids a re-hardcoded literal.
 */
export const MIN_PASSWORD_LENGTH = 8;
