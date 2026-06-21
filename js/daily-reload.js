// Daily self-reload at ~4am AEST so deployed carousel/screen changes reach the
// unattended physical displays without anyone manually refreshing them. 4am sits
// in the quiet window before the day's earliest kickoff (5am AEST).
//
// - location.reload() preserves the URL (?office=, ?chrome=, ?demo= …) and, with
//   the revalidating cache headers, fetches the latest deployed orchestrator.
// - A small random jitter staggers the displays so they don't all blank at once.
// - If a match happens to be on screen at 4am (rare), the reload waits until it's
//   over — callers pass an isLive() guard.
//
// Usage:
//   scheduleDailyReload({ isLive: () => liveMode !== 'none' });  // office
//   scheduleDailyReload({ isLive: () => liveMode });             // foundry-1
//   scheduleDailyReload();                                       // foundry-2/3
(function (global) {
  function msUntilNext4amAEST() {
    // Seconds-of-day in Sydney right now (DST-aware via Intl); time until 04:00.
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Australia/Sydney', hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date()).reduce((o, p) => ((o[p.type] = p.value), o), {});
    const secsNow = (+parts.hour) * 3600 + (+parts.minute) * 60 + (+parts.second);
    let delta = 4 * 3600 - secsNow;       // seconds until 04:00 Sydney
    if (delta <= 0) delta += 24 * 3600;   // already past 4am → tomorrow
    // (delta may be ±1h on a DST changeover day, but those are Apr/Oct — outside
    //  the Jun–Jul tournament — and an hour's drift on the reload time is harmless.)
    return delta * 1000;
  }

  global.scheduleDailyReload = function (opts) {
    const isLive = (opts && opts.isLive) || (() => false);
    const jitter = Math.floor(Math.random() * 120000); // 0–2 min so displays stagger
    setTimeout(function tryReload() {
      if (isLive()) { setTimeout(tryReload, 10 * 60 * 1000); return; } // don't cut a live match
      location.reload();
    }, msUntilNext4amAEST() + jitter);
  };
})(window);
