import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// The settings tab runs in the browser, so its styles cannot be imported and
// asserted at runtime; the source is checked instead. The bug this guards is a
// silent one: a button whose text colour is hardcoded '#fff' looks fine on the
// light theme and turns into an empty white box on the dark theme, because
// --dsw-alias-brand-primary flips from near-black to near-white there.

const SOURCE = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

/** The text of one style entry in the S table, e.g. 'primary: { ... }'. */
function styleEntry(name) {
  const start = SOURCE.indexOf(`      ${name}: {`)
  assert.notEqual(start, -1, `style ${name} not found`)
  const end = SOURCE.indexOf('\n      },', start)
  assert.notEqual(end, -1, `style ${name} is not closed`)
  return SOURCE.slice(start, end)
}

test('the primary button paints a token pair that survives the dark theme', () => {
  const primary = styleEntry('primary')
  // background and colour must come from the same theme layer: fill token for
  // the paint, inverted label token for the text drawn on top of it.
  assert.match(primary, /background: 'var\(--dsw-alias-button-primary-fill/)
  assert.match(primary, /color: 'var\(--dsw-alias-label-primary-inverted/)
  // A literal colour here is the bug: it cannot follow the theme.
  assert.doesNotMatch(primary, /color: '#/)
  assert.doesNotMatch(primary, /background: '#/)
})

test('no button style hardcodes a light-only text colour', () => {
  for (const name of ['button', 'primary', 'danger']) {
    assert.doesNotMatch(styleEntry(name), /color: '#fff/i, `${name} hardcodes white text`)
  }
})

test('the QR code keeps its white plate on both themes', () => {
  // Deliberate exception: a QR code needs a white quiet zone to scan, so this
  // one background must NOT follow the theme.
  assert.match(styleEntry('qr'), /background: '#fff'/)
})

/** The keys of one COPY dictionary, in source order. */
function copyKeys(locale) {
  const start = SOURCE.indexOf(`      ${locale}: {`)
  assert.notEqual(start, -1, `COPY.${locale} not found`)
  const end = SOURCE.indexOf('\n      },', start)
  assert.notEqual(end, -1, `COPY.${locale} is not closed`)
  return [...SOURCE.slice(start, end).matchAll(/^        (\w+):/gm)].map((match) => match[1])
}

test('both languages carry exactly the same keys', () => {
  // A key added to one language only renders as "undefined" for the other
  // locale, which is invisible in the Chinese-first default.
  assert.deepEqual(copyKeys('en').sort(), copyKeys('zh').sort())
})

test('the settings page is a nav-rail section, not a Plugins tab', () => {
  // A third-party plugin that registers into `settings.plugins.tab` only shows
  // up inside the built-in Plugins section, which not every build mounts; the
  // entry then exists but is unreachable. `settings.section` is the supported
  // seat: one page per Settings nav row.
  assert.match(SOURCE, /name: 'settings\.section'/)
  assert.doesNotMatch(SOURCE, /inject\('settings\.plugins\.tab'/)
  assert.doesNotMatch(SOURCE, /name: 'settings\.plugins\.tab'/)
  // The nav position is between "Agent presets" (20) and "桌宠配置" (30).
  assert.match(SOURCE, /const SECTION_ORDER = 2[1-9]\b/)
})

test('every copy key is actually rendered', () => {
  // Two keys (refresh, cancelAction) outlived their call sites and sat in the
  // dictionary looking like features. An unused key is dead weight, and a key
  // that is used but missing is worse — so both directions are checked.
  const body = SOURCE.slice(SOURCE.indexOf('function WeixinChannelPanel'))
  const unused = copyKeys('zh').filter((key) => !body.includes(`t.${key}`))
  assert.deepEqual(unused, [], `copy keys with no call site: ${unused.join(', ')}`)
})
