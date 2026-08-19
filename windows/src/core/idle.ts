// core/idle.ts — user idleness, sleep, and typing "vibration".
// From main.swift:766-776 and Environment.swift:82-88.
//
// SUBSTITUTION: macOS asks CGEventSource for KEYBOARD-ONLY idleness. Windows'
// GetLastInputInfo reports combined input, so keyboard activity is inferred as
// "the last-input tick advanced while the cursor did not move". This keeps the
// macOS build's privacy property exactly intact: we learn WHEN input happened,
// never which key it was.

const TYPING_EMA = 0.15;        // main.swift:768
const NIGHT_IDLE_SECONDS = 600;
const ANYTIME_IDLE_SECONDS = 1800;

const UINT32 = 4294967296;      // 2^32

// `GetTickCount()` and `LASTINPUTINFO.dwTime` are unsigned 32-bit millisecond
// counters, so they wrap back to zero about every 49.7 days of uptime. Plain
// subtraction then goes NEGATIVE, which used to clamp idle time to zero — a
// machine left idle across the wrap would never fall asleep until the next
// keypress — and made the first input after a wrap look like no input at all,
// because the tick had gone backwards.
//
// Both operands below 2^32 means they are Win32 ticks, so the difference is
// taken with unsigned-32 wrap semantics. Anything larger came from the
// `Date.now()` fallback the win32 layer uses when the FFI is unavailable, where
// wrapping must NOT be applied: those values are ~1.7e12, and a backwards system
// clock should read as a negative delta rather than a 49-day one.
//
// Unresolvable by construction: a gap longer than 49.7 days is
// indistinguishable from a short one, because the counter carries no more
// information than that.
export function tickDelta(now: number, then: number): number {
  const nowIsTick = now >= 0 && now < UINT32;
  const thenIsTick = then >= 0 && then < UINT32;
  if (nowIsTick && thenIsTick) return (now - then) >>> 0;
  if (nowIsTick !== thenIsTick) {
    // Mixed domains: GetTickCount failed while GetLastInputInfo kept working, or
    // vice versa. Neither arithmetic is meaningful — plain subtraction would read
    // as decades of idleness and sleep the fly instantly — so report nothing
    // elapsed. Staying awake is the safe direction.
    return 0;
  }
  return now - then;
}

// main.swift:774
export function isSleepy(idleSeconds: number, hour: number): boolean {
  return (idleSeconds > NIGHT_IDLE_SECONDS && (hour >= 22 || hour < 6))
    || idleSeconds > ANYTIME_IDLE_SECONDS;
}

export interface InputSample {
  idleSeconds: number;
  keyboardActive: boolean;
  typing: number;
}

export class InputSense {
  typing = 0;
  private prevInputTick: number | null = null;
  private prevCursor: { x: number; y: number } | null = null;

  sample(lastInputTick: number, nowTick: number,
         cursor: { x: number; y: number }): InputSample {
    const idleSeconds = Math.max(0, tickDelta(nowTick, lastInputTick) / 1000);

    // Wrap-safe too: after a wrap the new tick is numerically SMALLER than the
    // previous one, so a `>` comparison would miss the input entirely.
    const inputAdvanced = this.prevInputTick !== null
      && tickDelta(lastInputTick, this.prevInputTick) > 0;
    const cursorMoved = this.prevCursor !== null
      && (cursor.x !== this.prevCursor.x || cursor.y !== this.prevCursor.y);
    const keyboardActive = inputAdvanced && !cursorMoved;

    this.prevInputTick = lastInputTick;
    this.prevCursor = { x: cursor.x, y: cursor.y };

    this.typing += ((keyboardActive ? 1 : 0) - this.typing) * TYPING_EMA;
    return { idleSeconds, keyboardActive, typing: this.typing };
  }
}
