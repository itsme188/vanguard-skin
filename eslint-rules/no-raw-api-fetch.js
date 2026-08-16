"use strict";

// Packaged-app trust boundary (#35, task 8) — forbids a raw mutating
// `fetch(...)` call from client code so nothing can bypass the
// `X-CSRF-Token` header that `lib/http/apiFetch.ts` attaches. Wired as an
// inline flat-config plugin (see eslint.config.mjs), scoped to app/**.
//
// Two independent triggers (either one reports):
//
//   (a) the init argument is an object literal whose `method` property is
//       a string literal matching an unsafe verb (POST/PUT/PATCH/DELETE,
//       case-insensitive) — regardless of what the first argument looks
//       like. This is the unambiguous case: we can see the method.
//
//   (b) the first argument targets `/api/` (a string or template literal
//       containing that substring) AND the method can't be statically
//       proven to be GET:
//         - no second argument at all -> fetch defaults to GET -> safe,
//           not flagged (this is the "clearly-GET" case the rule must
//           leave alone: `fetch("/api/x")`).
//         - second argument present but NOT an object literal (a
//           variable, a spread, a ternary, ...) -> we can't inspect it ->
//           conservatively flagged.
//         - second argument is an object literal with no `method`
//           property -> defaults to GET -> not flagged.
//         - second argument is an object literal whose `method` value
//           isn't a plain string literal (a variable, template, etc.) ->
//           can't prove it's GET -> flagged. (An unsafe string literal
//           here is already caught by (a); this branch only adds the
//           dynamic-value case so it isn't double-reported.)
//
// This intentionally never flags `fetch("/api/x")` — a plain call with no
// init at all is provably GET. A string-literal grep can't tell (a)/(b)
// apart from a template-literal endpoint or a variable init, which is why
// this is an AST rule instead.

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isApiTargetLiteral(node) {
  if (!node) return false;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value.includes("/api/");
  }
  if (node.type === "TemplateLiteral") {
    return node.quasis.some((quasi) => quasi.value.raw.includes("/api/"));
  }
  return false;
}

function findMethodProperty(objectExpression) {
  for (const prop of objectExpression.properties) {
    if (prop.type !== "Property") continue; // skip SpreadElement — can't resolve statically
    const key = prop.key;
    const keyName = !prop.computed && key.type === "Identifier" ? key.name : key.type === "Literal" ? String(key.value) : null;
    if (keyName === "method") return prop;
  }
  return null;
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Forbid raw mutating fetch(...) in client code — use lib/http/apiFetch.ts so the CSRF header can't be bypassed.",
    },
    schema: [],
    messages: {
      unsafeMethodLiteral: "Raw fetch() with method '{{method}}' bypasses the CSRF header. Use apiFetch from lib/http/apiFetch instead.",
      unprovableApiCall: "fetch() targeting an /api/ route with a non-literal or unresolvable init can't be proven to be a GET. Use apiFetch from lib/http/apiFetch instead.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "fetch") return;

        const [urlArg, initArg] = node.arguments;
        const methodProp = initArg && initArg.type === "ObjectExpression" ? findMethodProperty(initArg) : null;
        const literalMethod = methodProp && methodProp.value.type === "Literal" && typeof methodProp.value.value === "string" ? methodProp.value.value.toUpperCase() : null;

        // (a) explicit unsafe method literal, regardless of the URL shape.
        if (literalMethod && UNSAFE_METHODS.has(literalMethod)) {
          context.report({ node, messageId: "unsafeMethodLiteral", data: { method: literalMethod } });
          return;
        }

        // (b) /api/-targeting call whose method can't be proven GET.
        if (!isApiTargetLiteral(urlArg)) return;
        if (!initArg) return; // no init at all -> default GET -> provably safe

        if (initArg.type !== "ObjectExpression") {
          // spread, variable, call expression, ternary, ... — opaque init.
          context.report({ node, messageId: "unprovableApiCall" });
          return;
        }

        if (!methodProp) return; // object literal with no method key -> GET -> safe

        if (literalMethod) {
          if (SAFE_METHODS.has(literalMethod)) return; // provably GET/HEAD/OPTIONS
          // Any other literal verb reaching here isn't in UNSAFE (handled
          // above) or SAFE — treat as unprovable rather than silently safe.
          context.report({ node, messageId: "unprovableApiCall" });
          return;
        }

        // method present but its value isn't a plain string literal
        // (variable, template, ternary, ...) -> can't prove it's GET.
        context.report({ node, messageId: "unprovableApiCall" });
      },
    };
  },
};

module.exports = rule;
