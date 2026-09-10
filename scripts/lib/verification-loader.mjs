// Node 24 strips TypeScript natively. Resolve only this runner's extensionless
// relative imports; leave package/node imports and every other module untouched.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
const scripts = new URL('../', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(scripts) && specifier.startsWith('./')) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});
