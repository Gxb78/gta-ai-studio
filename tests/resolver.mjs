// Résolution des imports sans extension, comme le fait Vite.
// Node exige `./x.ts`, le code source écrit `./x` : ce crochet fait le pont,
// ce qui évite d'ajouter un exécuteur de tests comme dépendance.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CANDIDATES = [".ts", ".tsx", "/index.ts"];

export function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  if (relative && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
    const base = new URL(specifier, context.parentURL).href;
    for (const extension of CANDIDATES) {
      const candidate = base + extension;
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(candidate, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
