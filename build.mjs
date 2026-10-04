// build.mjs: inlines src/ into ONE self-contained file, dist/takes.html.
// Node, zero dependencies. Run it from anywhere: `node build.mjs`.
// Paths resolve from this file's own location, never from the current folder.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** The fixed order the scripts are joined in. A file in src/js that is not named here is never bundled. */
export const MODULE_ORDER = ['core', 'capture', 'compositor', 'recorder', 'library', 'save', 'editor', 'captions', 'ui', 'theme'];

/** Stylesheets joined after src/styles.css, in this order, when they exist: the embedded font, then the look. */
export const EXTRA_CSS = ['fonts.css', 'theme.css'];

export const CSS_MARKER = '<!-- build:css -->';
export const JS_MARKER = '<!-- build:js -->';

/** The first-line marker every module file carries, e.g. the comment "takes:core". */
export function moduleMarker(name) {
  return '/* takes:' + name + ' */';
}

// ------------------------------------------------------------------ tail stripping

// Skips a quoted string or a comment that starts at index i. Returns the index just past it, or i if none starts there.
function skipInert(src, i) {
  const c = src[i];
  if (c === '"' || c === "'" || c === '`') {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === c) return j + 1;
      j++;
    }
    return src.length;
  }
  if (c === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl;
  }
  if (c === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end === -1 ? src.length : end + 2;
  }
  return i;
}

// From an opening bracket at index i, returns the index just past its matching closer.
function skipBalanced(src, i) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const open = src[i];
  const close = pairs[open];
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const inert = skipInert(src, j);
    if (inert !== j) { j = inert; continue; }
    if (src[j] === open) depth++;
    else if (src[j] === close) { depth--; if (depth === 0) return j + 1; }
    j++;
  }
  return src.length;
}

// From index i, returns the index just past the `;` that ends the statement (brackets, strings and comments respected).
function skipStatement(src, i) {
  let j = i;
  while (j < src.length) {
    const inert = skipInert(src, j);
    if (inert !== j) { j = inert; continue; }
    const c = src[j];
    if (c === '(' || c === '{' || c === '[') { j = skipBalanced(src, j); continue; }
    if (c === ';') return j + 1;
    if (c === ')' || c === '}' || c === ']') return j; // the statement ran into its enclosing block with no semicolon
    j++;
  }
  return src.length;
}

/**
 * Remove every `if (typeof module !== 'undefined') module.exports = ...;` statement from a source file.
 * Handles a tail spread over several lines, a `{ ... }` block body, and a tail that sits inside an IIFE.
 * Anything that is not a module.exports assignment is left alone.
 */
