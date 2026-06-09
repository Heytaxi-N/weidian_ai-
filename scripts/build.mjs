import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function read(rel) { return readFileSync(join(root, rel), 'utf8'); }

const promptMd = read('knowledge/prompt.md');
const faqMd    = read('knowledge/faq.md');

// Strip `export ` for IIFE concat
const libRaw = read('src/lib.mjs');
const libInIIFE = libRaw.replace(/^export\s+/gm, '');

const kbBlock = `
const __KB_PROMPT__ = ${JSON.stringify(promptMd)};
const __KB_FAQ__    = ${JSON.stringify(faqMd)};
`.trim();

const main = read('src/main.js');
const out = main
  .replace('// {{INJECT_LIB}}', libInIIFE)
  .replace('// {{INJECT_KB}}',  kbBlock);

mkdirSync(join(root, 'dist'), { recursive: true });
const dest = join(root, 'dist/weidian-ai-reply.user.js');
writeFileSync(dest, out);
console.log(`✓ built ${dest} (${out.length} bytes)`);
