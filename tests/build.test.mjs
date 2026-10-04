// Tests for build.mjs and for the built file, dist/takes.html.
// Run from the repository root: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { build, checkOutput, stripExportsTail, scriptBodies, moduleMarker, MODULE_ORDER } from '../build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_JS = join(ROOT, 'src', 'js');
const DIST = join(ROOT, 'dist', 'takes.html');

/**
 * THE INVARIANT: the built file names no host outside this list.
 * "Nothing is fetched except from the named hosts" is checked by sweeping every http(s) URL in the output.
 * Add a host here only with a reason, and name it in the About panel if the app contacts it.
 */
export const ALLOWED_HOSTS = {
  exact: [
    'cdn.jsdelivr.net',   // Transformers.js and Mediabunny load from here by dynamic import(), on demand
    'huggingface.co',     // the caption model files are requested from here
    'www.atlassian.com',  // a plain link the user can click: Loom's pricing page, the source for the savings line
    'takes.guessandclick.net', // a plain link the user can click: the public address of this same page (banner link and About)
    'www.w3.org'          // not contacted: the SVG and XML namespace strings (http://www.w3.org/2000/svg)
  ],
  suffixes: [
    '.hf.co'              // huggingface.co redirects model downloads to its delivery hosts, e.g. us.aws.cdn.hf.co
  ]
};

export function isAllowedHost(host) {
  const h = String(host).toLowerCase();
  if (ALLOWED_HOSTS.exact.includes(h)) return true;
  return ALLOWED_HOSTS.suffixes.some((suffix) => h.endsWith(suffix));
}