export function stripExportsTail(source) {
  const start = /if\s*\(\s*typeof\s+module\s*!==?\s*(['"])undefined\1/g;
  let out = '';
  let cursor = 0;
  let m;
  while ((m = start.exec(source)) !== null) {
    const from = m.index;
    if (from < cursor) continue;
    const parenAt = source.indexOf('(', from);
    let i = skipBalanced(source, parenAt);
    while (i < source.length && /\s/.test(source[i])) i++;
    const end = source[i] === '{' ? skipBalanced(source, i) : skipStatement(source, i);
    const statement = source.slice(from, end);
    if (!/module\s*\.\s*exports/.test(statement)) continue;
    out += source.slice(cursor, from).replace(/[ \t]+$/, '');
    cursor = end;
    // When the tail had a line to itself, take its line break too, so no blank line is left behind.
    const restOfLine = /^[ \t]*\r?\n/.exec(source.slice(end));
    if (restOfLine && (out === '' || out.endsWith('\n'))) cursor = end + restOfLine[0].length;
    start.lastIndex = cursor;
  }
  out += source.slice(cursor);
  return out.replace(/\s+$/, '') + '\n';
}

// ------------------------------------------------------------------ output checks

/** Pull the inline script bodies out of built HTML. Returns an array of strings. */
export function scriptBodies(html) {
  const bodies = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) bodies.push(m[1]);
  return bodies;
}

// One strict rule, the same one tests/build.test.mjs applies: no line may START with `import ` or `export `,
// even inside a comment or a long string. A dynamic import( has no space before the bracket, so it passes.
const STATIC_IMPORT = /^[ \t]*import\s+[\w$*{'"]/m;
const STATIC_EXPORT = /^[ \t]*export\s/m;

/**
 * The single-file rules. Returns a list of plain-words problems; an empty list means the output is good.
 * html is the whole built page; scriptBody is the joined script exactly as it was inlined.
 */
export function checkOutput(html, scriptBody) {
  const problems = [];
  if (/<script\b[^>]*\ssrc\s*=/i.test(html)) {
    problems.push('The output contains `<script src`. Every script must be inlined; nothing may load from a sibling file.');
  }
  if (/<link\b[^>]*rel\s*=\s*["']?stylesheet/i.test(html)) {
    problems.push('The output contains `<link rel="stylesheet"`. Styles must be inlined from src/styles.css.');
  }
  const body = scriptBody == null ? scriptBodies(html).join('\n') : scriptBody;
  const imp = STATIC_IMPORT.exec(body);
  if (imp) {
    problems.push('A static `import ` starts a line in the script body ("' + imp[0].trim() + '..."). Use a dynamic import() inside a try/catch instead.');
  }
  const exp = STATIC_EXPORT.exec(body);
  if (exp) {
    problems.push('A static `export ` starts a line in the script body ("' + exp[0].trim() + '..."). Attach to the Takes namespace instead.');
  }
  if (/<\/script/i.test(body)) {
    problems.push('The script body contains a literal `</script>`, which would end the inline script early. Split the string, e.g. "<" + "/script>".');
  }
  if (body.indexOf('<!--') !== -1) {
    problems.push('The script body contains `<!--`, which can make the browser misread where the inline script ends. Split the string.');
  }
  return problems;
}

// ------------------------------------------------------------------ the build

/**
 * Build the single file.
 * options (all optional, for tests): srcDir, outFile, write (default true).
 * Returns { outFile, bytes, modules, skipped, cssIncluded, warnings, html }.
 * Throws an Error (with a .problems array) when the output breaks a single-file rule.
 */
export function build(options = {}) {
  const srcDir = resolve(options.srcDir || join(ROOT, 'src'));
  const outFile = resolve(options.outFile || join(ROOT, 'dist', 'takes.html'));
  const write = options.write !== false;

  const shellPath = join(srcDir, 'index.html');
  if (!existsSync(shellPath)) {
    throw new Error('Build failed: ' + shellPath + ' does not exist.');
  }
  const shell = readFileSync(shellPath, 'utf8');
  for (const marker of [CSS_MARKER, JS_MARKER]) {
    const count = shell.split(marker).length - 1;
    if (count !== 1) {
      throw new Error('Build failed: src/index.html must contain the marker ' + marker + ' exactly once (found ' + count + ').');
    }
  }

  const warnings = [];

  // Styles: inlined when the file exists, skipped silently when it does not.
  const cssPath = join(srcDir, 'styles.css');
  const cssIncluded = existsSync(cssPath);
  let css = cssIncluded ?readFileSync(cssPath, 'utf8').replace(/^﻿/, '').replace(/\s+$/, '') : '';
  if (cssIncluded) {
    for (const name of EXTRA_CSS) {
      const extra = join(srcDir, name);
      if (existsSync(extra)) css += '\n\n' + readFileSync(extra, 'utf8').replace(/^﻿/, '').replace(/\s+$/, '');
    }
  }
  if (/<\/style/i.test(css)) {
    throw new Error('Build failed: src/styles.css contains a literal `</style>`, which would end the inline style early.');
  }
  const cssBlock = cssIncluded ? '<style>\n' + css + '\n</style>' : '';

  // Scripts: the fixed order, skipping any module whose file is absent.
  const modules = [];
  const skipped = [];
  const parts = [];
  for (const name of MODULE_ORDER) {
    const file = join(srcDir, 'js', name + '.js');
    if (!existsSync(file)) { skipped.push(name); continue; }
    const stripped = stripExportsTail(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (stripped.indexOf(moduleMarker(name)) === -1) {
      warnings.push(name + '.js is missing its marker comment ' + moduleMarker(name) + ' (the build test will fail).');
    }
    if (/module\s*\.\s*exports/.test(stripped)) {
      warnings.push(name + '.js still mentions module.exports after its tail was stripped; check the tail has the standard form.');
    }
    modules.push(name);
    parts.push(stripped.replace(/\s+$/, ''));
  }
  // A lone semicolon between files keeps one file's last expression from running into the next file's first line.
  const scriptBody = parts.join('\n;\n');
  const jsBlock = '<script>\n' + scriptBody + '\n</script>';

  // Function replacers, so a `$` in the source is never read as a replacement pattern.
  const html = shell.replace(CSS_MARKER, () => cssBlock).replace(JS_MARKER, () => jsBlock);

  const problems = checkOutput(html, scriptBody);
  if (problems.length > 0) {
    const err = new Error('Build failed: the output is not a clean single file.\n  - ' + problems.join('\n  - '));
    err.problems = problems;
    throw err;
  }

  if (write) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, html, 'utf8');
  }

  return { outFile, bytes: Buffer.byteLength(html, 'utf8'), modules, skipped, cssIncluded, warnings, html };
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' bytes';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function isMain() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  if (!process.argv[1]) return false;
  const a = resolve(process.argv[1]);
  const b = fileURLToPath(import.meta.url);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isMain()) {
  try {
    // Optional, for tests: --src <folder> and --out <file>. With neither, it builds src/ into dist/takes.html.
    const args = process.argv.slice(2);
    const opt = (flag) => (args.indexOf(flag) !== -1 ? args[args.indexOf(flag) + 1] : undefined);
    const result = build({ srcDir: opt('--src'), outFile: opt('--out') });
    console.log('Built ' + result.outFile);
    console.log('Size: ' + formatBytes(result.bytes) + ' (' + result.bytes + ' bytes)');
    console.log('Styles: ' + (result.cssIncluded ? 'src/styles.css inlined' : 'src/styles.css is absent, skipped'));
    console.log('Modules included (' + result.modules.length + '): ' + (result.modules.join(', ') || 'none'));
    if (result.skipped.length > 0) console.log('Modules absent, skipped: ' + result.skipped.join(', '));
    for (const w of result.warnings) console.warn('Warning: ' + w);
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  }
}
