/**
 * ESM view of secure-fs.js.
 *
 * The helper scripts are a mix of CommonJS (.js/.cjs) and ESM (.mjs), and an
 * .mjs cannot `require('./secure-fs')`. Rather than keep a second copy of the
 * write logic — which is how the permission gap survived in the first place —
 * this pulls in the one implementation through createRequire and re-exports it.
 * There is still exactly one place to change the modes.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const impl = require('./secure-fs.js');

export const writeFileSecure = impl.writeFileSecure;
export const writeJsonSecure = impl.writeJsonSecure;
export const appendFileSecure = impl.appendFileSecure;
export const ensureDirSecure = impl.ensureDirSecure;
export const FILE_MODE = impl.FILE_MODE;
export const DIR_MODE = impl.DIR_MODE;

export default impl;
