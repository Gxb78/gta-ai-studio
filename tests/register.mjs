// Point d'entrée passé à `node --import` : installe le résolveur avant que le
// premier module de test ne soit chargé.
import { register } from "node:module";

register("./resolver.mjs", import.meta.url);
