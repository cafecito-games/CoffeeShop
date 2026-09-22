// Test-only clock for the system test's hub process, loaded with `node --import`. It shifts every
// Date the hub creates by the millisecond offset stored in COFFEE_SHOP_TEST_CLOCK_OFFSET_FILE, so a
// scenario can move hub time past a deadline (such as an approval's expiry) without sleeping.
// Timers are untouched. Each applied offset is logged so the test can wait for it.
import { readFileSync, statSync } from "node:fs";

const offsetFile = process.env.COFFEE_SHOP_TEST_CLOCK_OFFSET_FILE;
const RealDate = Date;
let offset = 0;
let observedModification = 0;

function refreshOffset() {
  if (!offsetFile) return;
  try {
    const modified = statSync(offsetFile).mtimeMs;
    if (modified === observedModification) return;
    observedModification = modified;
    const value = Number(readFileSync(offsetFile, "utf8").trim());
    if (Number.isSafeInteger(value) && value !== offset) {
      offset = value;
      console.log(`test clock offset ${offset}`);
    }
  } catch {
    // No offset file yet: real time.
  }
}

setInterval(refreshOffset, 20).unref();

class ShiftedDate extends RealDate {
  constructor(...values) {
    if (values.length === 0) super(RealDate.now() + offset);
    else super(...values);
  }

  static now() {
    return RealDate.now() + offset;
  }
}

globalThis.Date = ShiftedDate;