/** Every http(s) URL string in a piece of text, wherever it sits: markup, script, style or comment. */
export function extractUrls(text) {
  return text.match(/https?:\/\/[^\s"'`<>)\\]*/gi) || [];
}

/** Returns a list of problems: one line per URL whose host is not allowed or cannot be read. */
export function sweepUrls(text) {
  const problems = [];
  for (const raw of extractUrls(text)) {
    let host = null;
    try { host = new URL(raw).hostname; } catch { host = null; }
    // A host built at run time (a template or a string join) cannot be checked, so it is refused.
    if (!host || /[${}]/.test(raw.replace(/^https?:\/\//i, '').split('/')[0])) {
      problems.push('cannot read a fixed host from "' + raw + '" (hosts must be written out in full)');
    } else if (!isAllowedHost(host)) {
      problems.push('host "' + host + '" is not on the allow-list (from "' + raw + '")');
    }
  }
  return problems;
}

// ------------------------------------------------------------------ the real build

const result = build();
const html = readFileSync(DIST, 'utf8');
const bodies = scriptBodies(html);

test('the build writes dist/takes.html and reports what went in', () => {
  assert.ok(existsSync(DIST));
  assert.equal(result.bytes, Buffer.byteLength(html, 'utf8'));
  assert.ok(result.modules.includes('core'), 'core.js is always bundled');
  assert.deepEqual(result.modules, MODULE_ORDER.filter((name) => result.modules.includes(name)), 'modules are in the fixed order');
  assert.deepEqual(result.warnings, [], 'the build has no warnings');
});

test('the build markers are replaced and the shell is intact', () => {
  assert.ok(!html.includes('<!-- build:css -->'));
  assert.ok(!html.includes('<!-- build:js -->'));
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<meta charset="utf-8">/i);
  assert.match(html, /<meta name="viewport"/i);
  assert.match(html, /<title>[^<]+<\/title>/i);
  for (const id of ['tk-view-record', 'tk-recbar', 'tk-view-review', 'tk-view-library', 'tk-view-about', 'tk-toasts', 'tk-banner', 'tk-guide', 'tk-record-btn', 'tk-captions-size']) {
    assert.equal(html.split('id="' + id + '"').length - 1, 1, 'the shell has exactly one #' + id);
  }
  assert.match(html.trimEnd(), /<\/script>\s*<\/body>\s*<\/html>$/i, 'the script is the last thing in the body');
});

test('no element id appears twice', () => {
  const seen = new Map();
  const shell = html.replace(/<script\b[\s\S]*<\/script>/i, '');
  for (const m of shell.matchAll(/\sid="([^"]+)"/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  const doubles = [...seen].filter(([, count]) => count > 1).map(([id]) => id);
  assert.deepEqual(doubles, []);
});

test('no inline event handler attributes', () => {
  const shell = html.replace(/<script\b[\s\S]*<\/script>/i, '').replace(/<style\b[\s\S]*<\/style>/i, '');
  const hit = /<[a-z][^>]*\son[a-z]+\s*=/i.exec(shell);
  assert.equal(hit, null, hit ? 'found: ' + hit[0] : '');
});

test('no external script and no external stylesheet', () => {
  assert.ok(!/<script\b[^>]*\ssrc\s*=/i.test(html), 'no <script src');
  assert.ok(!/<link\b[^>]*rel\s*=\s*["']?stylesheet/i.test(html), 'no <link rel="stylesheet"');
  assert.ok(!/<link\b[^>]*\shref\s*=/i.test(html), 'no <link href of any kind');
  assert.ok(!/@import\b/i.test(html), 'no CSS @import');
});

test('exactly one inline classic script', () => {
  assert.equal((html.match(/<script\b/gi) || []).length, 1, 'one opening script tag');
  assert.equal((html.match(/<\/script\s*>/gi) || []).length, 1, 'one closing script tag');
  assert.equal(bodies.length, 1);
  assert.ok(!/<script\b[^>]*\stype\s*=/i.test(html), 'the script is classic: no type attribute, so never a module');
});

test('no </script> and no <!-- inside the script body', () => {
  // With one opening and one closing tag in the whole file, a stray closer inside the body is impossible;
  // this asserts it directly as well, on the text between the first opener and the last closer.
  const open = html.search(/<script\b[^>]*>/i);
  const openEnd = html.indexOf('>', open) + 1;
  const close = html.toLowerCase().lastIndexOf('</script');
  const inner = html.slice(openEnd, close);
  assert.ok(!/<\/script/i.test(inner));
  assert.ok(!inner.includes('<!--'));
});

test('no static import or export in the script body', () => {
  assert.deepEqual(checkOutput(html, bodies[0]), []);
  assert.ok(!/^[ \t]*import\s+[\w$*{'"]/m.test(bodies[0]), 'no line starts with a static import');
  assert.ok(!/^[ \t]*export\s/m.test(bodies[0]), 'no line starts with export');
});

test('every module file in src/js is known to the build and carries its marker in the output', () => {
  const files = readdirSync(SRC_JS).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
  assert.ok(files.includes('core'));
  for (const name of files) {
    assert.ok(MODULE_ORDER.includes(name), name + '.js is not in MODULE_ORDER, so build.mjs would silently leave it out');
    assert.ok(html.includes(moduleMarker(name)), 'the output is missing the marker ' + moduleMarker(name));
    assert.ok(result.modules.includes(name), name + '.js was not bundled');
  }
  const positions = result.modules.map((name) => html.indexOf(moduleMarker(name)));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'the markers appear in the fixed order');
});

test('the module.exports tails are stripped from the output', () => {
  assert.ok(!/module\s*\.\s*exports/.test(bodies[0]));
  assert.ok(!/typeof\s+module\b/.test(bodies[0]));
});

test('the inlined script is valid as a classic script and defines the Takes global', () => {
  // new Function parses the body as classic-script code: a static import or export would be a SyntaxError here.
  const sandboxWindow = {};
  const run = new Function('window', 'document', 'navigator', bodies[0] + '\n;return window.Takes;');
  let takes = null;
  try { takes = run(sandboxWindow, undefined, undefined); } catch (err) {
    // Later modules may need a real DOM to run; parsing is what this test proves, so only a SyntaxError fails it.
    assert.ok(!(err instanceof SyntaxError), 'the script body does not parse: ' + err.message);
    takes = sandboxWindow.Takes;
  }
  assert.ok(takes, 'window.Takes is defined');
  assert.equal(typeof takes.bus.emit, 'function');
});

test('invariant sweep: every http(s) URL in the output points at an allowed host', () => {
  const urls = extractUrls(html);
  assert.ok(urls.some((u) => u.startsWith('https://www.atlassian.com/software/loom/pricing')), 'the Loom pricing source link is present');
  assert.deepEqual(sweepUrls(html), []);
});

test('the URL sweep itself catches what it should', () => {
  assert.deepEqual(sweepUrls('import("https://cdn.jsdelivr.net/npm/mediabunny@1.61.1/+esm")'), []);
  assert.deepEqual(sweepUrls('fetch("https://us.aws.cdn.hf.co/model.onnx")'), []);
  assert.deepEqual(sweepUrls('xmlns="http://www.w3.org/2000/svg"'), []);
  assert.equal(sweepUrls('fetch("https://evil.example.com/x")').length, 1);
  assert.equal(sweepUrls('a{background:url(http://fonts.gstatic.com/f.woff)}').length, 1);
  assert.equal(sweepUrls('// see https://developer.mozilla.org/en-US/docs').length, 1, 'a URL in a comment still counts');
  assert.equal(sweepUrls('https://nothf.co/x').length, 1, 'hf.co is matched as a dot-suffix only');
  assert.equal(sweepUrls('https://huggingface.co.evil.com/x').length, 1);
  assert.equal(sweepUrls('fetch(`https://${host}/x`)').length, 1, 'a host built at run time is refused');
});

// ------------------------------------------------------------------ stripExportsTail

test('stripExportsTail: a one-line tail', () => {
  const out = stripExportsTail("var a = 1;\nif (typeof module !== 'undefined') module.exports = { a };\n");
  assert.equal(out, 'var a = 1;\n');
});

test('stripExportsTail: a tail spread over several lines, with nested braces and strings', () => {
  const src = [
    '/* takes:x */',
    'function f() { return 1; }',
    "if (typeof module !== 'undefined') module.exports = {",
    '  f: f,',
    "  nested: { text: 'a; b } c', list: [1, 2] }, // a comment with ; and }",
    '  g: function () { return 2; }',
    '};',
    ''
  ].join('\n');
  assert.equal(stripExportsTail(src), '/* takes:x */\nfunction f() { return 1; }\n');
});

test('stripExportsTail: double quotes, a block body, and the && module.exports form', () => {
  assert.equal(stripExportsTail('var a;\nif (typeof module !== "undefined") { module.exports = { a: a }; }\n'), 'var a;\n');
  assert.equal(stripExportsTail("var a;\nif (typeof module !== 'undefined' && module.exports) module.exports = { a: a };\n"), 'var a;\n');
});

test('stripExportsTail: a tail inside an IIFE leaves the IIFE whole', () => {
  const src = "(function (root) {\n  var api = {};\n  root.x = api;\n  if (typeof module !== 'undefined') module.exports = api;\n})(this);\n";
  const out = stripExportsTail(src);
  assert.equal(out, '(function (root) {\n  var api = {};\n  root.x = api;\n})(this);\n');
  assert.doesNotThrow(() => new Function(out));
});

test('stripExportsTail: code with no tail, or an unrelated typeof module check, is left alone', () => {
  assert.equal(stripExportsTail('var a = 1;\n'), 'var a = 1;\n');
  const other = "if (typeof module !== 'undefined') { console.log('node'); }\nvar b = 2;\n";
  assert.equal(stripExportsTail(other), other);
});

// ------------------------------------------------------------------ the build refuses bad output

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'takes-build-'));
  mkdirSync(join(dir, 'js'), { recursive: true });
  const shell = '<!doctype html>\n<html><head><title>t</title>\n<!-- build:css -->\n</head><body>\n<!-- build:js -->\n</body></html>\n';
  writeFileSync(join(dir, 'index.html'), files.shell || shell);
  for (const [name, text] of Object.entries(files)) {
    if (name !== 'shell') writeFileSync(join(dir, name), text);
  }
  return dir;
}

function buildFixture(files) {
  const dir = fixture(files);
  try {
    return build({ srcDir: dir, outFile: join(dir, 'out.html') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('build: inlines styles and scripts in the fixed order and skips what is missing', () => {
  const out = buildFixture({
    'styles.css': '.tk-app { color: red; }\n',
    'js/ui.js': '/* takes:ui */\nwindow.order.push("ui");\n',
    'js/core.js': "/* takes:core */\nwindow.order = ['core'];\nvar price = '$1 and $& and $$';\nif (typeof module !== 'undefined') module.exports = {\n  a: 1\n};\n",
    'js/stray.js': '/* takes:stray */\nwindow.stray = true;\n'
  });
  assert.deepEqual(out.modules, ['core', 'ui']);
  assert.ok(out.skipped.includes('capture'));
  assert.equal(out.cssIncluded, true);
  assert.match(out.html, /<style>\n\.tk-app \{ color: red; \}\n<\/style>/);
  assert.ok(out.html.indexOf('takes:core') < out.html.indexOf('takes:ui'));
  assert.ok(out.html.includes("'$1 and $& and $$'"), 'a $ in the source survives the inlining untouched');
  assert.ok(!out.html.includes('module.exports'));
  assert.ok(!out.html.includes('stray'), 'a file outside the fixed order is not bundled');
  assert.equal(scriptBodies(out.html).length, 1);
});

test('build: with no styles.css the css marker is dropped silently', () => {
  const out = buildFixture({ 'js/core.js': '/* takes:core */\nvar a = 1;\n' });
  assert.equal(out.cssIncluded, false);
  assert.ok(!out.html.includes('<style'));
  assert.ok(!out.html.includes('build:css'));
});

const BAD = [
  ['a <script src> in the shell', { shell: '<html><head><!-- build:css --></head><body><script src="x.js"></script><!-- build:js --></body></html>' }, /<script src/],
  ['a stylesheet link in the shell', { shell: '<html><head><link rel="stylesheet" href="x.css"><!-- build:css --></head><body><!-- build:js --></body></html>' }, /link rel="stylesheet"/],
  ['a static import at line start', { 'js/core.js': "/* takes:core */\nimport { a } from './a.js';\n" }, /static `import `/],
  ['a bare static import at line start', { 'js/core.js': "/* takes:core */\n  import 'https://cdn.jsdelivr.net/x.js';\n" }, /static `import `/],
  ['a static export at line start', { 'js/core.js': '/* takes:core */\nexport const a = 1;\n' }, /static `export `/],
  ['a literal </script> in the script body', { 'js/core.js': '/* takes:core */\nvar s = "</script>";\n' }, /<\/script>/],
  ['a literal </style> in the stylesheet', { 'styles.css': '.a::after { content: "</style>"; }\n', 'js/core.js': '/* takes:core */\n' }, /<\/style>/]
];

for (const [label, files, pattern] of BAD) {
  test('build refuses ' + label, () => {
    assert.throws(() => buildFixture(files), (err) => {
      assert.match(err.message, /Build failed/);
      assert.match(err.message, pattern);
      return true;
    });
  });
}

test('build: a dynamic import() is allowed', () => {
  const out = buildFixture({
    'js/core.js': "/* takes:core */\nfunction load() {\n  return import('https://cdn.jsdelivr.net/npm/mediabunny@1.61.1/+esm');\n}\n"
  });
  assert.deepEqual(out.modules, ['core']);
});

test('build: a missing marker in the shell is a clear error', () => {
  assert.throws(() => buildFixture({ shell: '<html><head></head><body><!-- build:js --></body></html>' }), /build:css/);
});

test('build.mjs as a command: exit 0 and a report from any folder; non-zero with the reason when the output is bad', async () => {
  const { spawnSync } = await import('node:child_process');
  // Run from a different folder on purpose: paths must come from the file's own location, never the current folder.
  const good = spawnSync(process.execPath, [join(ROOT, 'build.mjs')], { encoding: 'utf8', cwd: tmpdir() });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /Size: /);
  assert.match(good.stdout, /Modules included \(\d+\): core/);

  const dir = fixture({ 'js/core.js': '/* takes:core */\nexport const a = 1;\n' });
  try {
    const out = join(dir, 'out.html');
    const bad = spawnSync(process.execPath, [join(ROOT, 'build.mjs'), '--src', dir, '--out', out], { encoding: 'utf8', cwd: tmpdir() });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /Build failed/);
    assert.match(bad.stderr, /static `export `/);
    assert.ok(!existsSync(out), 'a failed build writes nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
