// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

// Clock and date formatting, including the session-list date range.
// Fragment of the in-page script - see README.md in this folder.

  // Month before day, and the year only when it is not the current one (agentPlusKit.stamp): the session list and the
  // work plan tree write dates this way, and a different order here would let 01/10 mean two different days.
  var fmt = function(ms){ return agentPlusKit.stamp(ms); };
  // Session list: absolute dates next to the compact relative time. On window because the call site
  // lives in the official component code, outside this closure. Pure ASCII source, no encoding risk.
  try {
    var MID = String.fromCharCode(183);
    window.__cceSpan = function(rel, last, created, id, relOf){
      /* A pinned conversation whose files were given a later time shows when it was really last active, in the panel's
         own relative form, whether or not the dates are on: the time the list was given is not one anybody chose. */
      var real = realTime(id, last);
      if (real !== null) {
        last = real;
        if (typeof relOf === 'function') { try { rel = relOf(real); } catch (e) { /* keep the panel's own text */ } }
      }
      /* Called from the official component, so returning what it passed in leaves its own text untouched. */
      if (isOff('sessionDates')) return rel;
      // the year is written only when it is not the current one, and only once per range (agentPlusKit.span)
      var body = agentPlusKit.span(created, last);
      return body ? rel + ' ' + MID + ' ' + body : rel;
    };
  } catch (e) {}
