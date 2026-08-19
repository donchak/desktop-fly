import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputSense, isSleepy, tickDelta } from './idle.ts';

test('sleep needs either a long night idle or a very long idle', () => {
  // Environment.swift + main.swift:774
  assert.equal(isSleepy(700, 23), true, 'idle at night');
  assert.equal(isSleepy(700, 3), true, 'idle in the small hours');
  assert.equal(isSleepy(700, 14), false, 'the same idle at 2pm is just a break');
  assert.equal(isSleepy(2000, 14), true, 'half an hour idle sleeps any time');
  assert.equal(isSleepy(100, 23), false, 'briefly idle at night is not sleep');
  // the night window is 22:00-06:00 inclusive of 22, exclusive of 6
  assert.equal(isSleepy(700, 22), true);
  assert.equal(isSleepy(700, 21.9), false);
  assert.equal(isSleepy(700, 5.9), true);
  assert.equal(isSleepy(700, 6), false);
});

test('idle seconds come from the tick difference', () => {
  const s = new InputSense();
  const out = s.sample(1_000_000, 1_004_500, { x: 0, y: 0 });
  assert.equal(out.idleSeconds, 4.5);
});

test('input with a still cursor is read as typing; input with movement is not', () => {
  // The substitution for macOS's keyboard-only idle query. It preserves the
  // privacy property exactly: we learn WHEN keys were pressed, never which.
  const s = new InputSense();
  s.sample(1000, 1000, { x: 10, y: 10 });          // prime

  // last input advanced, cursor unchanged => keyboard
  const typed = s.sample(1100, 1100, { x: 10, y: 10 });
  assert.equal(typed.keyboardActive, true);
  assert.ok(typed.typing > 0, `typing level ${typed.typing}`);

  // last input advanced, cursor moved => mouse, not typing
  const moved = new InputSense();
  moved.sample(1000, 1000, { x: 10, y: 10 });
  const out = moved.sample(1100, 1100, { x: 40, y: 10 });
  assert.equal(out.keyboardActive, false);
});

test('the typing level rises and decays smoothly', () => {
  const s = new InputSense();
  let tick = 1000;
  s.sample(tick, tick, { x: 0, y: 0 });
  // 30 polls of steady typing
  for (let i = 0; i < 30; i++) {
    tick += 100;
    s.sample(tick, tick, { x: 0, y: 0 });
  }
  const hot = s.typing;
  assert.ok(hot > 0.8, `sustained typing should approach 1, got ${hot}`);

  // then 60 polls of nothing: the tick stops advancing
  let out = { typing: hot };
  for (let i = 0; i < 60; i++) out = s.sample(tick, tick + 1000 * i, { x: 0, y: 0 });
  assert.ok(out.typing < 0.2, `typing should decay, got ${out.typing}`);
  assert.ok(out.typing >= 0);
});

// --- 32-bit tick wrap ------------------------------------------------------
// GetTickCount and LASTINPUTINFO.dwTime are unsigned 32-bit millisecond
// counters: they wrap to zero roughly every 49.7 days. Plain subtraction goes
// NEGATIVE across a wrap, which broke sleep and typing detection on
// long-uptime machines. Reported in review.
const UINT32 = 4294967296;

test('tickDelta uses unsigned-32 wrap semantics for Win32-range ticks', () => {
  assert.equal(tickDelta(5000, 1000), 4000);
  // last input 300 ms before the wrap, now 5000 ms after it: 5300 ms elapsed
  assert.equal(tickDelta(5000, UINT32 - 300), 5300);
  // the instant of the wrap itself
  assert.equal(tickDelta(0, UINT32 - 1), 1);
  assert.equal(tickDelta(0, 0), 0);
});

test('tickDelta falls back to plain subtraction for Date.now() values', () => {
  // The win32 layer degrades to Date.now() when the FFI is unavailable, and
  // those values are far beyond 2^32, so wrap arithmetic must not apply.
  const now = Date.now();
  assert.ok(now > UINT32, 'Date.now() should be outside the uint32 range');
  assert.equal(tickDelta(now, now - 4500), 4500);
  // a backwards system clock must not become a 49-day delta
  assert.equal(tickDelta(now - 1000, now), -1000);
});

test('idle seconds survive a tick wrap instead of collapsing to zero', () => {
  // Before the fix this read 0, so a machine idle across the wrap would never
  // fall asleep until the next keypress.
  const s = new InputSense();
  const out = s.sample(UINT32 - 300, 5000, { x: 0, y: 0 });
  assert.ok(Math.abs(out.idleSeconds - 5.3) < 1e-9,
    `idle ${out.idleSeconds}s across a wrap, expected 5.3`);
  assert.equal(isSleepy(out.idleSeconds, 23), false, '5.3 s is not sleepy');
});

test('a long idle across a wrap is still recognised as sleepy', () => {
  const s = new InputSense();
  // last input 20 minutes before the wrap, now 5 minutes after it
  const out = s.sample(UINT32 - 20 * 60_000, 5 * 60_000, { x: 0, y: 0 });
  assert.ok(Math.abs(out.idleSeconds - 25 * 60) < 1e-6,
    `idle ${out.idleSeconds}s, expected 1500`);
  assert.equal(isSleepy(out.idleSeconds, 23), true);
});

test('typing is still detected when the input tick wraps backwards', () => {
  const s = new InputSense();
  // prime just before the wrap
  s.sample(UINT32 - 300, UINT32 - 200, { x: 10, y: 10 });
  // the user types 200 ms after the wrap: dwTime is now SMALLER than before
  const out = s.sample(200, 250, { x: 10, y: 10 });
  assert.equal(out.keyboardActive, true,
    'input after a wrap must count as input');
  assert.ok(out.typing > 0);
});

test('an unchanged input tick is never mistaken for input', () => {
  const s = new InputSense();
  s.sample(UINT32 - 300, UINT32 - 200, { x: 0, y: 0 });
  const out = s.sample(UINT32 - 300, UINT32 - 100, { x: 0, y: 0 });
  assert.equal(out.keyboardActive, false);
});

test('mixed clock domains report no elapsed time rather than guessing', () => {
  // If GetTickCount ever fails while GetLastInputInfo keeps working, one operand
  // is a uint32 tick and the other a Date.now() value. Wrap arithmetic is wrong
  // and so is plain subtraction (it would read as ~55 years of idleness and put
  // the fly to sleep instantly). Report 0: staying awake is the safe direction.
  assert.equal(tickDelta(Date.now(), 5000), 0);
  assert.equal(tickDelta(5000, Date.now()), 0);
});
