// tests/theme.test.mjs: the light and dark switch's pure choices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const theme = require('../src/js/theme.js');

test('a saved choice wins over the computer setting', () => {
  assert.equal(theme.pickTheme('light', false), 'light');
  assert.equal(theme.pickTheme('dark', true), 'dark');
});

test('with no saved choice the computer setting decides, and dark is the fallback', () => {
  assert.equal(theme.pickTheme(null, true), 'light');
  assert.equal(theme.pickTheme(null, false), 'dark');
  assert.equal(theme.pickTheme(undefined, false), 'dark');
});

test('a saved value that is not a theme is ignored', () => {
  assert.equal(theme.pickTheme('purple', false), 'dark');
  assert.equal(theme.pickTheme('', true), 'light');
});

test('the switch flips between the two and names what it does next', () => {
  assert.equal(theme.otherTheme('light'), 'dark');
  assert.equal(theme.otherTheme('dark'), 'light');
  assert.equal(theme.otherTheme(null), 'light');
  assert.equal(theme.labelFor('light'), 'Switch to dark mode');
  assert.equal(theme.labelFor('dark'), 'Switch to light mode');
});
