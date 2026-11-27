/* PayStamp app code (v4.3). Loaded by the home page only when it is needed:
   straight away for someone signed in on this device, otherwise once the home page is ready. */
/* PayStamp logo: a tilted rubber stamp with a P, matching the STAMP button. */
window.payStampLogo = function (size) {
  var span = document.createElement('span');
  span.className = 'ps-logo';
  span.style.width = size + 'px';
  span.style.height = size + 'px';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML =
    '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><g transform="rotate(-10 24 24)">' +
    '<circle cx="24" cy="24" r="21.5" fill="none" stroke="#7E2A55" stroke-width="3"/>' +
    '<circle cx="24" cy="24" r="16.5" fill="none" stroke="#7E2A55" stroke-width="1.4" stroke-dasharray="2.4 2.2"/>' +
    '<text x="24" y="31.5" text-anchor="middle" font-family="Besley, Georgia, serif" font-size="22" fill="#7E2A55">P</text>' +
    '</g></svg>';
  return span;
};

;
/* =====================================================================
   1) YOUR SUPABASE KEYS
   Supabase dashboard → Project Settings → API. Paste the Project URL and
   the "anon public" key below. (The anon key is safe to publish — the
   database rules in supabase-setup.sql stop anyone reading others' data.)
   ===================================================================== */
var SUPABASE_URL = 'https://oyrumnbxadhcqsdfqnkj.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_8Ti3vzyfY0cOOSedUd0nUg_SAOupy49';
// v4: PayStamp Pro through Stripe (Managed Payments: Stripe sells it for you as "Onelink" and handles VAT).
// The two LIVE Stripe payment links (real payments). Test versions, for trying things out with card 4242 4242 4242 4242:
//   monthly https://buy.stripe.com/test_8x214n9wna4P96DePF6Vq00   yearly https://buy.stripe.com/test_bJe28raAra4P2IfdLB6Vq01
// If a link is empty, the Subscribe button says payments aren't set up yet. (Trials still work.)
var STRIPE_LINK_MONTH = 'https://buy.stripe.com/8x214n9wna4P96DePF6Vq00';
var STRIPE_LINK_YEAR = 'https://buy.stripe.com/bJe28raAra4P2IfdLB6Vq01';
// Where people manage or cancel: Stripe's Onelink account page (they sign in with the email they paid with).
var STRIPE_MANAGE = 'https://app.link.com';

;
/* =====================================================================
   2) ACCOUNTS + SAVING  (talks to Supabase, then hands data to the planner)
   ===================================================================== */
(function () {
  'use strict';

  // Only these parts of the planner are saved. Things like "which menu is
  // open" are not. Month/year aren't saved either, so each visit opens on
  // the current month. 'v' records which version last updated the data.
  // The planner lists what it saves (window.PlannerApp.savedKeys); 'v' is added here.
  // Things like "which menu is open" are never saved.
  function savedKeys() { return ((window.PlannerApp && window.PlannerApp.savedKeys) || []).concat(['v']); }

  // Invite links look like paystamp.co.uk/?invite=CODE. Keep the code until the
  // visitor has an account, then link them to whoever invited them.
  var INVITE_KEY = 'paystamp-invite';
  (function () {
    var m = /[?&]invite=([A-Za-z0-9]{4,12})/.exec(window.location.search);
    if (!m) return;
    try { localStorage.setItem(INVITE_KEY, m[1].toUpperCase()); } catch (e) {}
    try { history.replaceState(null, '', window.location.pathname + window.location.hash); } catch (e) {}
  })();
  function storedInvite() { try { return localStorage.getItem(INVITE_KEY) || ''; } catch (e) { return ''; } }

  var configured = /^https:\/\//.test(SUPABASE_URL) && SUPABASE_ANON_KEY.indexOf('PASTE_') !== 0;
  var sb = configured && window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
  // v4.3: the home page shows how many founding places are left (a count only; needs the v4.3 database update)
  if (sb) sb.rpc('founder_places_left').then(function (r) { if (r && !r.error && window.psFounderPlaces) window.psFounderPlaces(Number(r.data)); }, function () {});

  var authEl = document.getElementById('auth');
  var appEl = document.getElementById('app');
  var statusEl = document.getElementById('save-status');
  var landingEl = document.getElementById('landing');

  var user = null;
  var pro = null; // v4: { trial_started_at, status, plan, pro_until, paid } from get_my_pro()
  var owner = false;   // set from the database (is_paystamp_owner), never from an email written in this page
  function refreshApp(msg) { try { if (window.PlannerApp && window.PlannerApp.refresh) window.PlannerApp.refresh(msg); } catch (e) {} }
  function pollPro(n) {
    rpc('get_my_pro').then(function (p) { pro = p; if (p && p.paid) refreshApp('Welcome to PayStamp Pro. Thank you for supporting PayStamp.'); else if (n < 12) setTimeout(function () { pollPro(n + 1); }, 3000); }, function () {});
  }
  var demoMode = false;
  var plannerStarted = false;
  var lastSaved = null;
  var saveTimer = null;
  var saving = false;
  var pendingSnapshot = null;

  /* ---------- v4: offline ----------
     A copy of the plan is kept on this device (localStorage, one per account), so PayStamp opens
     with no signal. Changes are written here first, then sent to the account when there's a connection.
     serverAt is the time of the account's copy that this device last saw: if the account has been
     changed since (on another device), PayStamp asks which version to keep instead of overwriting it. */
  var serverAt = null;
  // v4.3: serverData is the account's copy as this device last saw it (kept with the device copy as 'baseData').
  // When two devices both changed the plan, it shows what each one changed, so both sets of changes can be kept.
  var serverData = null;
  function localKey(id) { return 'ps_plan_' + id; }
  function readLocal(id) { try { var v = localStorage.getItem(localKey(id)); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function writeLocal(id, o) {
    if (o && o.baseData === undefined && serverData) o.baseData = serverData;
    try { localStorage.setItem(localKey(id), JSON.stringify(o)); return true; }
    catch (e) { try { delete o.baseData; localStorage.setItem(localKey(id), JSON.stringify(o)); return true; } catch (e2) { return false; } }   // too big for the device: keep the plan, drop the base
  }
  /* v4.3: combine changes made on two devices instead of asking which to keep.
     base = the account's copy both started from, mine = this device, theirs = the account now.
     Whatever only one side changed is kept. Lists of things with ids (lines, months, goals…) are combined item by item.
     Only when both changed the very same value differently does the newest change win. */
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function idOf(x) { return isObj(x) ? (x.id != null ? 'i:' + x.id : x.key != null ? 'k:' + x.key : null) : null; }   // lines and months have an id, planner sections a key
  function idList(a) { if (!Array.isArray(a) || !a.length) return false; var seen = {}; return a.every(function (x) { var i = idOf(x); if (i === null || seen[i]) return false; seen[i] = 1; return true; }); }
  function merge3(base, mine, theirs, mineWins) {
    if (same(mine, theirs)) return mine;
    if (same(base, mine)) return theirs;
    if (same(base, theirs)) return mine;
    if (isObj(mine) && isObj(theirs) && (base === undefined || base === null || isObj(base))) {
      var b = base || {}, out = {}, keys = {};
      Object.keys(mine).concat(Object.keys(theirs)).forEach(function (k) { keys[k] = 1; });
      Object.keys(keys).forEach(function (k) { var v = merge3(b[k], mine[k], theirs[k], mineWins); if (v !== undefined) out[k] = v; });
      return out;
    }
    if (Array.isArray(mine) && Array.isArray(theirs) && (idList(mine) || !mine.length) && (idList(theirs) || !theirs.length) && (base == null || idList(base) || (Array.isArray(base) && !base.length))) {
      var find = function (arr, id) { for (var i = 0; arr && i < arr.length; i++) if (idOf(arr[i]) === id) return arr[i]; return undefined; };
      var first = mineWins ? mine : theirs, second = mineWins ? theirs : mine, res = [], seen = {};
      first.concat(second).forEach(function (x) {
        var id = idOf(x); if (seen[id]) return; seen[id] = 1;
        var bi = find(base, id), mi = find(mine, id), ti = find(theirs, id);
        if (mi && ti) { res.push(merge3(bi, mi, ti, mineWins)); return; }
        var only = mi || ti;
        if (!bi) { res.push(only); return; }            // added on one device: keep it
        if (!same(bi, only)) res.push(only);            // removed on one device but changed on the other: keep the change
      });
      return res;
    }
    return mineWins ? mine : theirs;
  }
  function readPro(id) { try { var v = localStorage.getItem('ps_pro_' + id); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function writePro(id, p) { try { localStorage.setItem('ps_pro_' + id, JSON.stringify(p)); } catch (e) {} }
  function clearLocal() { try { Object.keys(localStorage).forEach(function (k) { if (/^ps_(plan|pro)_/.test(k)) localStorage.removeItem(k); }); } catch (e) {} }
  function netFail(err) { return navigator.onLine === false || !err || /fetch|network|load failed|timeout|offline/i.test(String((err && (err.message || err.details)) || err)); }
  function soon(p, ms, fallback) { return Promise.race([Promise.resolve(p).catch(function (e) { return { error: e || { message: 'network' } }; }), new Promise(function (r) { setTimeout(function () { r(fallback); }, ms); })]); }
  // The signed-in account saved in this browser, for opening PayStamp offline when the sign-in can't be refreshed.
  function storedUser() {
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (/^sb-.*-auth-token$/.test(k)) { var s = JSON.parse(localStorage.getItem(k)); var u = s && (s.user || (s.currentSession && s.currentSession.user)); if (u && u.id) return u; } } } catch (e) {}
    return null;
  }
  var conflictEl = null;
  function showConflict(at, snap) {
    if (conflictEl) return;
    var when = function (t) { var dt = new Date(t); return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' at ' + dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };
    var loc = readLocal(user.id) || {};
    var newestHere = editedAt(loc) > new Date(at).getTime();
    try { localStorage.setItem('ps_plan_premerge_' + user.id, JSON.stringify({ at: Date.now(), device: snap })); } catch (e) {}
    conflictEl = document.createElement('div'); conflictEl.className = 'sc-back';
    conflictEl.innerHTML = '<div class="sc" role="dialog" aria-modal="true" aria-label="Which version should PayStamp keep?"><h2>Which version should PayStamp keep?</h2>' +
      '<p class="sc-sub">Your plan was changed on another device (' + when(at) + ') while this device had changes it hadn’t sent yet' + (editedAt(loc) ? ' (' + when(editedAt(loc)) + ')' : '') + '.</p>' +
      '<p class="sc-sub">' + (newestHere ? 'This device has the newest changes.' : 'Your other device has the newest changes.') + ' Not sure? Choose the newest.</p>' +
      '<div class="sc-btns"><button type="button" class="' + (newestHere ? 'sc-no' : 'sc-go') + '" data-v="account">Use my other device’s plan' + (newestHere ? '' : ' (newest)') + '</button><button type="button" class="' + (newestHere ? 'sc-go' : 'sc-no') + '" data-v="device">Keep this device’s plan' + (newestHere ? ' (newest)' : '') + '</button></div></div>';
    document.body.appendChild(conflictEl);
    conflictEl.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-v]'); if (!b) return;
      b.disabled = true;
      if (b.getAttribute('data-v') === 'device') { conflictEl.remove(); conflictEl = null; serverAt = at; pendingSnapshot = pendingSnapshot || snap; saving = false; flushSave(); return; }
      sb.from('planners').select('data, updated_at').eq('user_id', user.id).maybeSingle().then(function (res) {
        if (res.error || !res.data) { b.disabled = false; b.textContent = 'Couldn’t reach your account. Try again'; return; }
        pendingSnapshot = null; clearTimeout(saveTimer); serverData = res.data.data;
        writeLocal(user.id, { data: res.data.data, dirty: false, at: Date.now(), base: res.data.updated_at, baseData: res.data.data });
        window.location.reload();
      });
    });
  }
  // v4.3: the plan was changed on another device while this one had changes of its own. Fetch the account's copy,
  // combine the two, show the result here and save it. Nothing is asked and nothing is lost.
  function combineWithAccount(snap, retry) {
    var base = serverData || (readLocal(user.id) || {}).baseData;
    saving = true; setStatus('saving', 'Adding changes from your other device…');
    sb.from('planners').select('data, updated_at').eq('user_id', user.id).maybeSingle().then(function (res) {
      saving = false;
      if (res.error || !res.data) { retry(res.error); return; }
      if (!base) { pendingSnapshot = pendingSnapshot || snap; setStatus('error', 'Choose which version to keep'); showConflict(res.data.updated_at, snap); return; }   // older copy on this device with no base: ask once
      var mine = pendingSnapshot || snap, theirs = res.data.data || {};
      var loc = readLocal(user.id) || {}, mineWins = editedAt(loc) > new Date(res.data.updated_at).getTime();
      try { localStorage.setItem('ps_plan_premerge_' + user.id, JSON.stringify({ at: Date.now(), device: mine, account: theirs })); } catch (e) {}   // a safety copy of both, just in case
      var merged = merge3(base, mine, theirs, mineWins);
      serverAt = res.data.updated_at; serverData = theirs; pendingSnapshot = null; lastSaved = null;
      if (window.PlannerApp && window.PlannerApp.replaceSaved) window.PlannerApp.replaceSaved(merged, 'Your plan now has the changes from both of your devices.');
      else { writeLocal(user.id, { data: merged, dirty: true, at: Date.now(), base: serverAt, baseData: theirs }); window.location.reload(); return; }
      if (!pendingSnapshot) { pendingSnapshot = merged; writeLocal(user.id, { data: merged, dirty: true, at: Date.now(), base: serverAt }); }
      clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 300);
    }, function (e) { saving = false; retry(e); });
  }
  window.addEventListener('online', function () { if (pendingSnapshot && user) { clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 800); } });
  window.addEventListener('offline', function () { if (user && !demoMode) setStatus('offline', pendingSnapshot ? 'Offline: saved on this device' : 'Offline: your plan is on this device'); });

  /* ---------- save status pill ---------- */
  function setStatus(kind, text) {
    statusEl.hidden = false;
    statusEl.className = kind || '';
    statusEl.querySelector('.label').textContent = text;
  }

  /* ---------- saving ---------- */
  function snapshot(state) {
    var out = {};
    savedKeys().forEach(function (k) { if (state[k] !== undefined) out[k] = state[k]; });
    return out;
  }

  /* v4.3.1: when this device's plan was really last changed by the person (typing, tapping), not by PayStamp tidying
     things up as it opens. Used to decide which side is newest when two devices disagree. */
  var lastUserAct = 0, bootLocalAt = null;
  ['input', 'change', 'click'].forEach(function (ev) { document.addEventListener(ev, function (e) {
    var t = e.target; if (!e.isTrusted || !t || !t.closest || t.closest('.sc-back')) return;
    if (ev === 'click' && !t.closest('#app button')) return;   // a tap on a button in the planner, not a scroll or a tap on the page
    lastUserAct = Date.now(); }, true); });
  function editedAt(loc) { return Math.max(lastUserAct || 0, (loc && loc.edited) || 0) || bootLocalAt || 0; }
  function queueSave(state) {
    if (demoMode || !user) return;
    var snap = snapshot(state);
    var json = JSON.stringify(snap);
    if (json === lastSaved) return;          // nothing that matters changed
    pendingSnapshot = snap;
    writeLocal(user.id, { data: snap, dirty: true, at: Date.now(), base: serverAt, edited: editedAt(readLocal(user.id)) });
    if (navigator.onLine === false) { setStatus('offline', 'Offline: saved on this device'); clearTimeout(saveTimer); return; }
    setStatus('saving', 'Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 700);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    if (!pendingSnapshot || !user || saving) return;
    if (conflictEl) return;
    if (navigator.onLine === false) { setStatus('offline', 'Offline: saved on this device'); return; }
    var snap = pendingSnapshot;
    var json = JSON.stringify(snap), stamp = new Date().toISOString();
    pendingSnapshot = null;
    saving = true;
    var retry = function (err) {
      saving = false;
      pendingSnapshot = pendingSnapshot || snap;   // keep it so we retry
      if (netFail(err)) setStatus('offline', 'Offline: saved on this device'); else setStatus('error', "Couldn't save — retrying…");
      clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, navigator.onLine === false ? 20000 : 5000);
    };
    // First check the account hasn't been changed on another device since this one last saw it.
    sb.from('planners').select('updated_at').eq('user_id', user.id).maybeSingle().then(function (chk) {
      if (chk.error) { retry(chk.error); return; }
      var at = chk.data && chk.data.updated_at;
      if (at && serverAt && new Date(at).getTime() > new Date(serverAt).getTime() + 1000) { saving = false; pendingSnapshot = pendingSnapshot || snap; combineWithAccount(snap, retry); return; }
      sb.from('planners').upsert({ user_id: user.id, data: snap, updated_at: stamp }).then(function (res) {
        if (res.error) { retry(res.error); return; }
        saving = false;
        serverAt = stamp; serverData = snap; lastSaved = json;
        writeLocal(user.id, pendingSnapshot ? { data: pendingSnapshot, dirty: true, at: Date.now(), base: serverAt } : { data: snap, dirty: false, at: Date.now(), base: serverAt });
        if (pendingSnapshot) { flushSave(); } else { setStatus('', 'All changes saved'); }
      }, retry);
    }, retry);
  }

  window.addEventListener('beforeunload', function (e) {
    if (pendingSnapshot || saving) { flushSave(); e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushSave();
  });

  /* ---------- loading a user's planner ---------- */
  // v4.1: anonymous home-page counts (page shown, builder steps, sign-up). No account, no device storage, no personal data.
  var visitSeen = {};
  function logVisit(name, detail) {
    try {
      if (!sb || user || navigator.doNotTrack === '1' || isLocalHost()) return;
      var key = name + '|' + (detail || ''); if (visitSeen[key]) return; visitSeen[key] = 1;
      sb.from('ps_visits').insert({ name: String(name).slice(0, 40), detail: detail == null ? null : String(detail).slice(0, 60), wide: window.innerWidth > 820 }).then(function () {}, function () {});
    } catch (e) {}
  }
  // v4.3: the home page's button counts: send what's waiting, then send new ones straight away
  (function () { var q = window.psTapQ || []; window.psTap = function (d) { logVisit('tap', d); }; q.forEach(function (d) { logVisit('tap', d); }); })();
  function isLocalHost() { return /^(localhost|127\.|0\.0\.0\.0)/.test(location.hostname); }
  function showLanding() {
    logVisit('home', document.referrer && document.referrer.indexOf(location.host) < 0 ? (function () { try { return new URL(document.referrer).hostname; } catch (e) { return 'other'; } })() : null);
    authEl.hidden = true;
    appEl.hidden = true;
    landingEl.hidden = false;
  }

  function openPlanner(initialData) {
    landingEl.hidden = true;
    authEl.hidden = true;
    appEl.hidden = false;
    if (!plannerStarted) {
      plannerStarted = true;
      window.PlannerApp.start(initialData);
    }
  }

  /* ---------- founder profile (the Founding 100) ----------
     The numbers live in the 'profiles' table and are only ever changed by the
     database functions in supabase-v3.sql, so nobody can give themselves a number. */
  function founderFrom(p, old) {
    old = old || {};
    if (!p) return Object.assign({ number: null, name: '', elite: false, eliteNumber: null, joined: 0, code: '', placesLeft: 0, eliteTaken: 0 }, old);
    return {
      number: p.founder_number || null,
      since: p.founder_since || old.since || '',
      name: old.name || '',
      elite: !!p.elite_number,
      eliteNumber: p.elite_number || null,
      joined: p.joined || 0,
      code: p.invite_code || '',
      placesLeft: Math.max(0, p.places_left || 0),
      eliteTaken: p.elite_taken || 0,
    };
  }
  function rpc(name, args) {
    return sb.rpc(name, args || {}).then(function (res) { if (res.error) throw res.error; return res.data; });
  }
  function linkInvite(u) {
    var code = storedInvite() || (u.user_metadata && u.user_metadata.invite) || '';
    if (!code) return Promise.resolve();
    return rpc('set_inviter', { code: code }).catch(function () {}).then(function () {
      try { localStorage.removeItem(INVITE_KEY); } catch (e) {}
    });
  }

  function loadForUser(u) {
    user = u;
    owner = false;
    rpc('is_paystamp_owner').then(function (v) { if (v === true && user && user.id === u.id) { owner = true; refreshApp(); } }, function () {});
    renderAuth('loading');
    var profile = linkInvite(u).then(function () { return rpc('get_my_profile'); }).catch(function () { return null; });
    var local = readLocal(u.id), wait = local ? 4000 : 20000;
    if (local && bootLocalAt == null) bootLocalAt = local.edited || 0;
    var planner = soon(sb.from('planners').select('data, updated_at').eq('user_id', u.id).maybeSingle(), wait, { timedOut: true });
    var proReq = soon(rpc('get_my_pro').catch(function () { return null; }), wait, null);
    profile = soon(profile, wait, null);
    Promise.all([planner, profile, proReq]).then(function (out) {
      var res = out[0], prof = out[1]; pro = out[2] || readPro(u.id); if (out[2]) writePro(u.id, out[2]);
      var reached = res && !res.timedOut && !res.error;
      if (!reached && local) {
        // No connection (or a very slow one): open the copy on this device. Changes wait here until there's signal.
        serverAt = local.base || null; serverData = local.baseData || (local.dirty ? null : local.data);
        if (local.dirty) pendingSnapshot = local.data;
        local.data.founder = founderFrom(prof, local.data.founder);
        setStatus('offline', local.dirty ? 'Offline: saved on this device' : 'Offline: your plan is on this device');
        openPlanner(local.data);
        if (local.dirty) { clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 3000); }
        return;
      }
      if (!reached && res && (res.timedOut || netFail(res.error))) { renderAuth('signin', { error: 'You’re offline, and this device doesn’t have a copy of your plan yet. Connect to the internet once to open it here.' }); return; }
      if (reached && local && local.dirty) {
        // This device has changes that never reached the account. Open them and send them (asking first if the account changed meanwhile).
        serverAt = local.base || (res.data && res.data.updated_at) || null; pendingSnapshot = local.data; serverData = local.baseData || null;
        local.data.founder = founderFrom(prof, local.data.founder);
        setStatus('saving', 'Sending changes made offline…');
        openPlanner(local.data);
        clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 1200);
        return;
      }
      if (reached && res.data) { serverAt = res.data.updated_at || null; serverData = res.data.data; writeLocal(u.id, { data: res.data.data, dirty: false, at: Date.now(), base: serverAt, baseData: res.data.data }); }
      // Back from Stripe's checkout: keep checking until the payment is recorded.
      if (/[?&]pro=thanks/.test(window.location.search)) { try { history.replaceState(null, '', window.location.pathname); } catch (e) {} if (!(pro && pro.paid)) setTimeout(function () { pollPro(0); }, 1500); else setTimeout(function () { refreshApp('Welcome to PayStamp Pro. Thank you for supporting PayStamp.'); }, 800); }
      if (res.error) {
        renderAuth('signin', { error: "We couldn't load your planner (" + res.error.message + '). Check the database setup, then refresh.' });
        return;
      }
      var saved = res.data && res.data.data;
      if (saved) {
        lastSaved = JSON.stringify(snapshot(saved));
        saved.founder = founderFrom(prof, saved.founder);
        setStatus('', 'All changes saved');
        // v3.7: a plan built on the home page opens ready to compare with this account's planner
        var qd = window.PSQuick && window.PSQuick.readDraft(); if (qd) saved.qsDraft = qd;
        openPlanner(saved);
      } else {
        // Brand-new account: use the plan built on the home page, or open the quick start.
        setStatus('', 'Welcome — your changes save automatically');
        var qn = window.PSQuick && window.PSQuick.readDraft();
        openPlanner(qn ? { qsNew: qn, founder: founderFrom(prof) } : { qsOpen: true, founder: founderFrom(prof) });
      }
    });
  }

  /* ---------- the login / sign-up screen ---------- */
  function friendlyError(err) {
    var m = (err && err.message) || 'Something went wrong. Please try again.';
    if (/invalid login credentials/i.test(m)) return 'That email and password don’t match an account.';
    if (/email not confirmed/i.test(m)) return 'Please confirm your email first — check your inbox for the link we sent.';
    if (/already registered/i.test(m)) return 'There’s already an account with that email. Try signing in instead.';
    if (/password should be at least/i.test(m)) return 'Your password needs to be at least 6 characters.';
    return m;
  }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function field(id, label, type, autocomplete) {
    var input = el('input', { id: id, name: id, type: type, required: '', autocomplete: autocomplete });
    if (type !== 'password') return el('div', { class: 'auth-field' }, [el('label', { for: id, text: label }), input]);
    input.setAttribute('minlength', '6');
    // Show / hide, so a typo can be spotted before submitting. Left out of the Tab order so Tab goes straight to the next box.
    var eye = el('button', { type: 'button', class: 'auth-eye', 'aria-label': 'Show password', 'aria-pressed': 'false', tabindex: '-1', title: 'Show password' });
    eye.innerHTML = '<svg class="eye-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'
      + '<svg class="eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/></svg>';
    eye.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep the caret in the box
    eye.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.setAttribute('aria-pressed', String(show));
      eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      eye.title = show ? 'Hide password' : 'Show password';
    });
    return el('div', { class: 'auth-field' }, [el('label', { for: id, text: label }), el('div', { class: 'auth-pass' }, [input, eye])]);
  }

  function renderAuth(mode, opts) {
    if (mode === 'signup' || mode === 'signin') logVisit(mode + '_open');
    opts = opts || {};
    if (!landingEl.hidden) window.scrollTo(0, 0);
    landingEl.hidden = true;
    authEl.hidden = false;
    appEl.hidden = true;
    var card = el('div', { class: 'auth-card' });
    card.appendChild(el('div', { class: 'auth-logo' }, [window.payStampLogo(56)]));
    card.appendChild(el('div', { class: 'auth-brand', text: 'PayStamp' }));
    card.appendChild(el('div', { class: 'auth-tagline', text: 'Monthly Planner' }));
    card.appendChild(el('div', { class: 'auth-rule' }));

    if (mode === 'loading') {
      card.appendChild(el('div', { class: 'auth-loading', text: 'Opening your planner…' }));
      authEl.replaceChildren(card);
      return;
    }

    var subs = {
      signin: 'Welcome back. Sign in to pick up your plan where you left it.',
      signup: 'Create a free account so your plan is saved and ready every month.',
      reset: 'Enter your email and we’ll send you a link to reset your password.',
      newpass: 'Choose a new password for your account.',
    };
    card.appendChild(el('p', { class: 'auth-sub', text: subs[mode] }));

    if (!configured) {
      card.appendChild(el('div', { class: 'auth-msg info', text: 'Accounts aren’t switched on yet: add your Supabase URL and anon key near the top of this file. You can still try the planner without saving.' }));
    }

    if (mode === 'signin' || mode === 'signup') {
      var tabs = el('div', { class: 'auth-tabs', role: 'tablist' });
      [['signin', 'Sign in'], ['signup', 'Create account']].forEach(function (t) {
        var b = el('button', { type: 'button', class: 'auth-tab', role: 'tab', 'aria-selected': String(mode === t[0]), text: t[1] });
        b.addEventListener('click', function () { renderAuth(t[0]); });
        tabs.appendChild(b);
      });
      card.appendChild(tabs);
    }

    if (opts.error) card.appendChild(el('div', { class: 'auth-msg error', text: opts.error }));
    if (opts.ok) card.appendChild(el('div', { class: 'auth-msg ok', text: opts.ok }));

    var form = el('form', { novalidate: '' });
    if (mode !== 'newpass') form.appendChild(field('email', 'Email', 'email', 'email'));
    if (mode === 'signin') form.appendChild(field('password', 'Password', 'password', 'current-password'));
    if (mode === 'signup' || mode === 'newpass') {
      form.appendChild(field('password', mode === 'newpass' ? 'New password (6+ characters)' : 'Password (6+ characters)', 'password', 'new-password'));
      form.appendChild(field('password2', mode === 'newpass' ? 'Type the new password again' : 'Type the password again', 'password', 'new-password'));
    }
    if (opts.email && form.querySelector('#email')) form.querySelector('#email').value = opts.email;

    var labels = { signin: 'Sign in', signup: 'Create account', reset: 'Send reset link', newpass: 'Save new password' };
    var submit = el('button', { type: 'submit', class: 'auth-submit', text: labels[mode] });
    if (!configured) submit.disabled = true;
    form.appendChild(submit);
    card.appendChild(form);

    var foot = el('div', { class: 'auth-foot' });
    if (mode === 'signin') {
      var forgot = el('button', { type: 'button', class: 'auth-link', text: 'Forgot your password?' });
      forgot.addEventListener('click', function () { renderAuth('reset', { email: form.querySelector('#email').value }); });
      foot.appendChild(forgot);
    } else if (mode === 'reset') {
      var back = el('button', { type: 'button', class: 'auth-link', text: '← Back to sign in' });
      back.addEventListener('click', function () { renderAuth('signin'); });
      foot.appendChild(back);
    }
    if (mode === 'signin' || mode === 'signup') {
      var home = el('button', { type: 'button', class: 'auth-link', text: '← Back to the PayStamp home page' });
      home.addEventListener('click', showLanding);
      foot.appendChild(home);
    }
    if (mode === 'signup') {
      var pv = el('p', { class: 'auth-sub', style: 'margin:12px 0 0;font-size:12.5px' });
      pv.append('Other users can never see your plan. ');
      var pa = el('a', { href: '/privacy.html', target: '_blank', rel: 'noopener', text: 'How PayStamp handles your data', style: 'color:#7E2A55;font-weight:600' });
      pv.append(pa);
      foot.appendChild(pv);
    }
    if (foot.childNodes.length) card.appendChild(foot);

    if (!configured) {
      var demo = el('button', { type: 'button', class: 'auth-demo', text: 'Try it without an account (nothing is saved)' });
      demo.addEventListener('click', function () {
        demoMode = true;
        setStatus('demo', 'Demo mode — changes aren’t saved');
        var qd2 = window.PSQuick && window.PSQuick.readDraft();
        openPlanner(qd2 ? { qsNew: qd2 } : { qsOpen: true });
      });
      card.appendChild(demo);
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!configured) return;
      var email = form.querySelector('#email') ? form.querySelector('#email').value.trim() : '';
      var password = form.querySelector('#password') ? form.querySelector('#password').value : '';
      if (mode !== 'newpass' && !/^\S+@\S+\.\S+$/.test(email)) { renderAuth(mode, { error: 'Please enter a valid email address.', email: email }); return; }
      if ((mode === 'signin' || mode === 'signup' || mode === 'newpass') && password.length < 6) { renderAuth(mode, { error: 'Your password needs to be at least 6 characters.', email: email }); return; }
      if ((mode === 'signup' || mode === 'newpass') && password !== form.querySelector('#password2').value) { renderAuth(mode, { error: 'The two passwords don’t match. Please type them again.', email: email }); return; }
      submit.disabled = true;
      submit.textContent = 'Please wait…';

      var here = window.location.origin + window.location.pathname;
      if (mode === 'signin') {
        sb.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
          if (res.error) renderAuth('signin', { error: friendlyError(res.error), email: email });
          // success is handled by onAuthStateChange below
        });
      } else if (mode === 'signup') {
        logVisit('signup_try');
        sb.auth.signUp({ email: email, password: password, options: { emailRedirectTo: here, data: storedInvite() ? { invite: storedInvite() } : {} } }).then(function (res) {
          if (res.error) { renderAuth('signup', { error: friendlyError(res.error), email: email }); return; }
          logVisit('signup_done');
          if (!res.data.session) {
            renderAuth('signin', { ok: 'Nearly there! We’ve emailed a confirmation link to ' + email + '. Click it, then sign in here.', email: email });
          }
        });
      } else if (mode === 'reset') {
        sb.auth.resetPasswordForEmail(email, { redirectTo: here }).then(function (res) {
          if (res.error) renderAuth('reset', { error: friendlyError(res.error), email: email });
          else renderAuth('signin', { ok: 'If there’s an account for ' + email + ', a reset link is on its way.', email: email });
        });
      } else if (mode === 'newpass') {
        sb.auth.updateUser({ password: password }).then(function (res) {
          if (res.error) { renderAuth('newpass', { error: friendlyError(res.error) }); return; }
          loadForUser(res.data.user);
        });
      }
    });

    authEl.replaceChildren(card);
    var first = card.querySelector('input');
    if (first && !first.value) first.focus();
  }

  /* ---------- what the planner can ask of us ---------- */
  var authOpenedByVisitor = false;
  window.PayStampAuth = { open: function (mode) { authOpenedByVisitor = true; renderAuth(mode === 'signup' ? 'signup' : 'signin'); } };

  window.PayStamp = {
    onChange: queueSave,
    logVisit: logVisit,
    getEmail: function () { return user ? user.email : (demoMode ? 'Demo mode' : ''); },
    // The first real stamped month asks the database for the next founder number.
    // Resolves with the updated founder details (number is null if all 100 are taken).
    claimFounder: function (since) {
      if (demoMode || !user) return Promise.resolve(null);
      return rpc('claim_founder', { since: since }).then(function (p) { return founderFrom(p, {}); });
    },
    // Suggestions and bug reports go to the 'feedback' table (Table Editor → feedback).
    sendFeedback: function (f) {
      if (demoMode || !user) return Promise.resolve();
      return sb.from('feedback').insert({
        user_id: user.id, email: user.email, kind: f.kind, area: f.area, message: f.message,
        contact_ok: !!f.contactOk, founder_number: f.founder || null, month: f.month,
        user_agent: String(f.userAgent || '').slice(0, 300), screen: f.screen,
      }).then(function (res) { if (res.error) throw res.error; });
    },
    // v3.5: delete everything for this account (planner, profile, sign-in), then go to the home page.
    deleteAccount: function () {
      if (demoMode || !user) return Promise.reject(new Error('Not signed in'));
      clearTimeout(saveTimer); pendingSnapshot = null;
      return rpc('delete_my_account').then(function () {
        user = null;
        try { Object.keys(localStorage).forEach(function (k) { if (/^sb-/.test(k) || /^ps_(plan|pro)_/.test(k) || k === INVITE_KEY) localStorage.removeItem(k); }); } catch (e) {}
        return sb.auth.signOut().catch(function () {});
      }).then(function () { window.location.replace(window.location.pathname + '?deleted=1'); });
    },
    // v3.5: the admin page. The database checks it's really the owner; this just decides whether to show the menu item.
    // v3.4: Shape PayStamp answers, one row per account (updated if sent again).
    saveAnswers: function (answers) {
      if (demoMode || !user) return Promise.resolve();
      return sb.from('direct_answers').upsert({ user_id: user.id, answers: answers, updated_at: new Date().toISOString() }).then(function (res) { if (res.error) throw res.error; });
    },
    // v3.4: send the monthly email to yourself now, to see what it looks like.
    sendTestEmail: function (kind) {
      if (demoMode || !user) return Promise.reject(new Error('Sign in first'));
      flushSave();
      return new Promise(function (r) { setTimeout(r, 900); }).then(function () { return rpc(kind === 'mid' ? 'send_my_mid_now' : 'send_my_digest_now'); });
    },
    isOwner: function () { return !!(user && owner); },
    adminOverview: function () { return rpc('admin_overview'); },
    adminSetStatus: function (id, status) { return rpc('admin_set_feedback_status', { fid: id, new_status: status }); },
    // v4: the usage log (table ps_events). Page names and actions only, never amounts. Sent in batches.
    logEvent: (function () {
      var q = [], t = null;
      function flush() {
        clearTimeout(t); t = null;
        if (!q.length) return;
        if (demoMode || !user || !sb) { q = []; return; }
        var rows = q.splice(0, 50);
        sb.from('ps_events').insert(rows).then(function () {}, function () {});
        if (q.length) t = setTimeout(flush, 1000);
      }
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
      return function (name, page, detail) {
        if (demoMode || !user || !sb) return;
        q.push({ user_id: user.id, name: String(name).slice(0, 40), page: page ? String(page).slice(0, 80) : null, detail: detail ? String(detail).slice(0, 80) : null });
        if (q.length >= 20) flush(); else if (!t) t = setTimeout(flush, 8000);
      };
    })(),
    adminUsage: function (days) { return rpc('admin_usage', { days: days }); },
    adminUsageMore: function (days) { return rpc('admin_usage_more', { days: days }); },
    // v4: Couples planner (supabase-v4.0-couples.sql)
    couple: {
      get: function () { return rpc('couple_get'); },
      start: function (name) { return rpc('couple_start', { my_name: name || null }); },
      join: function (code, name, pay, shared) { return rpc('couple_join', { join_code: code, my_name: name || null, my_pay: pay || null, my_shared: shared || null }); },
      save: function (shared, version, name, pay) { return rpc('couple_save', { new_shared: shared, at_version: version, my_name: name || null, my_pay: pay || null }); },
      leave: function () { return rpc('couple_leave'); }
    },
    // v4: PayStamp Pro
    isPro: function () { return !!(pro && (pro.paid || (pro.status && pro.pro_until && new Date(pro.pro_until) > new Date()))); },
    trialStartedAt: function () { return (pro && pro.trial_started_at) || null; },
    startTrial: function () { return rpc('start_pro_trial').then(function (p) { pro = p; return p; }); },
    // Opens Stripe's checkout. The account id goes with it (client_reference_id) so the payment lands on this account.
    // Returns false if the payment links haven't been filled in yet.
    startCheckout: function (plan) {
      var url = plan === 'month' ? STRIPE_LINK_MONTH : STRIPE_LINK_YEAR;
      if (!url || !user) return false;
      flushSave();
      url += (url.indexOf('?') > -1 ? '&' : '?') + 'client_reference_id=' + encodeURIComponent(user.id) + (user.email ? '&prefilled_email=' + encodeURIComponent(user.email) : '');
      setTimeout(function () { window.location.href = url; }, saving ? 700 : 0);
      return true;
    },
    // Stripe's Onelink page for changing card or cancelling (they sign in with the email they paid with).
    manageBilling: function () { if (!STRIPE_MANAGE) return false; window.open(STRIPE_MANAGE, '_blank', 'noopener'); return true; },
    signOut: function () {
      if (demoMode || !sb) { window.location.reload(); return; }
      flushSave();
      setTimeout(function () {
        sb.auth.signOut().then(function () { clearLocal(); window.location.reload(); }, function () { clearLocal(); window.location.reload(); });
      }, saving ? 800 : 0);
    },
  };

  /* ---------- v4.3: keep every open PayStamp on the newest version ----------
     An old page left open after an update could save in the old way and muddle shared data (Couples).
     Each open page checks the app version now and then (when you come back to the tab, and every 10 minutes).
     If PayStamp has been updated, it saves what you've done and refreshes once onto the new version. */
  var APP_BUILD = 'paystamp-app-4.3.1';
  var reloading = false;
  function appRefresh(why) {
    if (reloading) return; reloading = true;
    try { if (sessionStorage.getItem('ps_reloaded_for') === why) { reloading = false; return; } sessionStorage.setItem('ps_reloaded_for', why); } catch (e) {}
    try { flushSave(); } catch (e) {}
    var note = document.createElement('div'); note.className = 'app-upd'; note.setAttribute('role', 'status');
    note.textContent = 'PayStamp has been updated. Saving and refreshing…'; document.body.appendChild(note);
    setTimeout(function () { window.location.reload(); }, 2200);
  }
  function checkVersion() {
    if (reloading || location.protocol !== 'https:') return;
    fetch('/sw.js', { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (txt) {
      var m = /var CACHE = '([^']+)'/.exec(txt || ''); if (!m || m[1] === APP_BUILD) return;
      var a = document.activeElement;
      if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { setTimeout(checkVersion, 20000); return; }   // wait until you've finished typing
      appRefresh(m[1]);
    }, function () {});
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') checkVersion(); });
  setInterval(checkVersion, 10 * 60 * 1000);
  window.PayStampAppRefresh = appRefresh;

  /* ---------- boot ---------- */
  if (!sb) { showLanding(); return; }

  // v4.1: open straight away from the copy on this device. Signing in and fetching the account can take a long
  // time with no (or a weak) signal, so the plan opens first and the account is checked quietly afterwards.
  // If the account was changed on another device in the meantime, PayStamp switches to that version.
  var fastId = null, fastStop = false;   // fastStop: only set when a different account signs in
  (function () {
    var su = storedUser(), sl = su && readLocal(su.id);
    if (!su || !sl || !sl.data || /type=recovery|[?&](pro|deleted)=/.test(window.location.href)) return;
    // a copy saved before 4.3.1 doesn't know when it was really edited, so the account counts as newest
    fastId = su.id; user = su; bootLocalAt = sl.edited || 0; serverAt = sl.base || null; serverData = sl.baseData || (sl.dirty ? null : sl.data); pro = readPro(su.id);
    if (sl.dirty) pendingSnapshot = sl.data;
    // the planner's own script comes later in the page, so open once the page has read it
    var go1 = function () { if (fastStop || plannerStarted) return;   // v4.1.1: still opens if the sign-in check finished first
      setStatus(navigator.onLine === false ? 'offline' : '', navigator.onLine === false ? (sl.dirty ? 'Offline: saved on this device' : 'Offline: your plan is on this device') : 'Checking for changes…');
      openPlanner(sl.data); };
    if (window.PlannerApp) go1(); else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go1); else setTimeout(go1, 0);
  })();
  function checkFresh(u) {
    user = u;
    rpc('is_paystamp_owner').then(function (v) { if (v === true && user && user.id === u.id) { owner = true; refreshApp(); } }, function () {});
    rpc('get_my_pro').then(function (p) { if (p) { pro = p; writePro(u.id, p); refreshApp(); } }, function () {});
    sb.from('planners').select('data, updated_at').eq('user_id', u.id).maybeSingle().then(function (res) {
      if (res.error) { setStatus('offline', pendingSnapshot ? 'Offline: saved on this device' : 'Offline: your plan is on this device'); return; }
      var at = res.data && res.data.updated_at, loc = readLocal(u.id) || {};
      var newer = at && (!serverAt || new Date(at).getTime() > new Date(serverAt).getTime() + 1000);
      if (newer && !loc.dirty && !pendingSnapshot) {
        // changed on another device and nothing new here: use the account's version
        writeLocal(u.id, { data: res.data.data, dirty: false, at: Date.now(), base: at, baseData: res.data.data });
        window.location.reload(); return;
      }
      if (pendingSnapshot) { clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 1200); }   // flushSave asks which to keep if both changed
      else setStatus('', 'All changes saved');
    }, function () { setStatus('offline', 'Offline: your plan is on this device'); });
  }

  var recovering = /type=recovery/.test(window.location.hash);
  sb.auth.onAuthStateChange(function (event, session) {
    // Run outside the callback so Supabase isn't blocked while we query.
    setTimeout(function () {
      if (event === 'PASSWORD_RECOVERY') { recovering = true; user = session && session.user; renderAuth('newpass'); return; }
      if (recovering) return;
      if (session && session.user) {
        if (fastId && session.user.id === fastId) { fastId = null; checkFresh(session.user); return; }
        if (fastId && session.user.id !== fastId) { fastId = null; fastStop = true; window.location.reload(); return; }
        if (!user || user.id !== session.user.id) loadForUser(session.user);
      } else if (event === 'INITIAL_SESSION' && !user && storedUser() && readLocal(storedUser().id)) {
        // Signed in on this device, but the sign-in couldn't be refreshed (no signal): open the copy on this device.
        loadForUser(storedUser());
      } else if (fastId && event === 'INITIAL_SESSION') {
        // no signal to refresh the sign-in: stay on the copy that's already open
        setStatus('offline', pendingSnapshot ? 'Offline: saved on this device' : 'Offline: your plan is on this device');
      } else if (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') {
        user = null;
        if (!plannerStarted && !authOpenedByVisitor) showLanding();
      }
    }, 0);
  });
})();

;
/* =====================================================================
   PAYSTAMP v3 — MONTHLY PLANNER
   Same hooks as v1: window.PlannerApp.start(data) and window.PayStamp.onChange(state),
   so this block can replace section 3 of the live index.html unchanged.
   ===================================================================== */
(function () {
  'use strict';

  var state = {};
  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var SAVED_KEYS = ['groups','locations','targets','aims','notes','records','recExpanded','debts','debtOrder','debtCustomOrder','debtExtras','savings','savingOrder','savingCustomOrder','savingExtras','savingUsed','investments','investExtras','investUsed','seenWhatsNew','seenPages','founder','milestones','realStamped','efundStarter','efundMain','efGoal','efMonths','debtBudget','drafts','valsMonth','currency','sent','folded','isExample','exampleHidden','recMonths','recOpen','recIncOpen','setupDone','payday','payRule','links','cpProg','sinking','direct','creditTarget','creditChecked','invBroker','autoCheck','potMove','credit','cardShort','pensions','statePension','penMatchChecked','listBanks','listDebts','listGoals','listCosts','listSinking','listCards','listPensions','emailPrefs','emailDigest','cpHide','startHidden','startFolded','invCompare','saveCompare','costReview','cpReview','sinkPlan','multiCur','fxRates','fxRatesAt','yearShareHidden','paydayBannerHidden','appNudgeHidden','appInstalled','invWif','saveWif','debtWifs','efCompare','creditSteps','costRemind','efBannerHidden','checkups','invCalc','cpCalc','cpDebt','invCountPension','penMonthly','pctBase','pctCustom','recOrder','qsPlan','ovYears','couple','hustles','efRateChecked','netRateChecked','debtRateAsked','proTrial','trialEndSeen','pnyFree','insRange','proPlan','noUsageLog','sideCols','debtFree','firstCol','reviewDone'];

  function uid(p) { return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /* ---------- example data ---------- */
  function defaultGroups() {
    var I = function (id, label, t, b) { return { id: id, label: label, target: t, budgeted: b, account: '', runs: '', due: '', automated: false }; };
    var B = function (id, label, t, b, acc) { return { id: id, label: label, target: t, budgeted: b, account: acc, runs: '', due: '', automated: true }; };
    return [
      { key: 'income', title: 'Income', color: '#7E2A55', categories: [
        { id: 'cat_income', name: 'Job', items: [Object.assign(I('i1', 'Salary', '1900', '2050'), { payDay: '28' })] } ] },
      { key: 'investSavings', title: 'Investments & Savings', color: '#1E6B47', categories: [
        { id: 'cat_invest', name: 'Investments', items: [Object.assign(B('inv_iv1', 'Stocks & Shares ISA', '173', '173', 'Barclays'), { investmentId: 'iv1' })] },
        { id: 'cat_savings', name: 'Savings', items: [Object.assign(B('sav_sv1', 'Emergency fund', '40', '140', 'Monzo'), { savingId: 'sv1' }), Object.assign(B('sav_sv2', 'New laptop', '15', '15', 'Monzo'), { savingId: 'sv2' })] } ] },
      { key: 'costs', title: 'Costs', color: '#9A3A30', categories: [
        { id: 'cat_fixed', name: 'Fixed costs', items: [Object.assign(B('f1', 'Rent', '650', '650', 'Barclays'), { payDay: '1' }), Object.assign(B('f2', 'Phone & utilities', '95', '95', 'Monzo'), { payDay: '12' }), B('a1', 'Groceries', '220', '250', 'Monzo'), B('a2', 'Transport', '65', '65', 'Monzo')] },
        { id: 'cat_subscriptions', name: 'Subscriptions', items: [Object.assign(B('sub1', 'Gym', '25', '25', 'Monzo'), { payDay: '30' }), Object.assign(B('sub2', 'Spotify', '11', '11', 'Monzo'), { payDay: '15' })] } ] },
      { key: 'guiltFree', title: 'Fun', color: '#245F8C', categories: [
        { id: 'cat_guilt', name: 'Fun', items: [B('g1', 'Eating out', '300', '300', 'Monzo'), B('g2', 'Shopping', '156', '156', 'Monzo')] } ] },
    ];
  }
  function defaultAims() {
    return [
      { id: 'cat_invest', label: 'Investments', recommended: '10%+', aimPct: '10', reached: false, source: 'cat:cat_invest' },
      { id: 'cat_savings', label: 'Savings', recommended: '5-10%', aimPct: '7', reached: false, source: 'cat:cat_savings' },
      { id: 'cat_fixed', label: 'Costs', recommended: '50-60%', aimPct: '55', reached: false, source: 'group:costs' },
      { id: 'guiltFree', label: 'Fun', recommended: '25-35%', aimPct: '30', reached: false, source: 'group:guiltFree' },
    ];
  }

  function defaultInvestments() {
    return [
      { id: 'iv1', name: 'Stocks & Shares ISA', type: 'isa', before: '4200', value: '5150', valueBase: '4200', monthly: '173' },
      { id: 'iv2', name: 'Lifetime ISA', type: 'lisa', before: '1800', value: '2010', valueBase: '1800', monthly: '' },
      { id: 'iv3', name: 'Workplace pension', type: 'pension', before: '8600', value: '9840', valueBase: '8600', monthly: '' } ];
  }
  function defaultSavings() {
    return [
      { id: 'sv1', name: 'Emergency fund', goal: '3000', saved: '1200', aer: '4.1', monthly: '40' },
      { id: 'sv2', name: 'New laptop', goal: '600', saved: '90', aer: '3.0', monthly: '15' },
      { id: 'sv3', name: 'Holiday', goal: '1500', saved: '250', aer: '3.5', monthly: '' },
      { id: 'sv4', name: 'House deposit', goal: '15000', saved: '2400', aer: '4.5', monthly: '' } ];
  }
  function defaultDebts() {
    return [
      { id: 'debt1', name: 'Credit card', balance: '2400', apr: '29.9', min: '72', monthly: '150' },
      { id: 'debt2', name: 'Car finance', balance: '4800', apr: '7.9', min: '180', monthly: '' },
      { id: 'debt3', name: 'Overdraft', balance: '650', apr: '39.9', min: '20', monthly: '' },
      { id: 'debt4', name: 'Store card', balance: '320', apr: '19.9', min: '15', monthly: '' },
      { id: 'debt5', name: 'Personal loan', balance: '1100', apr: '12.9', min: '85', monthly: '' } ];
  }

  /* Bring v1 data up to v2 shape (safe to run on every start). */
  function migrate() {
    // People who already have a plan (from v2) start with empty Debt, Savings and Investments lists,
    // so no example items are added to their real planner. New people get the full example.
    var existingPlan = !!state.groups;
    if (existingPlan) ['debts', 'savings', 'investments'].forEach(function (k) { if (!state[k]) state[k] = []; });
    if (!state.groups) { state.groups = defaultGroups(); state.isExample = true; }
    state.groups.forEach(function (g) { g.color = freshCol(g.color); }); dropOldExtras();
    // v4.3: "Guilt-free spending" is now called "Fun" (planner, its category, the % aims and old records)
    state.groups.forEach(function (g) { if (g.title === 'Guilt-free spending') g.title = 'Fun'; (g.categories || []).forEach(function (c) { if (c.name === 'Guilt-free spending') c.name = 'Fun'; }); });
    (state.aims || []).forEach(function (a) { if (a && a.label === 'Guilt-free spending') a.label = 'Fun'; });
    (state.records || []).forEach(function (r) { (r.items || []).forEach(function (x) { if (x.groupTitle === 'Guilt-free spending') x.groupTitle = 'Fun'; if (x.categoryName === 'Guilt-free spending') x.categoryName = 'Fun'; }); });
    if (!state.locations) state.locations = [{ id: 'loc1', name: 'Monzo', day: '2', how: 'auto' }, { id: 'loc2', name: 'Barclays', day: '1', payIn: true }];
    if (!state.targets) state.targets = [
      { id: 't1', label: 'Emergency fund at 1000', doing: false, done: false },
      { id: 't2', label: 'Pay off Debt', doing: true, done: false },
      { id: 't3', label: 'Paying into an ISA', doing: false, done: true } ];
    if (!state.notes) state.notes = [{ id: 'n1', text: 'Focus on clearing debt!' }];
    if (!state.records) state.records = [];
    if (!state.aims) state.aims = defaultAims();
    if (!state.founder || state.founder.view) state.founder = { number: null, name: '', elite: false, eliteNumber: null, joined: 0, code: 'P' + Math.random().toString(36).slice(2, 7).toUpperCase(), placesLeft: 63, eliteTaken: 4 };
    // debts: [{ id, name, balance, apr, min, monthly }], kept in the order the user sets.
    if (!state.debtExtras) state.debtExtras = [];
    if (!state.investExtras) state.investExtras = [];
    if (!state.investUsed) state.investUsed = [];
    // investments: [{ id, name, before, value, valueBase, monthly }]
    //   before = invested before PayStamp; value = what the provider showed when last typed in;
    //   valueBase = amount invested at that moment, so later stamped contributions are added on top.
    if (!state.investments) state.investments = defaultInvestments();
    state.investments.forEach(function (iv) { if (iv.isa === undefined) iv.isa = iv.type ? iv.type === 'isa' : /stocks.*shares.*isa|s&s isa/i.test(iv.name || ''); });
    if (!state.milestones) state.milestones = {};
    if (!state.links) state.links = [];
    if (!state.payRule) state.payRule = { mode: 'date', weekendBefore: true };
    // Payday: taken from the salary line, or the account your pay goes into, the first time.
    if (state.payday === undefined) {
      var salLine = (findGroup('income') || { categories: [] }).categories.reduce(function (a, c) { return a.concat(c.items); }, []).filter(function (it) { return it.payDay; })[0];
      var payLoc = (state.locations || []).filter(function (l) { return l.payIn && l.day; })[0];
      state.payday = salLine ? String(salLine.payDay) : payLoc ? String(payLoc.day) : '';
    }
    if (state.efundStarter === undefined) state.efundStarter = existingPlan ? '' : 'sv1';
    if (state.efundMain === undefined) state.efundMain = '';
    if (!state.savingExtras) state.savingExtras = [];
    if (!state.savingUsed) state.savingUsed = [];  // [{ id, savingId, amount, date, note }]
    // savings: [{ id, name, goal, saved, aer, monthly }]; saved = what was in the pot when added.
    if (!state.savings) state.savings = defaultSavings();
    var freshDebts = !state.debts;
    if (!state.debts) state.debts = defaultDebts();
    state.aims = state.aims.map(function (a) {
      a = Object.assign({}, a);
      if (a.id === 'cat_fixed' && (!a.label || /fixed costs/i.test(a.label))) a.label = 'Costs';
      if (a.source === undefined) {
        if (a.id === 'cat_fixed') a.source = 'group:costs';
        else if (findCat(a.id)) a.source = 'cat:' + a.id;
        else if (findGroup(a.id)) a.source = 'group:' + a.id;
        else a.source = '';
      }
      return a;
    });
  }

  /* ---------- lookups ---------- */
  function findGroup(key) { return (state.groups || []).find(function (g) { return g.key === key; }); }
  function findCat(id) {
    for (var g of state.groups || []) for (var c of g.categories) if (c.id === id) return c;
    return null;
  }
  function findItem(id) {
    for (var g of state.groups) for (var c of g.categories) {
      var idx = c.items.findIndex(function (it) { return it.id === id; });
      if (idx > -1) return { g: g, c: c, idx: idx, item: c.items[idx] };
    }
    return null;
  }

  /* ---------- numbers ---------- */
  function amt(s) { if (!s) return 0; var n = parseFloat(String(s).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; }
  function fmt(n) {
    var r = Math.round(n * 100) / 100, abs = Math.abs(r), whole = Math.abs(abs - Math.round(abs)) < 0.001;
    return (r < 0 ? '-' : '') + abs.toLocaleString('en-GB', whole ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function money(n) { return (n < 0 ? '-£' : '£') + fmt(Math.abs(n)); }
  function pct(a, total) { return total ? Math.round(a / total * 100) + '%' : '0%'; }
  function lighten(hex, r) {
    var h = hex.replace('#', ''), c = [0, 2, 4].map(function (i) { return parseInt(h.substr(i, 2), 16); });
    return 'rgb(' + c.map(function (v) { return Math.round(v + (255 - v) * r); }).join(',') + ')';
  }
  function sumItems(items, f) { return items.reduce(function (a, it) { return a + (f === 'first' ? firstVal(it) : amt(it[f])) * (it && it.account !== undefined ? itemRate(it) : 1); }, 0); }
  /* v4.3: the first column shows Budgeted, or what you stamped last month (Tools › the Budgeted / Last month button).
     Last month is your most recent stamped month before the one the planner is on. It can't be typed over here. */
  function plannerIdx() { return Number(state.year || new Date().getFullYear()) * 12 + MONTHS.indexOf(state.month || MONTHS[new Date().getMonth()]); }
  // v4.3: "Last month" is the month before the one the planner is on, exactly as the planner shows that month:
  // what you stamped (or changes you'd made to it), and Budgeted for any line that wasn't in it.
  function prevMonth() { var i = plannerIdx() - 1; return { month: MONTHS[((i % 12) + 12) % 12], year: String(Math.floor(i / 12)) }; }
  function lastRecord() { var pm = prevMonth(); return (state.records || []).filter(function (r) { return r.month === pm.month && String(r.year) === pm.year; })[0] || null; }
  function lastMode() { return state.firstCol === 'last'; }
  function lastVal(it) { var pm = prevMonth(); return monthValFor(it, pm.month, pm.year); }
  // One line's amount for a month, the way the planner shows it when you go to that month.
  function monthValFor(it, month, year, depth) {
    var key = month + ' ' + year, dr = (state.drafts || {})[key];
    if (dr && dr.vals && dr.vals[it.id] != null) return Number(dr.vals[it.id]) || 0;
    var rec = (state.records || []).filter(function (r) { return r.month === month && String(r.year) === String(year); })[0];
    if (rec) {
      var items = rec.items || [], hit = items.filter(function (x) { return x.id === it.id; });
      if (!hit.length) hit = items.filter(function (x) { return (it.debtId && x.debtId === it.debtId) || (it.savingId && x.savingId === it.savingId) || (it.investmentId && x.investmentId === it.investmentId) || (it.coupleId && x.coupleId === it.coupleId); });
      if (!hit.length) { var f = findItem(it.id), cn = f && f.c ? String(f.c.name || '').toLowerCase() : null, nm = String(it.label || '').trim().toLowerCase();
        if (nm) hit = items.filter(function (x) { return String(x.name || '').trim().toLowerCase() === nm && (cn == null || String(x.categoryName || '').toLowerCase() === cn); }); }
      if (hit.length) return hit.reduce(function (a, x) { return a + recAmt(x); }, 0);
      return amt(it.target);
    }
    // v4.3: with Last month on, a month that hasn't been filled in starts the same as the month before it
    if (lastMode() && (depth || 0) < 24 && monthTouched(month, year, depth)) {
      var i = Number(year) * 12 + MONTHS.indexOf(month) - 1;
      return monthValFor(it, MONTHS[((i % 12) + 12) % 12], String(Math.floor(i / 12)), (depth || 0) + 1);
    }
    return amt(it.target);
  }
  // Is there anything (a stamp or changes) in an earlier month to copy from?
  function monthTouched(month, year) {
    var k = Number(year) * 12 + MONTHS.indexOf(month), d = state.drafts || {};
    return (state.records || []).some(function (r) { return Number(r.year) * 12 + MONTHS.indexOf(r.month) < k; }) || Object.keys(d).some(function (key) { var p = key.split(' '); return Number(p[1]) * 12 + MONTHS.indexOf(p[0]) < k; });
  }

  function firstVal(it) { if (!lastMode()) return amt(it.target); var v = lastVal(it); return v == null ? 0 : v; }
  // v4.3: column titles use month names: Budget (or last month's name) | this month's name
  function firstLabel(isIncome) { return lastMode() ? prevMonth().month : 'Budget'; }
  function monthLabel() { return state.month || MONTHS[new Date().getMonth()]; }
  function catSum(c, f) { return sumItems(c.items, f); }
  function groupSum(g, f) { return g.categories.reduce(function (a, c) { return a + catSum(c, f); }, 0); }

  function totals() {
    var income = 0, incomeExpected = 0, allocated = 0, target = 0, byLoc = {}, unassigned = 0;
    state.groups.forEach(function (g) {
      if (g.key === 'income') { income += groupSum(g, 'budgeted'); incomeExpected += groupSum(g, 'target'); return; }
      allocated += groupSum(g, 'budgeted'); target += groupSum(g, 'target');
      g.categories.forEach(function (c) { c.items.forEach(function (it) {
        var v = amt(it.budgeted); // each bank's total stays in that bank's own currency
        if (it.account) byLoc[it.account] = (byLoc[it.account] || 0) + v; else unassigned += v;
      }); });
    });
    return { income: income, incomeExpected: incomeExpected, allocated: allocated, target: target, byLoc: byLoc, unassigned: unassigned, zero: Math.round((income - allocated) * 100) / 100 };
  }

  /* ---------- saving + rendering ---------- */
  function save() { if (window.PayStamp && window.PayStamp.onChange) window.PayStamp.onChange(state); }
  function commit() { syncCouple(); syncHustle(); syncLinkedItems(); histNote(); cpQueuePush(); save(); scheduleRender(); }
  function set(patch) { Object.assign(state, patch); commit(); }

  // A click that blurs an input used to rebuild the page mid-click, which is
  // why you needed to click twice. Now a rebuild waits until the pointer is
  // released, and focus (plus the caret) is put back where you clicked.
  var shown = {};
  var pointerDown = false, renderPending = false, drag = null, dragEndedAt = 0;
  document.addEventListener('pointerdown', function () { pointerDown = true; }, true);
  function release() { pointerDown = false; if (renderPending) setTimeout(function () { if (renderPending) render(); }, 0); }
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  // Native select popups can swallow the pointerup, so a select change always counts as released.
  document.addEventListener('change', function (e) { if (e.target.tagName === 'SELECT') pointerDown = false; }, true);
  function scheduleRender() { if (!state.groups) return; if (pointerDown || drag) { renderPending = true; return; } render(); }

  function render() {
    renderPending = false;
    var root = document.getElementById('app');
    var ae = document.activeElement, key = ae && ae.dataset ? ae.dataset.k : null, draft = null, s0 = null, s1 = null;
    if (key) { draft = ae.value; try { s0 = ae.selectionStart; s1 = ae.selectionEnd; } catch (e) {} }
    var ov = root.querySelector('.overlay'), ovTop = ov ? ov.scrollTop : 0, y = window.scrollY;
    shown.overlayEnter = !!state.overlay && state.overlay !== shown.overlay;
    shown.menuEnter = !!state.openMenu && state.openMenu !== shown.menu;
    var before = {};
    root.querySelectorAll('.flip-group [data-row-id]').forEach(function (el) { before[el.dataset.rowId] = el.getBoundingClientRect().top; });
    root.replaceChildren(buildApp());
    shown.overlay = state.overlay; shown.menu = state.openMenu;
    // The header stamp plays its stamping animation once: on the first render after the welcome closes.
    if (state.stampAnim && state.overlay !== 'founderWelcome') state.stampAnim = false;
    if (state.animStamps && state.overlay !== 'newStamps' && state.overlay !== 'founderWelcome') state.animStamps = null;
    root.querySelectorAll('[data-qr]').forEach(function (el) { drawQR(el, el.dataset.qr); });
    window.scrollTo(0, y);
    var ov2 = root.querySelector('.overlay'); if (ov2) ov2.scrollTop = ovTop;
    // Rows that changed place slide from where they were to where they are now.
    if (!drag && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      root.querySelectorAll('.flip-group [data-row-id]').forEach(function (el) {
        var b = before[el.dataset.rowId]; if (b == null) return;
        var dy = b - el.getBoundingClientRect().top;
        if (Math.abs(dy) > 1 && el.animate) {
          el.style.position = 'relative'; el.style.zIndex = '1';
          el.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' })
            .onfinish = function () { el.style.zIndex = ''; };
        }
      });
    }
    if (key) {
      var n = root.querySelector('[data-k="' + CSS.escape(key) + '"]');
      if (n) {
        if (draft != null && 'value' in n && n.tagName !== 'SELECT') n.value = draft;
        n.focus({ preventScroll: true });
        if (s0 != null && n.setSelectionRange) try { n.setSelectionRange(s0, s1); } catch (e) {}
      }
    }
  }

  /* ---------- DOM helpers ---------- */
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]; if (v == null || v === false) return;
      if (k === 'text') el.textContent = curText(v);
      else if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c != null) el.append(curText(c)); });
    return el;
  }
  function field(key, value, onCommit, o) {
    o = o || {};
    var el = h('input', { type: 'text', class: o.cls || 'cell', 'data-k': key, placeholder: o.ph, inputmode: o.num ? 'decimal' : null, 'aria-label': o.label, id: 'f-' + key });
    el.value = value == null ? '' : value;
    if (o.money) { if (el.placeholder === '0') el.placeholder = cur() + '0'; el.dataset.raw = el.value; el.value = moneyShow(el.value); el.addEventListener('focus', function () { if (el.value !== el.dataset.raw) { el.value = el.dataset.raw; setTimeout(function () { if (document.activeElement === el) el.select(); }, 0); } }); el.addEventListener('blur', function () { el.value = el.dataset.sym ? (String(el.dataset.raw).trim() === '' ? '' : el.dataset.sym + fmt(amt(el.dataset.raw))) : moneyShow(el.dataset.raw); }); }
    el.addEventListener('change', function () { if (o.money) { el.dataset.raw = moneyRaw(el.value); onCommit(el.dataset.raw); } else onCommit(el.value); });
    el.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var nk = el.closest('[data-row-id]') ? sameBoxInNextRow(el, tabScope(el), e.shiftKey) : null;
      if (nk) { e.preventDefault(); focusKeyAfterSave(el, nk); } else el.blur();
    });
    return el;
  }
  function btn(cls, label, onClick, kids, extra) {
    return h('button', Object.assign({ type: 'button', class: cls, 'aria-label': label, onclick: onClick }, extra || {}), kids);
  }
  var GRIP = '<svg viewBox="0 0 10 16" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.5"/><circle cx="7.5" cy="3" r="1.5"/><circle cx="2.5" cy="8" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/><circle cx="2.5" cy="13" r="1.5"/><circle cx="7.5" cy="13" r="1.5"/></g></svg>';
  var CHECK = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* ---------- drag and drop (mouse + touch) ---------- */
  function startDrag(e, kind) {
    if (e.button != null && e.button !== 0) return;
    var row = e.currentTarget.closest('[data-row-id]'); if (!row) return;
    e.preventDefault();
    try { window.getSelection().removeAllRanges(); } catch (err) {}
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    var r = row.getBoundingClientRect();
    var ghost = row.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.cssText += ';width:' + r.width + 'px;left:' + r.left + 'px;top:' + r.top + 'px;';
    document.body.append(ghost);
    row.classList.add('drag-source');
    document.body.classList.add('dragging');
    drag = { kind: kind, id: row.dataset.rowId, row: row, ghost: ghost, dx: e.clientX - r.left, dy: e.clientY - r.top, x: e.clientX, y: e.clientY };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragEnd);
    drag.raf = requestAnimationFrame(autoScroll);
  }
  function onDragMove(e) {
    if (!drag) return;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.ghost.style.left = (drag.x - drag.dx) + 'px';
    drag.ghost.style.top = (drag.y - drag.dy) + 'px';
    placeRow();
  }
  function placeRow() {
    var el = document.elementFromPoint(drag.x, drag.y); if (!el) return;
    var sel = '[data-drop-kind="' + drag.kind + '"]';
    var list = el.closest(sel);
    if (!list) { var blk = el.closest('[data-drop-block="' + drag.kind + '"]'); if (blk) list = blk.querySelector(sel); }
    if (!list) return;
    var rows = Array.prototype.filter.call(list.children, function (c) { return c.dataset.rowId && c !== drag.row; });
    var before = null;
    for (var i = 0; i < rows.length; i++) { var b = rows[i].getBoundingClientRect(); if (drag.y < b.top + b.height / 2) { before = rows[i]; break; } }
    if (before) { if (drag.row.nextElementSibling !== before) list.insertBefore(drag.row, before); }
    else if (list.lastElementChild !== drag.row) list.append(drag.row);
  }
  function autoScroll() {
    if (!drag) return;
    var edge = 70, speed = 0;
    if (drag.y < edge) speed = -Math.ceil((edge - drag.y) / 5);
    else if (drag.y > innerHeight - edge) speed = Math.ceil((drag.y - (innerHeight - edge)) / 5);
    if (speed) {
      var ov = document.querySelector('.overlay');
      if (ov) ov.scrollTop += speed; else window.scrollBy(0, speed);
      placeRow();
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }
  function onDragEnd() {
    if (!drag) return;
    var d = drag; drag = null;
    cancelAnimationFrame(d.raf);
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragEnd);
    d.ghost.remove(); d.row.classList.remove('drag-source'); document.body.classList.remove('dragging');
    dragEndedAt = Date.now();
    var list = d.row.parentNode;
    var index = Array.prototype.filter.call(list.children, function (c) { return c.dataset.rowId; }).indexOf(d.row);
    if (d.kind === 'item') moveItem(d.id, list.dataset.listId, index);
    if (d.kind === 'cat-inc' || d.kind === 'cat-out') moveCat(d.id, list.dataset.listId, index);
    if (d.kind === 'cpl') cpMoveLine(d.id, list.dataset.listId, index);
    if (d.kind === 'cplcat') cpMoveCat(d.id.slice(4), index, list.dataset.listId);
    if (d.kind === 'target') moveInList(state.targets, d.id, index);
    if (d.kind === 'debt') { moveInList(state.debts, d.id, index); debtMovedByHand(); }
    if (d.kind === 'saving') { moveInList(state.savings, d.id, index); savingMovedByHand(); }
    if (d.kind === 'investment') moveInList(state.investments, d.id, index);
    commit();
  }
  function moveItem(id, catId, index) {
    var src = findItem(id), dst = findCat(catId); if (!src || !dst) return;
    src.c.items.splice(src.idx, 1);
    dst.items.splice(Math.max(0, Math.min(index, dst.items.length)), 0, src.item);
  }
  function moveCat(id, gkey, index) {
    var f = findCat(id), g = findGroup(gkey); if (!f || !g) return;
    state.groups.forEach(function (gg) { var i = gg.categories.indexOf(f); if (i > -1) gg.categories.splice(i, 1); });
    g.categories.splice(Math.max(0, Math.min(index, g.categories.length)), 0, f);
  }
  function catKeyMove(e, g, c) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    var i = g.categories.indexOf(c), ni = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (ni < 0 || ni >= g.categories.length) return;
    g.categories.splice(i, 1); g.categories.splice(ni, 0, c); commit();
    var n = document.querySelector('[data-cgrip="' + c.id + '"]'); if (n) n.focus();
  }
  function moveInList(list, id, index) {
    var i = list.findIndex(function (x) { return x.id === id; }); if (i < 0) return;
    var x = list.splice(i, 1)[0]; list.splice(index, 0, x);
  }
  // Keyboard: focus a grip and use the arrow keys (moves across categories at the edges).
  function itemKeyMove(e, id) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    var dir = e.key === 'ArrowUp' ? -1 : 1, src = findItem(id);
    var cats = []; state.groups.forEach(function (g) { g.categories.forEach(function (c) { cats.push(c); }); });
    var ci = cats.indexOf(src.c), ni = src.idx + dir;
    if (ni >= 0 && ni < src.c.items.length) moveItem(id, src.c.id, ni);
    else if (cats[ci + dir]) moveItem(id, cats[ci + dir].id, dir > 0 ? 0 : cats[ci + dir].items.length);
    else return;
    commit();
    var n = document.querySelector('[data-grip="' + id + '"]'); if (n) n.focus();
  }

  function ordinal(n) { n = Number(n); var t = n % 100; return n + (t > 10 && t < 14 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'); }
  // A day-of-month picker ("2nd"), used for payment dates and location transfer dates.
  function daySelect(key, value, onChange, cls, label) {
    var opts = [h('option', { value: '', text: '–' })];
    for (var d = 1; d <= 31; d++) opts.push(h('option', { value: String(d), text: ordinal(d) }));
    opts.push(h('option', { value: 'last', text: 'Last day' }));
    var sel = h('select', { class: 'day-select ' + (cls || '') + (value ? '' : ' is-empty'), 'data-k': key, id: key, 'aria-label': label, title: label, onchange: function (e) { onChange(e.target.value); } }, opts);
    sel.value = value || '';
    return sel;
  }

  /* ---------- v3.4: your name and payday ----------
     The name is the same one used on invites (state.founder.name), so it only needs typing once.
     state.payday is a day of the month ('1'–'31' or 'last'). */
  function userName() { return ((state.founder && state.founder.name) || '').trim(); }
  function setUserName(v) { state.founder.name = String(v || '').trim().slice(0, 24); commit(); }
  /* ---------- v3.5: how you're paid ----------
     state.payRule = { mode, weekendBefore, nth, dow, every, anchor }
       mode 'date'    : state.payday ('1'–'31' or 'last') every month
       mode 'weekday' : the nth ('1'–'4' or 'last') dow (0–6, or 'work' = working day) of the month
       mode 'repeat'  : every 7, 14 or 28 days from anchor ('YYYY-MM-DD')
       mode 'varies'  : no countdown; payments are added to This Pay as they land
     weekendBefore moves a Saturday or Sunday payday back to the Friday (date and repeat only). */
  var DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function payRule() { return state.payRule || { mode: 'date', weekendBefore: true }; }
  function today0() { var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function parseYmd(v) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function backToFriday(d) { var w = d.getDay(); return w === 6 ? new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1) : w === 0 ? new Date(d.getFullYear(), d.getMonth(), d.getDate() - 2) : d; }
  function isWork(d) { var w = d.getDay(); return w > 0 && w < 6; }
  // The payday that a rule gives in a particular month (null if the rule isn't monthly).
  function payDateIn(r, y, m) {
    var last = new Date(y, m + 1, 0).getDate(), d;
    if (r.mode === 'date') {
      var pd = r.day !== undefined ? r.day : state.payday;
      if (!pd) return null;
      d = new Date(y, m, pd === 'last' ? last : Math.min(Number(pd), last));
      return r.weekendBefore ? backToFriday(d) : d;
    }
    if (r.mode === 'weekday') {
      var nth = r.nth || 'last', dow = r.dow == null ? 4 : r.dow, hits = [];
      for (var i = 1; i <= last; i++) { var x = new Date(y, m, i); if (dow === 'work' ? isWork(x) : x.getDay() === Number(dow)) hits.push(x); }
      return nth === 'last' ? hits[hits.length - 1] : hits[Math.min(Number(nth), hits.length) - 1];
    }
    return null;
  }
  function nextPayDate(rule) {
    var r = rule || payRule(), t = today0();
    if (r.mode === 'varies') return null;
    if (r.mode === 'repeat') {
      var a = parseYmd(r.anchor), step = Number(r.every) || 14; if (!a) return null;
      var d = new Date(a);
      if (d < t) { var k = Math.ceil((t - d) / 86400000 / step); d = new Date(a.getFullYear(), a.getMonth(), a.getDate() + k * step); }
      // a payday moved back from a weekend can land before today while the real cycle date is still ahead
      var shown = r.weekendBefore ? backToFriday(d) : d;
      if (shown < t) { d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + step); shown = r.weekendBefore ? backToFriday(d) : d; }
      return shown;
    }
    var p = payDateIn(r, t.getFullYear(), t.getMonth());
    if (!p) return null;
    if (p < t) p = payDateIn(r, t.getFullYear(), t.getMonth() + 1);
    return p;
  }
  function daysToPayday() { var d = nextPayDate(); return d ? Math.round((d - today0()) / 86400000) : null; }
  function shortDate(d) { return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3); }
  function paydayText() {
    var r = payRule();
    if (r.mode === 'varies') return '';
    var d = nextPayDate(), n = daysToPayday(); if (!d) return '';
    if (n === 0) return 'It’s payday';
    if (n === 1) return 'Payday tomorrow';
    if (r.mode === 'date') return 'Payday in ' + n + ' days';
    return (r.mode === 'repeat' ? 'Next pay ' : 'Payday ') + shortDate(d);
  }
  function payRuleText(rule) {
    var r = rule || payRule(), pd = r.day !== undefined ? r.day : state.payday;
    if (r.mode === 'varies') return 'It varies';
    if (r.mode === 'repeat') return 'Every ' + ({ 7: 'week', 14: '2 weeks', 28: '4 weeks' }[r.every] || '2 weeks');
    if (r.mode === 'weekday') return (r.nth === 'last' || !r.nth ? 'Last ' : ordinal(r.nth) + ' ') + (r.dow === 'work' ? 'working day' : DOW[r.dow == null ? 4 : r.dow]) + ' of the month';
    return pd ? 'The ' + (pd === 'last' ? 'last day' : ordinal(pd)) + ' of the month' : '';
  }
  /* ---------- v3.4.1: each pay line has its own payday ----------
     A pay line's rule lives on the line (it.payRule; the date for "same date" is it.payDay, the
     planner's Paid on). The main pay (ticked, or else the biggest) drives the countdown, the payday
     banner and the payday email: it is copied to state.payRule / state.payday, which the rest of
     PayStamp already reads. Accounts with no pay line simply have no payday. */
  function payLines() { var g = findGroup('income'); return g ? g.categories.reduce(function (a, c) { return a.concat(c.items); }, []) : []; }
  function mainPayLine() {
    var ls = payLines(); if (!ls.length) return null;
    return ls.filter(function (it) { return it.mainPay; })[0] || ls.reduce(function (b, it) { return amt(it.target || it.budgeted) > amt(b.target || b.budgeted) ? it : b; }, ls[0]);
  }
  function lineRule(it) { return Object.assign({ mode: 'date', weekendBefore: true }, it.payRule || {}, { day: it.payDay || '' }); }
  function lineRuleShort(it) {
    var r = lineRule(it);
    if (r.mode === 'varies') return 'Varies';
    if (r.mode === 'repeat') return 'Every ' + ({ 7: 'week', 14: '2 wks', 28: '4 wks' }[r.every] || '2 wks');
    if (r.mode === 'weekday') return (r.nth === 'last' || !r.nth ? 'Last ' : ordinal(r.nth) + ' ') + (r.dow === 'work' ? 'work day' : DOW[r.dow == null ? 4 : r.dow].slice(0, 3));
    return r.day ? (r.day === 'last' ? 'Last day' : ordinal(r.day)) : '';
  }
  function syncPaydays() {
    var main = mainPayLine(); if (!main) return;
    if (!main.payRule) { var old = Object.assign({}, state.payRule || { mode: 'date', weekendBefore: true }); delete old.day; main.payRule = old; if (!main.payDay && state.payday) main.payDay = state.payday; }
    var r = Object.assign({}, main.payRule); delete r.day;
    if (JSON.stringify(r) !== JSON.stringify(state.payRule)) state.payRule = r;
    if ((main.payDay || '') !== (state.payday || '')) state.payday = main.payDay || '';
  }
  // "It varies": add a payment to This Pay on the main income line, straight from the greeting.
  function addPayment(v) {
    var n = amt(v); if (!(n > 0)) return;
    var it = mainPayLine();
    if (!it) return;
    var before = it.budgeted;
    it.budgeted = String(Math.round((amt(it.budgeted) + n) * 100) / 100);
    state.payAddOpen = false; commit();
    showUndo('Added ' + money(n) + ' to This Pay', function () { it.budgeted = before; commit(); });
  }
  function hello() {
    var hr = new Date().getHours(), part = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
    var name = userName(), r = payRule(), pt = paydayText(), n = daysToPayday(), varies = r.mode === 'varies';
    var chip = null;
    if (varies) {
      var inMonth = totals().income;
      chip = h('span', { style: 'display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center' }, [
        btn('payday-chip today', 'Paid so far this month. Change how you’re paid', function () { go('account'); }, [money(inMonth) + ' in so far this month']),
        state.payAddOpen
          ? h('span', { class: 'pay-add' }, [h('span', { text: cur() }), field('pay-add', '', addPayment, { cls: 'pay-add-in', ph: '0', num: true, label: 'Payment amount' }), btn('pay-add-go', 'Add payment', function () { if (!state.payAddOpen) return; var i = document.querySelector('[data-k="pay-add"]'); if (i) addPayment(i.value); }, ['Add'])])
          : btn('hello-add', 'Add a payment', function () { set({ payAddOpen: true }); setTimeout(function () { var i = document.querySelector('[data-k="pay-add"]'); if (i) i.focus(); }, 0); }, ['+ Add a payment']) ]);
    } else if (pt) chip = btn('payday-chip' + (n === 0 ? ' today' : ''), pt + '. Change how you’re paid', function () { go('account'); }, [h('span', { html: IC.plan, style: 'display:flex' }), pt]);
    return h('div', { class: 'hello' }, [
      h('span', {}, name ? [part + ', ', h('b', { text: name })] : [part]),
      chip,
      !name || (!pt && !varies) ? btn('hello-add', 'Add your name and payday', function () { go('account'); }, [!name && !pt && !varies ? 'Add your name and payday' : !name ? 'Add your name' : 'Add your payday']) : null ]);
  }
  // Your details › How are you paid?
  function payRuleEditor(it) {
    var r = lineRule(it), mode = r.mode, k = 'pr-' + it.id;
    var setRule = function (patch) { var base = Object.assign({ mode: 'date', weekendBefore: true }, it.payRule || {}); it.payRule = Object.assign(base, patch); delete it.payRule.day; commit(); };
    var opts = [['date', 'Same date every month', 'Like the 25th, or the last day of the month'], ['weekday', 'A set day in the month', 'Like the last Thursday, or the last working day'],
      ['repeat', 'Every week, 2 weeks or 4 weeks', 'Shifts, agency work, some hourly jobs'], ['varies', 'It varies', 'Self-employed, or paid at different times']];
    var choices = h('div', { class: 'pr-opts', role: 'radiogroup', 'aria-label': 'How is ' + (it.label || 'this pay') + ' paid?' }, opts.map(function (o) {
      return h('button', { type: 'button', class: 'su-opt' + (mode === o[0] ? ' on' : ''), role: 'radio', 'aria-checked': String(mode === o[0]), onclick: function () {
        var patch = { mode: o[0] };
        if (o[0] === 'repeat' && !r.anchor) { var nx = nextPayDate(r); patch.anchor = ymd(nx || today0()); patch.every = r.every || 14; }
        setRule(patch);
      } }, [h('i', { class: 'su-rad' }), h('div', {}, [h('b', { text: o[1] }), h('span', { text: o[2] })])]);
    }));
    var sel = function (id, label, val, list, on) {
      var e = h('select', { class: 'pr-sel', id: id, 'data-k': id, 'aria-label': label, onchange: function (ev) { on(ev.target.value); } },
        list.map(function (x) { return h('option', { value: String(x[0]), text: x[1] }); }));
      e.value = String(val); return e;
    };
    var detail;
    if (mode === 'date') detail = h('label', { class: 'pr-line', for: k + '-day' }, ['Paid on the', daySelect(k + '-day', it.payDay, function (v) { it.payDay = v; commit(); }, 'pr-sel', 'Payday'), 'of the month']);
    else if (mode === 'weekday') detail = h('div', { class: 'pr-line' }, ['Paid on the',
      sel(k + '-nth', 'Which one', r.nth || 'last', [['last', 'last'], ['1', 'first'], ['2', 'second'], ['3', 'third'], ['4', 'fourth']], function (v) { setRule({ nth: v }); }),
      sel(k + '-dow', 'Day', r.dow == null ? 4 : r.dow, [['work', 'working day'], [1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [0, 'Sunday']], function (v) { setRule({ dow: v === 'work' ? 'work' : Number(v) }); }),
      'of the month']);
    else if (mode === 'repeat') {
      var dIn = h('input', { type: 'date', class: 'pr-sel', id: k + '-anchor', 'data-k': k + '-anchor', 'aria-label': 'A recent or upcoming payday', onchange: function (e) { if (parseYmd(e.target.value)) setRule({ anchor: e.target.value }); } });
      dIn.value = r.anchor || '';
      detail = h('div', { class: 'pr-stack' }, [
        h('div', { class: 'pr-line' }, ['Every', sel(k + '-every', 'How often', r.every || 14, [[7, 'week'], [14, '2 weeks'], [28, '4 weeks']], function (v) { setRule({ every: Number(v) }); })]),
        h('label', { class: 'pr-line', for: k + '-anchor' }, ['One of your paydays', dIn]) ]);
    } else detail = h('p', { class: 'pr-note' }, ['No countdown. When money comes in, tap ', h('b', { text: '+ Add a payment' }), ' at the top of your planner and it’s added to This Pay.']);
    var wk = mode === 'date' || mode === 'repeat' ? h('label', { class: 'pr-wk', for: k + '-weekend' }, [
      h('input', { type: 'checkbox', id: k + '-weekend', checked: r.weekendBefore !== false ? true : null, onchange: function (e) { setRule({ weekendBefore: e.target.checked }); } }),
      h('span', { text: 'If it lands on a weekend, I’m paid the Friday before' }) ]) : null;
    var nx = nextPayDate(r), dn = nx ? Math.round((nx - today0()) / 86400000) : null;
    return h('div', { class: 'pr' }, [choices,
      h('div', { class: 'pr-box' }, [detail, wk, nx ? h('p', { class: 'pr-next' }, ['Next payday: ', h('b', { text: shortDate(nx) + (dn ? ' (in ' + dn + (dn === 1 ? ' day)' : ' days)') : ' (today)') })]) : null])]);
  }
  // The sheet that opens from a pay line's Paid on in the planner.
  function payLineBody() {
    var it = payLines().find(function (x) { return x.id === state.payLineId; });
    if (!it) return h('p', { text: 'That pay line has gone.' });
    var main = mainPayLine() === it, names = (state.locations || []).filter(function (l) { return l.name && !l.cardId; }).map(function (l) { return l.name; });
    var acc = h('select', { class: 'pr-sel', id: 'pl-acc', 'aria-label': 'Paid into', onchange: function (e) { it.account = e.target.value; commit(); } },
      [h('option', { value: '', text: 'Not set' })].concat(names.map(function (n) { return h('option', { value: n, text: n }); })));
    acc.value = it.account || '';
    return h('div', { class: 'f-body' }, [
      h('label', { class: 'pr-line', for: 'pl-acc' }, ['Paid into', acc]),
      payRuleEditor(it),
      h('label', { class: 'pr-wk pl-main', for: 'pl-main' }, [
        h('input', { type: 'checkbox', id: 'pl-main', checked: main ? true : null, disabled: main && payLines().length === 1 ? true : null, onchange: function (e) { payLines().forEach(function (x) { delete x.mainPay; }); if (e.target.checked) it.mainPay = true; commit(); } }),
        h('span', {}, [h('b', { text: 'This is my main pay. ' }), 'It sets your payday countdown, the payday banner and when your payday email is sent.'])]),
      h('div', { class: 'sheet-actions' }, [btn('fb-send', 'Done', function () { set({ overlay: null }); }, ['Done'])]) ]);
  }
  // Your details: a summary of every pay line's payday, each one changed from the planner.
  function paySummary() {
    var ls = payLines().filter(function (it) { return it.label || amt(it.target) || amt(it.budgeted); }), main = mainPayLine();
    return h('div', { class: 'pr' }, [h('span', { class: 'pr-k', text: 'How you’re paid' }),
      h('div', { class: 'pay-sum' }, ls.length ? ls.map(function (it) {
        var nx = nextPayDate(lineRule(it));
        return h('div', { class: 'pay-sum-row' }, [
          h('div', {}, [h('b', {}, [it.label || 'Pay', it === main && ls.length > 1 ? h('small', { class: 'cp-tag', text: 'Main' }) : null]),
            h('small', { text: [it.account, payRuleText(lineRule(it)), nx ? 'next ' + shortDate(nx) : ''].filter(Boolean).join(' · ') || 'Payday not set yet' })]),
          btn('cp-inline', 'Change ' + (it.label || 'this pay'), function () { set({ overlay: 'payLine', payLineId: it.id }); }, ['Change']) ]);
      }) : [h('small', { class: 'cp-sub', text: 'Add your pay to Income in your planner first.' })]),
      h('small', { class: 'cp-sub', text: 'Each pay line in your planner has its own payday. Tap its Paid on to change it.' }) ]);
  }

  /* ---------- v3.4: links to your bank, savings and investment websites ----------
     Each bank account, saving, investment and debt can have a url. Other links live in state.links. */

  /* ---------- actions ---------- */
  function setLocationName(loc, name) {
    var old = loc.name; loc.name = name;
    if (old && old !== name) state.groups.forEach(function (g) { g.categories.forEach(function (c) { c.items.forEach(function (it) { if (it.account === old) it.account = name; }); }); });
    commit();
  }
  function removeLocation(loc) {
    state.locations = state.locations.filter(function (l) { return l !== loc; });
    state.groups.forEach(function (g) { g.categories.forEach(function (c) { c.items.forEach(function (it) { if (loc.name && it.account === loc.name) it.account = ''; }); }); });
    commit();
  }
  function stampMonth() { var m0 = state.month || MONTHS[new Date().getMonth()], y0 = state.year || String(new Date().getFullYear()); stampMonthCore(); stampCeremony(m0, y0); }
  function worthSnap() { try { var W = worthNow(); return { t: Math.round(W.total), s: Math.round(W.savings), i: Math.round(W.invest), p: Math.round(W.pension), d: Math.round(W.debt) }; } catch (e) { return undefined; } }
  function stampMonthCore() {
    var month = state.month || MONTHS[new Date().getMonth()], year = state.year || String(new Date().getFullYear());
    if (!state.isExample) track('stamp', month + ' ' + year);
    var items = [], income = 0, allocated = 0;
    state.groups.forEach(function (g) { g.categories.forEach(function (c) { c.items.forEach(function (it) {
      var nat = amt(it.budgeted), ic = itemCur(it), v = ic === homeCode() ? nat : Math.round(nat * fxRate(ic) * 100) / 100;
      items.push({ id: it.id, name: it.label || 'Untitled', groupTitle: g.title, gk: g.key, categoryName: c.name || 'Untitled', color: it.color || g.color, value: v, native: ic === homeCode() ? undefined : nat, cur: ic === homeCode() ? undefined : ic, debtId: it.debtId || undefined, savingId: it.savingId || undefined, investmentId: it.investmentId || undefined, coupleId: it.coupleId || undefined });
      if (g.key === 'income') income += v; else allocated += v;
    }); }); });
    state.records = state.records.filter(function (r) { return !(r.month === month && r.year === year); }).concat([{
      id: uid('rec'), month: month, year: year, stampedAt: new Date().toISOString(), items: items,
      incomeTotal: income, allocatedTotal: allocated, balance: Math.round((income - allocated) * 100) / 100, worth: worthSnap(), fx: fxCodes().length ? Object.assign({}, state.fxRates) : undefined }]);
    if (coupleOn()) cpRecStamp(month, year, 'me'); // the shared month goes into the couple's records too
    // The Founding 100: a first real month quietly claims the next number. Nothing is said unless it does.
    var F = state.founder, real = realMonthCheck().ok;
    if (real) state.realStamped = true;
    var fresh = awardMilestones(month + ' ' + year);
    if (!F.number && F.placesLeft > 0 && real) { claimFounder(month + ' ' + year); state.pendingStamps = fresh; set({}); return; }
    if (fresh.length) { state.pendingStamps = fresh; set({ overlay: 'newStamps' }); return; }
    set({ stampFlash: true, stampFlashLabel: month + ' ' + year });
    clearTimeout(stampMonth.t);
    stampMonth.t = setTimeout(function () { state.stampFlash = false; scheduleRender(); }, 3200);
  }
  /* ---------- Tab goes down ----------
     In a list (planner items, debts, savings, investments…) Tab moves to the same box in the row below,
     and Shift+Tab to the row above. Past the last row it carries on to the next thing on the page.
     Typing a new value rebuilds the page, which used to lose the Tab, so the next box is found first
     and focused again after the rebuild. */
  var FOCUSABLE = 'input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]';
  function visible(n) { return !!(n && n.getClientRects().length); }
  function tabStops(scope) { return Array.prototype.filter.call(scope.querySelectorAll(FOCUSABLE), function (n) { return n.tabIndex >= 0 && visible(n); }); }
  function tabScope(n) { return (n && n.closest('.overlay')) || document.getElementById('app'); }
  // The key of the same box in the next (or previous) row, or null if there isn't one.
  function sameBoxInNextRow(el, scope, back) {
    var row = el.closest('[data-row-id]'); if (!row) return null;
    var key = el.dataset.k, rid = row.dataset.rowId;
    var prefix = key.slice(-(rid.length + 1)) === '-' + rid ? key.slice(0, key.length - rid.length) : key.split('-')[0] + '-';
    var rows = Array.prototype.slice.call(scope.querySelectorAll('[data-row-id]')), i = rows.indexOf(row);
    for (i += back ? -1 : 1; i >= 0 && i < rows.length; i += back ? -1 : 1) {
      if (rows[i].contains(row)) continue;
      var hit = rows[i].querySelector('[data-k^="' + CSS.escape(prefix) + '"]');
      if (hit && visible(hit) && hit.tabIndex >= 0) return hit.dataset.k;
    }
    return null;
  }
  function focusKeyAfterSave(el, key) {
    var inOverlay = !!el.closest('.overlay');
    el.blur();                                           // saves the box (and may rebuild the page)
    var fresh = inOverlay ? document.querySelector('#app .overlay') : document.getElementById('app');
    var t = fresh && fresh.querySelector('[data-k="' + CSS.escape(key) + '"]');
    if (!t) return;
    t.focus();
    if (t.tagName === 'INPUT' && t.select) t.select();
  }
  // Down / Up arrows do the same in a list: same box, next or previous row. (Not in dropdowns,
  // where the arrows choose an option.) At the top or bottom of a list they do nothing.
  document.addEventListener('keydown', function (e) {
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var el = e.target;
    if (!el || !el.matches || !el.matches('#app input[data-k]') || !el.closest('[data-row-id]')) return;
    var key = sameBoxInNextRow(el, tabScope(el), e.key === 'ArrowUp');
    e.preventDefault();
    if (key) focusKeyAfterSave(el, key);
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
    var el = e.target;
    if (!el || !el.matches || !el.matches('#app input[data-k], #app select[data-k]')) return;
    var inOverlay = !!el.closest('.overlay'), scope = tabScope(el), back = e.shiftKey;
    var targetKey = sameBoxInNextRow(el, scope, back), targetIdx = -1;
    if (!targetKey) {
      var stops = tabStops(scope), j = stops.indexOf(el) + (back ? -1 : 1);
      if (j < 0 || j >= stops.length) return;           // let the browser leave the page as normal
      if (stops[j].dataset && stops[j].dataset.k) targetKey = stops[j].dataset.k; else targetIdx = j;
    }
    e.preventDefault();
    el.blur();                                           // saves the box (and may rebuild the page)
    var fresh = inOverlay ? document.querySelector('#app .overlay') : document.getElementById('app');
    if (!fresh) return;
    var t = targetKey ? fresh.querySelector('[data-k="' + CSS.escape(targetKey) + '"]') : tabStops(fresh)[targetIdx];
    if (!t) return;
    t.focus();
    if (t.tagName === 'INPUT' && t.select) t.select();
  }, true);

  var AS_PAGE = { records: 'history', targets: 'compass', notes: 'compass', locations: 'accounts', debt: 'debt', savings: 'savings', investments: 'investments', whatsnew: 'help' };
  function openOverlay(name) { if (AS_PAGE[name]) { go(AS_PAGE[name]); return; } set({ overlay: name, openMenu: null }); }
  // New pages carry a "New" tag in the menu until they've been opened once.
  function isNewPage(key) { return !(state.seenPages || {})[key]; }
  function closeOverlay() { if (Date.now() - dragEndedAt < 300) return; set({ overlay: null, exportMsg: null }); }
  // Clicking anywhere outside an open menu closes it.
  document.addEventListener('click', function (e) {
    if (state.openMenu && !e.target.closest('.dd, .dd-btn')) set({ openMenu: null });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (state.overlay) set({ overlay: null, exportMsg: null }); else if (state.openMenu) set({ openMenu: null }); else if (curPage() !== 'plan') go('plan');
  });

  /* ---------- tour ---------- */
  var TOUR = [
    { title: 'Welcome to PayStamp', body: 'Give every pound of your pay a job, month by month. Here’s a quick look around.', accent: '#7E2A55', id: null },
    { title: 'Plan your month', body: 'Budgeted is what you plan each month. This Month is what’s actually happening, so change only what’s different. Click any name or amount to change it; amount boxes do sums too, so try 45+12. Drag the ⠿ grip to move things around.', accent: '#1E6B47', id: 'tour-categories' },
    { title: 'Debt, Savings and Investments', body: 'They’re on the plum bar (along the bottom on a phone) and open on top of your planner. Give one a monthly amount and it appears in your plan with a small tag.', accent: '#7E2A55', id: 'tour-goals' },
    { title: 'Stamp your month', body: 'When the Zero-based balance says £0, press Stamp. It saves the month to Records, pays down your debts and adds to your savings.', accent: '#7E2A55', id: 'tour-stamp' },
    { title: 'Collect stamps', body: 'Each month you stamp is inked into the year above your planner. Hit milestones like a full emergency fund or 3 months in a row and you earn a special stamp. The first 100 users also get a numbered founder stamp.', accent: '#B8860B', id: 'tour-founder' },
    { title: 'More, and your columns', body: 'Records, Insights and the Couples planner are under More. Above your planner you can show columns for % of pay, Automation and a costs review, and tick the emails you’d like.', accent: '#7E2A55', id: null },
  ];

  function tourGo(i) {
    set({ introStep: i });
    // On a phone the card sits at the bottom, so bring what it points at to the top of the screen instead.
    var t = TOUR[i]; if (t && t.id) setTimeout(function () { var el = document.getElementById(t.id); if (!el) return;
      if (innerWidth <= 640) window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - 76), behavior: 'smooth' });
      else el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 60);
  }
  function hi(id) {
    var t = state.introOpen && TOUR[state.introStep || 0];
    return t && t.id === id ? { class: 'hi', style: '--hi:' + t.accent } : null;
  }
  function withHi(el, id) { var x = hi(id); if (x) { el.classList.add('hi'); el.style.setProperty('--hi', x.style.split(':')[1]); } return el; }

  /* ---------- views (v3.3: a plum bar on top on a laptop, at the bottom on a phone.
     The planner is always underneath; every other section opens over it.) ---------- */
  var SV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var IC = {
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
    plan: SV + '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    debt: SV + '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10.5h18M7 15h4"/></svg>',
    savings: SV + '<path d="M8 3.5h8v3H8z"/><path d="M6.5 6.5h11v10.5a3 3 0 0 1-3 3h-5a3 3 0 0 1-3-3z"/><path d="M10 13h4"/></svg>',
    investments: SV + '<path d="M4 17l5-5 4 3 7-8"/><path d="M15 7h5v5"/></svg>',
    history: SV + '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5M12 8v4l3 2"/></svg>',
    accounts: SV + '<path d="M3 10l9-6 9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/></svg>',
    checklist: SV + '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>',
    help: SV + '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01"/></svg>',
    gift: SV + '<rect x="4" y="9" width="16" height="11" rx="1.5"/><path d="M3 9h18M12 9v11"/><path d="M12 9c-1.5-3.5-5.5-3.5-5.5-1.2S9 9 12 9zM12 9c1.5-3.5 5.5-3.5 5.5-1.2S15 9 12 9z"/></svg>',
    phone: SV + '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>',
    compass: SV + '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></svg>',
    link: SV + '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
    out: SV + '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/></svg>',
    reset: SV + '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    user: SV + '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    group: SV + '<circle cx="9" cy="8" r="3.2"/><circle cx="17" cy="9.5" r="2.6"/><path d="M3 20a6 6 0 0 1 12 0M14.5 20a4.5 4.5 0 0 1 7-3.7"/></svg>',
    bag: SV + '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/></svg>',
    star: SV + '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>',
    heart: SV + '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
    down: SV + '<path d="M6 9l6 6 6-6"/></svg>',
    chevL: SV + '<path d="M15 6l-6 6 6 6"/></svg>',
    chevR: SV + '<path d="M9 6l6 6-6 6"/></svg>' };
  function logoW(size) {
    return h('span', { class: 'lw', style: 'width:' + size + 'px;height:' + size + 'px', 'aria-hidden': 'true', html: STAMP_IC });
  }
  var STAMP_IC = '<svg viewBox="0 0 48 48" aria-hidden="true"><g transform="rotate(-10 24 24)"><circle cx="24" cy="24" r="21.5" fill="none" stroke="#FBF8FC" stroke-width="3"/><circle cx="24" cy="24" r="16.5" fill="none" stroke="#FBF8FC" stroke-width="1.4" stroke-dasharray="2.4 2.2"/><text x="24" y="31.5" text-anchor="middle" font-family="Besley, Georgia, serif" font-size="22" fill="#FBF8FC">P</text></g></svg>';
  var MORE_PAGES = ['history', 'insights', 'couples', 'hustle'], ME_PAGES = ['account', 'accounts', 'app', 'help', 'admin'];
  // [title, subtitle, width]
  var PAGE_INFO = {
    debt: ['Debt', 'Every debt you’re paying off. Put them in the order you want to tackle them.', 'mid'],
    savings: ['Savings', 'Everything you’re saving towards, and how much you’ve saved so far.', 'mid'],
    investments: ['Investments', 'What you’ve put in, what it’s worth now, and how it’s growing.', 'mid'],
    history: ['Records', 'Every month you stamp is saved here, so you can look back and compare.', 'wide'],
    insights: ['Insights', 'What your stamped months add up to: where your pay went, and what’s changing.', 'mid'],
    accounts: ['Bank accounts', 'The banks and accounts your money goes to. Renaming one updates every item that uses it.'],
    help: ['Help & what’s new', 'What’s changed, a quick tour, and a way to tell us what you think.'],
    privacy: ['Privacy', 'What PayStamp stores, why, and how to delete it.', 'mid'],
    admin: ['Admin', 'Only you can see this page: sign-ups, founders and feedback.', 'mid'],
    app: ['Get the app', 'Put PayStamp on your home screen. It opens full screen like any other app, and there’s no app store involved.'],
    account: ['Your account', 'Your details, your founder stamp and your invite link.'],
    pro: ['PayStamp Pro', '', 'mid'],
    hustle: ['PayStamp Hustle', 'Your side hustles: money in and out, and what to put aside for tax.', 'wide'],
    couples: ['Couples planner', 'Plan the costs you share. Each of you sees your own share in your own planner.', 'wide'] };
  // Debt, Savings and Investments now live inside their Compass topics.
  var PAGE_MOVED = { 'cp-ef6': 'cp-ef3', pro: 'plan' }; // v4.3: no Pro page while PayStamp is free. // v3.7: Debt, Savings and Investments are their own pages again; one safety net topic
  function curPage() { var p = PAGE_MOVED[state.page] || state.page; return PAGE_INFO[p] ? p : 'plan'; }
  // Each section has its own address (#debt, #history…), so the browser's back button closes it.
  function go(page, fromHistory) {
    if (page === 'checklist' || page === 'compass' || (/^cp-/.test(page) && page !== 'cp-direct')) page = 'plan'; // v4.1: Compass removed (Shape PayStamp stays)
    if (PAGE_MOVED[page]) page = PAGE_MOVED[page];
    if (page !== curPage()) { cpKeepOpen = {}; cpOpen = {}; }
    if (page !== 'plan' && !PAGE_INFO[page]) page = 'plan';
    if (page === 'pro' && PRO_OFF) page = 'plan';   // v4.3: no Pro page while PayStamp is free
    var same = page === curPage() && !state.overlay;
    if (page !== curPage()) state.editRow = null;
    if (page !== curPage()) state.fbqOpen = false;
    state.page = page; state.overlay = null; state.openMenu = null; state.resetArmed = false; state.delStep = 0; state.delErr = '';
    if (page === 'admin') adminData = null;
    if (page === 'couples') setTimeout(function () { cpPull(true); }, 0);
    if (page === 'help') state.seenWhatsNew = WN[0].version;
    if (['debt', 'savings', 'investments', 'history'].indexOf(page) > -1) { state.seenPages = Object.assign({}, state.seenPages); state.seenPages[page] = true; }
    if (!fromHistory && !same) { try { history.pushState(null, '', page === 'plan' ? location.pathname + location.search : '#' + page); } catch (e) {} }
    commit();
    if (!same) setTimeout(function () { window.scrollTo(0, 0); }, 0);
  }
  // Opens the planner and takes you straight to one line: unfolds its group, scrolls to it and highlights it.
  function openInPlanner(itemId) {
    var f = findItem(itemId);
    if (f && (state.folded || {})[f.g.key]) { var fo = Object.assign({}, state.folded); delete fo[f.g.key]; state.folded = fo; }
    go('plan');
    var tries = 0;
    (function seek() {
      var row = document.querySelector('.item-row[data-row-id="' + itemId + '"]');
      if (!row) { if (++tries < 12) setTimeout(seek, 60); return; }
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.remove('row-flash'); void row.offsetWidth; row.classList.add('row-flash');
      setTimeout(function () { row.classList.remove('row-flash'); }, 2600);
    })();
  }
  // Opens the Debt, Savings or Investments page and takes you to one row there.
  function openOnPage(page, id) {
    go(page);
    var tries = 0;
    (function seek() {
      var row = document.querySelector('.pg [data-row-id="' + id + '"]');
      if (!row) { if (++tries < 12) setTimeout(seek, 60); return; }
      setTimeout(function () {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.remove('row-flash'); void row.offsetWidth; row.classList.add('row-flash');
        setTimeout(function () { row.classList.remove('row-flash'); }, 2600);
      }, 80);
    })();
  }
  // Tapping the section that's already open closes it, back to the planner.
  function toggle(page) { go(curPage() === (PAGE_MOVED[page] || page) && !state.overlay ? 'plan' : page); }
  window.addEventListener('popstate', function () { go((location.hash || '').slice(1) || 'plan', true); });

  function buildApp() {
    // Open on the month you were last working on (it's saved with your plan as valsMonth), not always this calendar month.
    if (!state.month && state.valsMonth) { var vm = String(state.valsMonth).split(' '); if (MONTHS.indexOf(vm[0]) > -1 && /^\d{4}$/.test(vm[1] || '')) { state.month = vm[0]; state.year = vm[1]; } }
    if (typeof syncDebtPlan === 'function') syncDebtPlan();
    if (typeof syncSavingsLinks === 'function') syncSavingsLinks();
    if (typeof syncSinking === 'function') syncSinking();
    if (typeof syncSafetyCats === 'function') syncSafetyCats();
    if (typeof syncCardLocs === 'function') syncCardLocs();
    if (typeof syncPayIns === 'function') syncPayIns();
    if (typeof syncPaydays === 'function') syncPaydays();
    if (typeof syncEmailDigest === 'function') syncEmailDigest();
    var frag = document.createDocumentFragment(), page = curPage();
    var fbar = null; document.body.classList.remove('has-fbar');  // founder places now live in the bar (laptop) and the top card (phone)
    document.body.classList.toggle('ov-open', !!state.overlay || page !== 'plan'); document.body.setAttribute('data-page', page);
    var pageEnter = page !== 'plan' && page !== shown.page ? (shown.hadOv ? 'swap' : 'open') : false; shown.page = page; shown.hadOv = page !== 'plan' || !!state.overlay;
    if (page !== 'plan') syncMonthVals();
    track('page', page, true);
    // v4.1: the planner always stays underneath; every other page pops out over it
    frag.append(buildPage()); if (page !== 'plan') frag.append(pageSheet(page, pageEnter)); frag.append(topNav(page), bottomNav(page));
    if (fbar) frag.append(fbar);
    if (state.overlay === 'more') frag.append(sheet('More', '', moreBody()));
    if (state.overlay === 'invites') frag.append(sheet(state.founder.placesLeft > 0 ? 'Gift a founder place' : 'Share PayStamp', state.founder.placesLeft > 0 ? 'Save a friend one of the first 100 places. Share your link as often as you like.' : 'Share your personal link as often as you like.', invitesBody()));
    if (state.overlay === 'newStamps') frag.append(sheet((state.pendingStamps || []).length > 1 ? 'New stamps' : 'New stamp', '', newStampsBody()));
    if (state.overlay === 'share' && state.shareSpec) frag.append(sheet(shareTitle(state.shareSpec), '', shareBody(), 'share-sheet'));
    if (state.overlay === 'payLine') { var plIt = payLines().find(function (x) { return x.id === state.payLineId; }); frag.append(sheet('When is ' + ((plIt && plIt.label) || 'this pay') + ' paid?', 'Each pay line has its own payday.', payLineBody())); }
    if (state.overlay === 'founderWelcome') frag.append(sheet('You’re a founder', '', founderWelcomeBody()));
    if (state.overlay === 'founderInfo') frag.append(sheet('What’s a founder?', '', founderInfoBody()));
    if (state.overlay === 'review') frag.append(sheet('Write a review', 'Thank you for helping. Honest is best, good or bad.', reviewBody()));
    if (state.overlay === 'feedback') frag.append(sheet(state.fbSent ? 'Thank you' : 'Shape PayStamp', state.fbSent ? '' : 'PayStamp is brand new. Got an idea, or found something that isn’t working? Tell us here.', feedbackBody()));
    if (state.introOpen) frag.append(buildTour());
    if (state.qsOpen) frag.append(buildQuick());
    var fq = fbQuick(); if (fq) frag.append(fq);
    // v4.3: Penny is switched off while she's being restructured
    if (state.stampFlash) frag.append(h('div', { class: 'toast-fixed' }, [h('div', { class: 'toast', role: 'status', text: (userName() ? 'Nice one, ' + userName() + '. ' : '✓ ') + state.stampFlashLabel + ' stamped. You’ll find it in Records.' })]));
    return frag;
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !state.overlay && !state.qsOpen && !state.fbqOpen && curPage() !== 'plan' && !document.querySelector('.sc-back')) { e.preventDefault(); go('plan'); } });
  function pageSheet(page, enter) {
    var info = PAGE_INFO[page], sub = info[1];
    var body = { debt: debtBody2, savings: savingsBody2, investments: investmentsBody2, history: recordsBody, insights: insightsBody, couples: couplesBody, hustle: hustleBody, pro: proBody,
      accounts: function () { var b = locationsBody(); b.prepend(currencyRow(), multiCurRow()); return b; }, app: appBody, admin: adminBody, privacy: privacyBody, help: helpBody, account: accountBody,
      'cp-direct': directBody }[page];
    body = body ? body() : h('div');
    // v4: every section is a full page of its own (the planner no longer sits underneath)
    // v4.1: a pop-out over the planner. Click outside, press Esc or the ✕ to close it.
    var back = h('div', { class: 'overlay pg-ov' + (enter === 'open' ? ' pg-ov-in' : ''), 'data-pg': page, role: 'dialog', 'aria-modal': 'true', 'aria-label': info[0],
      onclick: function (e) { if (e.target === back) go('plan'); } });
    back.append(h('main', { class: 'sheet pg-sheet pg-pop' + (info[2] ? ' ' + info[2] : '') + (enter === 'swap' ? ' pg-swap' : ''), 'aria-label': info[0] }, [
      btn('sheet-close pg-x', 'Close ' + info[0], function () { go('plan'); }, ['✕']),
      h('header', { class: 'pg-head' }, [h('h1', { class: 'pg-title' }, [info[0], BETA[page] ? betaTag('big') : null]), sub ? h('p', { class: 'sub', text: sub }) : null,
        BETA[page] ? h('p', { class: 'beta-note' }, ['This is new and we’re still improving it. ', btn('cp-inline', 'Tell us what you think', function () { openFeedbackKind('feedback'); }, ['Tell us what you think ›'])]) : null]), body ]));
    return back;
  }

  /* ---------- the bars ---------- */
  // The strip right at the top: how many founding places are left, and a way to give one to a friend.
  // Left to plan, in the top bar next to PayStamp, so it's always in view.
  // v4.3: Beta marks for the parts that are new and still being worked on
  var BETA = { couples: true, hustle: true };
  function betaTag(cls) { return h('span', { class: 'beta-tag' + (cls ? ' ' + cls : ''), title: 'New, and still being improved', text: 'Beta' }); }
  function ddItem(key, icon, label, sub, count, onClick) {
    return h('button', { type: 'button', class: 'dd-i' + (curPage() === key ? ' on' : ''), onclick: onClick || function () { go(key); } }, [
      h('span', { class: 'ic', html: IC[icon] }), h('span', { class: 'dd-t' }, [].concat(label, sub ? [h('small', { text: sub })] : [])),
      count != null ? h('span', { class: 'cnt', text: String(count) }) : null ]);
  }
  function menuToggle(name) { set({ openMenu: state.openMenu === name ? null : name }); }
  function founderBadge(cls) {
    var F = state.founder;
    return F.number ? h('span', { class: cls + ' gold', html: founderStampSVG(F.number) }) : h('span', { class: cls, html: IC.user });
  }
  function meItems() {
    var F = state.founder, P = window.PayStamp || {}, kids = [
      ddItem('account', 'user', 'Your details', 'Name, payday and invites'),
      ddItem('accounts', 'accounts', 'Bank accounts', 'Where your money goes', state.locations.length),
      ddItem('app', 'phone', isAppMode() ? 'The PayStamp app' : 'Get the app', isAppMode() ? 'You’re using it now' : 'Add PayStamp to your home screen'),
      ddItem('help', 'help', 'Help & what’s new', state.seenWhatsNew !== WN[0].version ? 'New: ' + WN[0].title : 'Tour, updates and suggestions') ];
    if (P.isOwner && P.isOwner()) kids.push(ddItem('admin', 'checklist', 'Admin', 'Feedback, founders and sign-ups'));
    if (state.isExample) kids.push(ddItem('clear', 'reset', 'Clear example data', 'Start with your own numbers', null, function () { set({ openMenu: null }); clearExample(); }));
    if (P.preview) kids.push(ddItem('reset', 'reset', state.resetArmed ? 'Tap again to reset' : 'Reset example data', 'Preview only', null, function () {
      if (!state.resetArmed) { set({ resetArmed: true, openMenu: 'me' }); return; }
      SAVED_KEYS.forEach(function (k) { delete state[k]; }); state.resetArmed = false; state.openMenu = null; migrate(); commit();
    }));
    if (P.signOut) kids.push(ddItem('signout', 'out', 'Sign out', null, null, function () { P.signOut(); }));
    return kids;
  }
  function topNav(page) {
    var F = state.founder, P = window.PayStamp || {}, email = P.getEmail ? P.getEmail() : '';
    var item = function (key, label) {
      return h('button', { type: 'button', class: 'pn-i' + (page === key ? ' on' : ''), 'aria-current': page === key ? 'page' : null, onclick: function () { toggle(key); } }, [
        h('span', { class: 'ic', html: IC[key] }), label, isNewPage(key) ? h('i', { class: 'pn-dot2', title: 'New', 'aria-label': 'New' }) : null ]);
    };
    var moreOn = page === 'compass' || /^cp-/.test(page), meOn = ME_PAGES.indexOf(page) > -1;
    var nav = h('nav', { class: 'pnav', 'aria-label': 'Main' }, [
      h('button', { type: 'button', class: 'pn-brand', 'aria-label': 'Your planner', title: 'Back to your planner', onclick: function () { go('plan'); } }, [logoW(36), h('span', { class: 'pn-name' }, ['PayStamp', h('span', { class: 'pn-desk', text: 'Desk' })])]),
      withHi(h('div', { class: 'pn-mid', id: 'tour-goals' }, [/* v4.1: no Planner tab; the planner is always underneath and the logo brings you back */ item('investments', 'Investments'), item('savings', 'Savings'), item('debt', 'Debt')]), 'tour-goals'),
      h('div', { class: 'pn-right' }, [
        offlinePill(), founderPill(),
        /* v4.1 preview: Compass removed */
        h('button', { type: 'button', class: 'pn-i dd-btn' + (MORE_PAGES.indexOf(page) > -1 || state.openMenu === 'more' ? ' on' : ''), 'aria-expanded': String(state.openMenu === 'more'), onclick: function () { menuToggle('more'); } },
          [h('span', { class: 'ic', html: IC.more }), 'More', h('span', { class: 'ic dn' + (state.openMenu === 'more' ? ' up' : ''), html: IC.down })]),
        h('button', { type: 'button', class: 'pn-me dd-btn' + (meOn || state.openMenu === 'me' ? ' on' : ''), 'aria-label': 'Your account', 'aria-expanded': String(state.openMenu === 'me'), onclick: function () { menuToggle('me'); } },
          [founderBadge('pn-av'), state.seenWhatsNew !== WN[0].version ? h('span', { class: 'pn-dot', 'aria-hidden': 'true' }) : null, h('span', { class: 'ic dn' + (state.openMenu === 'me' ? ' up' : ''), html: IC.down })]) ]) ]);
    if (state.openMenu === 'more') nav.append(h('div', { class: 'dd dd-more' }, [
      ddItem('history', 'history', 'Records', state.records.length + (state.records.length === 1 ? ' month' : ' months') + ' stamped'),
      ddItem('insights', 'investments', 'Insights', 'Trends from the months you’ve stamped'),
      ddItem('couples', 'heart', ['Couples planner', betaTag()], coupleOn() ? 'Shared with ' + coupleName() : 'Plan shared costs with a partner'),
      ddItem('hustle', 'bag', ['PayStamp Hustle', betaTag()], hustleSub()),
      h('div', { class: 'dd-i soon', 'aria-disabled': 'true' }, [h('span', { class: 'ic', html: IC.group }), h('span', {}, [h('b', { text: 'Moai' }), h('small', { text: 'Save as a group, take the pot in turns' })]), h('span', { class: 'soon-tag', text: 'Coming soon' })]) ]));
    if (state.openMenu === 'me') nav.append(h('div', { class: 'dd dd-me' }, [
      h('div', { class: 'dd-head' }, [founderBadge('dd-av'), h('span', {}, [h('b', { class: F.number ? 'fd' : '', text: userName() || (F.number ? 'Founding Member #' + F.number : 'Your account') }), h('small', { text: userName() && F.number ? 'Founding Member #' + F.number : email || (F.number ? 'Thanks for being early' : 'Stamp a £0 month to become a founder') })])]) ].concat(meItems())));
    return nav;
  }
  function bottomNav(page) {
    var moreOn = state.overlay === 'more' || MORE_PAGES.indexOf(page) > -1 || ME_PAGES.indexOf(page) > -1 || page === 'compass' || /^cp-/.test(page);
    var bn = function (key, label, on, tour, onClick) {
      var b = h('button', { type: 'button', class: 'bn' + (on ? ' on' : ''), 'aria-current': on ? 'page' : null, onclick: onClick || function () { toggle(key); } }, [h('span', { class: 'ic', html: IC[key] }), label]);
      return tour ? withHi(b, tour) : b;
    };
    return h('nav', { class: 'bnav', 'aria-label': 'Main' }, [
      bn('plan', 'This month', page === 'plan' && !moreOn, null, function () { go('plan'); }),
      bn('savings', 'Savings', page === 'savings', 'tour-goals'),
      bn('investments', 'Investments', page === 'investments', 'tour-goals'),
      bn('debt', 'Debt', page === 'debt', 'tour-goals'),
      bn('more', 'More', moreOn, null, function () { if (state.overlay === 'more') set({ overlay: null }); else set({ overlay: 'more', openMenu: null }); }) ]); // v4.1: phones reach Records, Insights and your details here
  }

  /* More (phone): everything that isn't Debt, Savings or Investments. */
  function moreBody() {
    var F = state.founder;
    var ll = function (key, icon, title, sub) {
      return h('button', { type: 'button', class: 'll', onclick: function () { go(key); } }, [h('span', { class: 'ic', html: IC[icon] }), h('span', {}, [].concat(title, [h('small', { text: sub })])), h('span', { class: 'chev', html: IC.chevR })]);
    };
    var P = window.PayStamp || {};
    var quick = function (key, icon, label) { return h('button', { type: 'button', class: 'ql', onclick: function () { go(key); } }, [h('span', { class: 'ic', html: IC[icon] }), label]); };
    return h('div', { class: 'f-body' }, [
      h('div', { class: 'ql-row' }, [quick('history', 'history', 'Records'), quick('accounts', 'accounts', 'Bank accounts'), quick('account', 'user', 'Your details')]),
      h('h2', { class: 'sec-h', text: 'You' }),
      h('div', { class: 'list-links' }, [
        ll('history', 'history', 'Records', state.records.length + (state.records.length === 1 ? ' month' : ' months') + ' stamped'),
        ll('insights', 'investments', 'Insights', 'Trends from the months you’ve stamped'),
        ll('couples', 'heart', ['Couples planner', betaTag()], coupleOn() ? 'Shared with ' + coupleName() : 'Plan shared costs with a partner'),
        ll('hustle', 'bag', ['PayStamp Hustle', betaTag()], hustleSub()),
        h('div', { class: 'll soon', 'aria-disabled': 'true' }, [h('span', { class: 'ic', html: IC.group }), h('span', {}, ['Moai', h('small', { text: 'Save as a group, take the pot in turns' })]), h('span', { class: 'soon-tag', text: 'Coming soon' })]),
        ll('accounts', 'accounts', 'Bank accounts', state.locations.length + (state.locations.length === 1 ? ' account' : ' accounts') + ' · where your money goes'),
        ll('account', 'user', userName() ? userName() + ' · Your details' : 'Your details', (F.number ? 'Founder #' + F.number + ' · ' : '') + 'Name, payday and invites'),
        ll('app', 'phone', isAppMode() ? 'The PayStamp app' : 'Get the app', isAppMode() ? 'You’re using it now' : 'Add PayStamp to your home screen'),
        ll('help', 'help', 'Help & what’s new', state.seenWhatsNew !== WN[0].version ? 'New: ' + WN[0].title : 'Tour, updates and suggestions'),
        ll('cp-direct', 'checklist', 'Shape PayStamp', 'Tell us what you need next'),
        P.isOwner && P.isOwner() ? ll('admin', 'checklist', 'Admin', 'Feedback, founders and sign-ups') : null ]),
      h('div', { class: 'btn-row' }, [
        P.preview ? btn('pill-btn', 'Reset example data', function () {
          if (!state.resetArmed) { set({ resetArmed: true }); return; }
          SAVED_KEYS.forEach(function (k) { delete state[k]; }); state.resetArmed = false; state.overlay = null; migrate(); commit();
        }, [state.resetArmed ? 'Tap again to reset' : 'Reset example data']) : null,
        P.signOut ? btn('pill-btn', 'Sign out', function () { P.signOut(); }, ['Sign out']) : null ]) ]);
  }
  /* Targets and Notes, together. */
  function helpBody() {
    return h('div', { class: 'f-body' }, [
      h('div', { class: 'btn-row' }, [
        btn('pill-btn primary', 'Take the intro tour', function () { state.page = 'plan'; try { history.pushState(null, '', location.pathname + location.search); } catch (e) {} set({ introOpen: true, introStep: 0 }); setTimeout(function () { window.scrollTo(0, 0); }, 0); }, ['Take the intro tour']),
        btn('pill-btn', 'Report a bug or idea', function () { openFeedbackKind('bug'); }, ['Report a bug or idea']),
        state.founder.placesLeft > 0 ? btn('pill-btn', 'What’s a founder?', function () { openOverlay('founderInfo'); }, ['What’s a founder?']) : null,
        btn('pill-btn', 'Privacy', function () { go('privacy'); }, ['Privacy']) ]),
      h('h2', { class: 'sec-h', text: 'What’s new' }),
      whatsNewBody2() ]);
  }
  function accountBody() {
    var F = state.founder, P = window.PayStamp || {}, email = P.getEmail ? P.getEmail() : '';
    var top = F.number
      ? h('div', { class: 'card-box f-head' }, [h('span', { class: 'f-big-stamp sm', html: founderStampSVG(F.number) }), F.elite ? h('span', { class: 'f-big-stamp sm', html: eliteSealSVG(F.eliteNumber) }) : null,
          h('div', { class: 'f-head-t' }, [h('b', { text: 'Founding Member #' + F.number }), F.since ? h('span', { text: 'Since ' + F.since }) : null, F.placesLeft > 0 ? h('span', { text: F.placesLeft + ' founding places left' }) : null])])
      : h('div', { class: 'card-box f-info' }, [h('p', { class: 'f-lead', text: 'Become one of the first 100' }),
          h('p', { class: 'f-hint', text: 'Plan your own month until it adds up to exactly your pay, then press Stamp. Your founder number comes with your first stamp.' }),
          h('div', { class: 'btn-row' }, [h('span', { class: 'f-counter', style: 'margin:0' }, [h('b', { text: String(F.placesLeft) }), ' founding places left']), btn('pill-btn', 'What’s a founder?', function () { openOverlay('founderInfo'); }, ['What’s a founder?'])]) ]);
    var details = h('div', { class: 'card-box' }, [
      h('div', { class: 'me-grid one' }, [
        h('label', { for: 'f-me-name' }, ['Your first name', field('me-name', userName(), setUserName, { cls: 'tf', ph: 'e.g. Sam', label: 'Your first name' })]) ]),
      h('p', { class: 'me-note', text: 'Shown on your planner and on invites you send.' }),
      paySummary() ]);
    return h('div', { class: 'f-body' }, [email ? h('p', { class: 'f-hint', text: 'Signed in as ' + email }) : null,
      h('h2', { class: 'sec-h', style: 'margin-top:0', text: 'Your details' }), details, top,
      h('h2', { class: 'sec-h', text: F.placesLeft > 0 ? 'Gift a founder place' : 'Share PayStamp' }), invitesBody(),
      h('h2', { class: 'sec-h', text: 'Your data' }), dataBody()]);
  }

  /* ---------- the planner (always underneath) ---------- */
  /* Moving between months.
     A new month starts from your Budgeted amounts, and a stamped month shows what you stamped.
     If you leave a month with This Month numbers you haven't stamped (or changed since stamping),
     they're kept as a small draft so they're still there when you come back. Only the 3 most recent
     drafts are kept; everything older lives in Records once stamped. */
  function monthVals() {
    var o = {};
    state.groups.forEach(function (g) { g.categories.forEach(function (c) { c.items.forEach(function (it) { o[it.id] = amt(it.budgeted); }); }); });
    return o;
  }
  function recVals(month, year) {
    var rec = state.records.filter(function (r) { return r.month === month && String(r.year) === String(year); })[0];
    if (!rec) return null;
    var o = {}; (rec.items || []).forEach(function (x) { o[x.id] = recAmt(x); }); return o;
  }
  // Keeps a draft of the month being left, then loads the month being opened.
  function switchVals(fromKey, toKey) {
    var fp = fromKey.split(' '), now = monthVals(), base = recVals(fp[0], fp[1]), drafts = Object.assign({}, state.drafts || {});
    var same = Object.keys(now).every(function (id) {
      var f = findItem(id), b = base ? base[id] : amt(f.item.target);
      return Math.abs((b || 0) - now[id]) < 0.005;
    }) && (!base || Object.keys(base).length === Object.keys(now).length);
    if (same) delete drafts[fromKey]; else drafts[fromKey] = { at: Date.now(), vals: now };
    Object.keys(drafts).sort(function (a, b) { return drafts[b].at - drafts[a].at; }).slice(3).forEach(function (k) { delete drafts[k]; });
    var tp = toKey.split(' '), draft = drafts[toKey], vals = draft ? draft.vals : recVals(tp[0], tp[1]);
    state.drafts = drafts;   // so the month being opened can copy the one just left
    state.groups.forEach(function (g) { g.categories.forEach(function (c) { c.items.forEach(function (it) {
      it.budgeted = draft ? (vals[it.id] != null ? String(vals[it.id]) : (it.target || '')) : String(monthValFor(it, tp[0], tp[1]));
    }); }); });
    state.drafts = drafts; state.valsMonth = toKey;
  }
  function shiftMonth(dir) {
    var nowYear = new Date().getFullYear(), m = MONTHS.indexOf(state.month || MONTHS[new Date().getMonth()]), y = Number(state.year || nowYear);
    var from = MONTHS[m] + ' ' + y;
    m += dir; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
    switchVals(from, MONTHS[m] + ' ' + y);
    set({ month: MONTHS[m], year: String(y) });
  }
  /* Has this month been stamped, and has anything changed since? Compares each line's planned amount
     (and the lines themselves) with what was saved in Records when it was stamped. */
  function stampStatus(month, year) {
    var rec = state.records.filter(function (r) { return r.month === month && String(r.year) === String(year); })[0];
    if (!rec) return { state: 'none' };
    var d = new Date(rec.stampedAt || Date.now());
    var when = d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getFullYear();
    var now = [], then = [];
    state.groups.forEach(function (g) { g.categories.forEach(function (c) { c.items.forEach(function (it) { now.push(it.id + ':' + amt(it.budgeted)); }); }); });
    (rec.items || []).forEach(function (it) { then.push(it.id + ':' + recAmt(it)); });
    return { state: now.sort().join('|') === then.sort().join('|') ? 'stamped' : 'changed', when: when };
  }
  /* The month summary as two tidy rows: the month's totals, then what goes to each bank account. */
  // Opening PayStamp in a different month from the one your numbers belong to: switch them over.
  function syncMonthVals() {
    var month = state.month || MONTHS[new Date().getMonth()], year = state.year || String(new Date().getFullYear());
    if (!state.valsMonth) { state.valsMonth = month + ' ' + year; save(); }
    else if (state.valsMonth !== month + ' ' + year) { switchVals(state.valsMonth, month + ' ' + year); save(); }
  }
  function buildPage() {
    var month = state.month || MONTHS[new Date().getMonth()], year = state.year || String(new Date().getFullYear());
    syncMonthVals();
    var t = totals(), ok = Math.abs(t.zero) < 0.01;
    // The Monthly Planner heading, your stamps, then the month with arrows either side.
    var head = h('header', { class: 'head phd' }, [
      h('h1', { class: 'title', text: 'Monthly Planner' }),
      hello(),
      (function () { var sr = stampRow(); return sr ? withHi(h('div', { class: 'brand-row', id: 'tour-founder' }, [sr]), 'tour-founder') : null; })(),
      // v4.1: no big month line; the arrows sit at each end of the months and go one month at a time
      (function () { var s = stampStatus(month, year).state;
        return null; /* v4.1: shown as a tick on the month circle instead */ })(),
      // v4.3: just this month, in words, with arrows either side; the year small above it
      (function () {
        var st = (state.records || []).some(function (r) { return r.month === month && String(r.year) === String(year); });
        var wrap = h('div', { class: 'mpick', id: 'tour-month' }, [
          h('small', { class: 'mpick-y', text: String(year) }),
          h('div', { class: 'mpick-row' }, [
            btn('mbtn mpick-arr', 'Previous month', function () { shiftMonth(-1); }, [], { html: IC.chevL }),
            h('span', { class: 'mpick-m', 'aria-live': 'polite' }, [month,
              st ? h('span', { class: 'mpick-tick', title: 'Stamped', 'aria-label': 'stamped', html: TICK_SVG }) : null]),
            btn('mbtn mpick-arr', 'Next month', function () { shiftMonth(1); }, [], { html: IC.chevR }) ]) ]);
        return wrap; })() ]); // v4.1: split bar removed
    // Always in view while you plan: what's left to give a job.
    var content = h('main', { class: 'content sheet ' + sheetCls(), style: '--sh-cols:' + sheetCols() });
    content.append(h('div', { class: 'm-brand' }, [logoW(30), h('span', { text: 'PayStamp' }), offlinePill(), founderPill()]), h('div', { class: 'cur-corner' }, [curPick('pl-cur')]), head);
    // v3.7: no example-month card; everyone builds their plan when they start, and can rebuild it from the menu
    var nps = planSwitch(); if (nps) content.append(nps);
    if (nps && state.planView && state.planView !== 'mine') { content.append(newPlanPanel()); return h('div', { class: 'page' }, [content]); }
    var tre = trialEndedCard(); if (tre) content.append(tre);
    var pdb = paydayBanner(month, year); if (pdb) content.append(pdb);
    // v4.2: no emergency fund banner (it pointed to Compass, which has gone)
    var stc = startCard(); if (stc) content.append(stc);
    var apn = appNudge(); if (apn) content.append(apn);
    var rvc = reviewCard(); if (rvc) content.append(rvc);
    var yrc = yearShareCard(); if (yrc) content.append(yrc);
    content.append(sideToolbar()); if (sideOn().any) content.classList.add('has-side'); ['pct','auto','cost','notes'].forEach(function (k) { if (sideOn()[k]) content.classList.add('sd-' + k); });
    state.groups.filter(function (g) { return g.key === 'income'; }).forEach(function (g) { content.append(laneFor(g, t)); });
    fxCodes().forEach(function (code) { var fs = fxStrip(code); if (fs) content.append(fs); });
    var restWrap = withHi(h('div', { id: 'tour-categories', style: 'display:flex;flex-direction:column;gap:30px;border-radius:14px' }), 'tour-categories');
    state.groups.filter(function (g) { return g.key !== 'income'; }).forEach(function (g) { restWrap.append(laneFor(g, t)); });
    // Three states: not stamped yet, stamped (green), or changed since it was stamped (restamp to update Records).
    var st = stampStatus(month, year), stamp, my = month + ' ' + year;
    // v3.7: one clear stamp bar: "Stamp November 2026 in your Records"
    var SEAL = function (tick) { return '<svg viewBox="0 0 48 48" aria-hidden="true"><g transform="rotate(-12 24 24)"><circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" stroke-width="2.6"/><circle cx="24" cy="24" r="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.4 2.2"/>' + (tick ? '<path d="M16 24.5l5.5 5.5L32.5 18" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>' : '<text x="24" y="31" text-anchor="middle" font-family="Besley, Georgia, serif" font-size="20" fill="currentColor">P</text>') + '</g></svg>'; };
    if (st.state === 'stamped') stamp = withHi(h('div', { class: 'stamp-wrap', id: 'tour-stamp' }, [sideLane(
      h('div', { class: 'group sb-box sb-one done' + (state.stampFlash ? ' flash' : ''), 'data-g': 'stamp', role: 'status', title: 'Stamped on ' + st.when + '. Change anything above and you can restamp it.' }, ['Stamped ✓']))]), 'tour-stamp');
    else { var chg = st.state === 'changed', go1 = function () { stampMonth(); }; // v4.1: stamps straight away, no check first
      // v4.1: the stamp bar is a box like a category box: the words on the left, Stamp under the amounts.
      var sbox = h('button', { type: 'button', class: 'group sb-box sb-one' + (chg ? ' changed' : '') + (state.stampFlash ? ' flash' : ''), 'data-g': 'stamp', title: chg ? 'Changed since you stamped it. Press to restamp ' + my : 'Push ' + my + ' to your Records', 'aria-label': (chg ? 'Restamp ' : 'Stamp ') + my, onclick: go1 }, [chg ? 'Restamp' : 'Stamp']);
      stamp = withHi(h('div', { class: 'stamp-wrap', id: 'tour-stamp' }, [sideLane(sbox)]), 'tour-stamp'); }
    content.append(restWrap, zeroBox(t)); var bkb = bankBox(); if (bkb) content.append(bkb); content.append(stamp, fbCard('planner')); // v3.7: Extras box removed; summary tiles like the new plan
    if (window.PayStamp && window.PayStamp.preview) content.append(h('div', { class: 'status' }, [h('i'), 'Preview · changes stay in this browser']));
    return h('div', { class: 'page' }, [content]);
  }

  /* ---------- Budgeted, This Month, the total bars and the Extras box ----------
     Every line has a Budgeted amount (it.target: what the standing order sends, the same every month)
     and a This Month amount (it.budgeted). Each new month starts from Budgeted.
     Anything above Budgeted this month is sent by hand, and the Extras box adds it up. */
  function spendItems() {
    var out = [];
    state.groups.forEach(function (g) { if (g.key === 'income') return; g.categories.forEach(function (c) { c.items.forEach(function (it) { out.push({ it: it, g: g }); }); }); });
    return out;
  }
  // Changing Budgeted moves This Month with it when the two were the same.
  // v4.2: a new Budgeted amount means the standing order needs changing too, so its Automated tick comes off.
  function autoOff(it, was, now) { if (it.automated && amt(was) !== amt(now)) { it.automated = false; return true; } return false; }
  function setBudgeted(it, v) {
    if (autoOff(it, it.target, v)) showUndo('Automated is unticked for ' + (it.label || 'this line') + ': change the standing order, then tick it again.', null);
    if (amt(it.budgeted) === amt(it.target)) it.budgeted = v;
    it.target = v;
    var ent = linkedEntity(it); if (ent) { if (it.debtId) debtManual(); ent.monthly = v; it.syncM = v; }
    commit();
  }
  // Highlights This Month when it isn't the Budgeted amount.
  function decorateRow(row, it, isIncome, gkey) {
    dayDefault(row, it);
    // v4.3: comparing with last month: lines that changed a lot are highlighted, with the difference
    if (lastMode()) {
      var lv = lastVal(it), now = amt(it.budgeted);
      if (lv == null) return;
      var dd = now - lv;
      if (Math.abs(dd) < 0.005 || Math.abs(dd) < Math.max(10, Math.abs(lv) * 0.15)) return;
      row.classList.add('row-vs', dd > 0 ? 'vs-up' : 'vs-down');
      var up = isIncome || gkey === 'investSavings' ? dd < 0 : dd > 0;   // spending more, or paid or saving less, is the one to look at
      var tg = h('span', { class: 'vs-tag ' + (up ? 'warn' : 'good'), title: 'Last month: £' + fmt(lv) + '. This month: £' + fmt(now) + '.', text: (dd > 0 ? '↑ £' : '↓ £') + fmt(Math.abs(dd)) + ' on last month' });
      var nm0 = row.querySelector('.c-name');
      if (nm0.classList.contains('name-wrap')) nm0.append(tg); else { var w0 = h('div', { class: 'c-name name-wrap' }); nm0.classList.remove('c-name'); nm0.replaceWith(w0); w0.append(nm0, tg); }
      return;
    }
    if (isIncome) return;
    var d = amt(it.budgeted) - amt(it.target);
    if (Math.abs(d) < 0.005) return;
    row.classList.add('row-chg');
    var tag = h('span', { class: 'chg-tag', title: 'This month only. Budgeted is £' + fmt(amt(it.target)), text: (d > 0 ? '+' : '−') + '£' + fmt(Math.abs(d)) });
    var nm = row.querySelector('.c-name');
    if (nm.classList.contains('name-wrap')) { nm.append(tag); return; }
    var wrap = h('div', { class: 'c-name name-wrap' });
    nm.classList.remove('c-name'); nm.replaceWith(wrap); wrap.append(nm, tag);
  }
  function signed(n) { return (n < 0 ? '−£' : '£') + fmt(Math.abs(n)); }
  // v3.7: Left to allocate, stuck just under the top bar while you scroll the planner.
  function placeLeftStrip() {
    var nav = document.querySelector('.pnav'), r = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect() : null, top = r && r.height ? r.bottom + 10 : 10;
    document.documentElement.style.setProperty('--lt-top', Math.round(top) + 'px');
  }
  window.addEventListener('resize', placeLeftStrip);
  // Three bars lined up with the Budgeted and This Month columns: totals, left to allocate, per bank account.
  var TICK_SVG = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  /* Sent ticks: state.sent = { 'October 2026': { itemId: amountSent } }. A tick only counts while the
     amount is unchanged; if This Month changes afterwards, the line asks you to send the difference. */
  
  // What's still to send by hand this month: [{ it, g, d, sent }]

  /* ---------- the check before stamping ---------- */

  /* ---------- column explainers ---------- */
  var COL_TIPS = {
    tgt: 'Your plan for every month: where your pay is meant to go. Set it once and match your standing orders to it.',
    bud: 'Where your money is actually going this month. It starts the same as Budgeted; change it when this month is different.',
    tgtPay: 'The pay you plan around each month: your usual take-home pay, or your lowest if it changes.',
    budPay: 'What you’ve actually been paid this month. Anything above Budgeted Pay shows in Extras.' };
  function colHead(cls, isIncome) {
    var b = cls === 'c-tgt', label = b ? firstLabel(isIncome) : monthLabel();
    var tip = COL_TIPS[(b ? 'tgt' : 'bud') + (isIncome ? 'Pay' : '')];
    var q = h('button', { type: 'button', class: 'qtip', 'aria-label': 'What is ' + label + '?', 'data-tip': tip, text: '?' });
    q.addEventListener('click', function () { q.classList.toggle('tip-on'); clearTimeout(q.t); q.t = setTimeout(function () { q.classList.remove('tip-on'); }, 5000); });
    return h('span', { class: cls + ' col-q' }, [label, q]);
  }
  /* Small icons for lines linked to Debt, Savings or Investments. Click to open that page. */
  function linkIcon(page) { return IC[page.toLowerCase()] || ''; }

  /* ---------- currency symbol ----------
     Only changes the symbol shown. Nothing is converted. Every '£' the app writes
     goes through curText() in h(), so one setting changes it everywhere. */
  var CURS = [['GBP', '£', 'Pound sterling'], ['EUR', '€', 'Euro'], ['USD', '$', 'US dollar'], ['CAD', 'C$', 'Canadian dollar'], ['AUD', 'A$', 'Australian dollar'],
    ['NZD', 'NZ$', 'New Zealand dollar'], ['ZAR', 'R', 'South African rand'], ['INR', '₹', 'Indian rupee'], ['JPY', '¥', 'Japanese yen'], ['CHF', 'CHF ', 'Swiss franc'], ['NONE', '', 'No symbol']];
  function cur() { var c = CURS.find(function (x) { return x[0] === (state.currency || 'GBP'); }); return c ? c[1] : '£'; }
  function curText(s) { if (typeof s !== 'string' || s.indexOf('£') < 0) return s; var sym = cur(); return sym === '£' ? s : s.replace(/£/g, sym); }
  function moneyShow(v) { return v == null || String(v).trim() === '' ? '' : cur() + fmt(amt(v)); }
  function moneyRaw(s) { var c = calcAmount(s); if (c != null) { s = String(c); track('sum'); } return String(s).trim() === '' ? '' : String(Math.round(amt(s) * 100) / 100); }
  /* ---------- v3.4: accounts in other currencies ----------
     Off unless "I have accounts in other currencies" is on. Each bank or card can then have its own
     currency. A planner line takes the currency of the bank or card it's paid from or into, and its
     amounts are typed in that currency. Totals, percentages and Records add up in the home currency,
     using the rate you type in (what 1 of that currency is worth at home). Debts, savings and
     investments linked to a line are tracked in that line's currency. */
  function homeCode() { return state.currency || 'GBP'; }
  function guessCurrency() {
    // v4.3: the home page has already worked out where the visitor is (language and time zone)
    try { var PR = window.PS_REGION; if (PR && PR.region && PR.cur && CURS.some(function (c) { return c[0] === PR.cur; })) return PR.cur; } catch (e) {}
    try { var l = (navigator.language || '').toLowerCase(), r = l.split('-')[1] || '';
      var by = { us: 'USD', ca: 'CAD', au: 'AUD', nz: 'NZD', ie: 'EUR', de: 'EUR', fr: 'EUR', es: 'EUR', it: 'EUR', nl: 'EUR', be: 'EUR', pt: 'EUR', at: 'EUR', fi: 'EUR', gr: 'EUR', in: 'INR', za: 'ZAR', jp: 'JPY', ch: 'CHF', se: 'SEK', no: 'NOK', dk: 'DKK', pl: 'PLN', sg: 'SGD', hk: 'HKD', ae: 'AED', ng: 'NGN', ke: 'KES', gb: 'GBP' }[r];
      return by && CURS.some(function (c) { return c[0] === by; }) ? by : null; } catch (e) { return null; }
  }
  function multiCur() { return !!state.multiCur; }
  function curSym(code) { if (!code || code === homeCode()) return cur(); if (code === 'GBP') return 'GBP '; var c = CURS.find(function (x) { return x[0] === code; }); return c ? c[1] : code + ' '; }
  function curName(code) { var c = CURS.find(function (x) { return x[0] === code; }); return c ? c[2] : code; }
  var CUR_PL = { GBP: 'pounds', EUR: 'euros', USD: 'dollars', CAD: 'dollars', AUD: 'dollars', NZD: 'dollars', ZAR: 'rand', INR: 'rupees', JPY: 'yen', CHF: 'francs' };
  function curPlural(code) { return CUR_PL[code] || code; }
  function locByName(n) { return n ? (state.locations || []).find(function (l) { return l.name === n; }) : null; }
  function locCur(l) { return multiCur() && l && l.cur ? l.cur : homeCode(); }
  function itemCur(it) { return it ? locCur(locByName(it.account)) : homeCode(); }
  function fxRate(code) { if (!multiCur() || !code || code === homeCode()) return 1; var r = amt((state.fxRates || {})[code]); return r > 0 ? r : 1; }
  function fxHasRate(code) { return !multiCur() || !code || code === homeCode() || amt((state.fxRates || {})[code]) > 0; }
  function itemRate(it) { return fxRate(itemCur(it)); }
  function entCur(itemId) { var f = findItem(itemId); return f ? itemCur(f.item) : homeCode(); }
  function entRate(itemId) { return fxRate(entCur(itemId)); }
  function fxCodes() { var o = []; if (!multiCur()) return o; (state.locations || []).forEach(function (l) { if (l.cur && l.cur !== homeCode() && o.indexOf(l.cur) < 0) o.push(l.cur); }); return o; }
  function moneyAs(n, code) { return (n < 0 ? '-' : '') + curSym(code) + fmt(Math.abs(n)); }
  function recAmt(x) { return x.native != null ? Number(x.native) || 0 : Number(x.value) || 0; }
  // Shows a row's money boxes in another currency's symbol (the boxes keep their own numbers).
  function fxRow(row, code) {
    if (!code || code === homeCode()) return row;
    var sy = curSym(code);
    row.querySelectorAll('input[data-raw]').forEach(function (el) {
      el.dataset.sym = sy;
      if (String(el.dataset.raw).trim() !== '' && document.activeElement !== el) el.value = sy + fmt(amt(el.dataset.raw));
      if (el.placeholder === cur() + '0') el.placeholder = sy + '0';
    });
    return row;
  }
  function fxTag(code) { return code && code !== homeCode() ? h('span', { class: 'fx-tag', title: 'In ' + curName(code), text: curSym(code).trim() }) : null; }
  function multiCurRow() {
    var on = multiCur();
    return h('div', { class: 'cur-row fx-set' }, [h('div', { class: 'cur-t' }, [h('b', { text: 'I have accounts in other currencies' }), h('small', { text: on ? 'Pick a currency for each bank or card below. Your plan still adds up in ' + curPlural(homeCode()) + '.' : 'Turn on if you’re paid, or pay anything, in another currency.' })]),
      h('button', { type: 'button', class: 'sw', role: 'switch', 'aria-checked': String(on), 'aria-label': 'I have accounts in other currencies', onclick: function () { set({ multiCur: !on }); } }, [h('i')]) ]);
  }
  // v4.1: pick your currency from the top bar (and Bank accounts). It changes the symbol, not the amounts.
  function curPick(cls) {
    var sel = h('select', { class: 'cur-pick ' + (cls || ''), 'aria-label': 'Currency', title: 'Your currency', onchange: function (e) { track('currency', e.target.value); set({ currency: e.target.value }); } });
    CURS.forEach(function (c) { var o = document.createElement('option'); o.value = c[0]; o.textContent = c[0] === 'NONE' ? 'No symbol' : c[1].trim() + ' ' + c[0]; o.title = c[2]; sel.append(o); });
    sel.value = state.currency || 'GBP';
    return sel;
  }
  function currencyRow() {
    var sel = h('select', { class: 'cur-sel', id: 'f-currency', 'aria-label': 'Currency', onchange: function (e) { set({ currency: e.target.value }); } });
    CURS.forEach(function (c) { var o = document.createElement('option'); o.value = c[0]; o.textContent = c[1].trim() + '  ' + c[2]; sel.append(o); });
    sel.value = state.currency || 'GBP';
    var row = h('div', { class: 'cur-row' }, [h('div', { class: 'cur-t' }, [h('b', { text: 'Currency' }), h('small')]), sel]);
    row.querySelector('small').textContent = multiCur() ? 'Your home currency: the one you’re paid in. Every total adds up in it.' : 'The symbol shown next to your amounts. It doesn’t convert anything.';
    if (multiCur()) row.querySelector('b').textContent = 'Home currency';
    return row;
  }

  /* ---------- Paid on: follows the bank account unless you change it ----------
     A line with no day of its own shows its bank account's day, in a lighter style.
     Picking a day sets it for that line only; the bank account's day never changes.
     Picking "Bank day" goes back to following the account. */
  function bankDay(it) { var l = state.locations.find(function (x) { return x.name && x.name === it.account; }); return l && l.day ? String(l.day) : ''; }
  function dayDefault(row, it) {
    var sel = row.querySelector('.c-date'); if (!sel || sel.tagName !== 'SELECT') return;
    var bd = bankDay(it); if (!bd) return;
    sel.options[0].textContent = it.payDay ? 'Bank day' : '–';
    if (!it.payDay) {
      sel.value = bd; sel.classList.remove('is-empty'); sel.classList.add('is-bank');
      sel.title = 'Same day your ' + it.account + ' money moves. Change it here for this line only.';
    } else if (it.payDay !== bd) sel.title = 'Set for this line only. Pick Bank day to follow ' + it.account + ' again.';
  }

  /* ---------- undo after removing ---------- */
  var undoEl = null, undoT = 0;
  function showUndo(msg, fn, label) {
    if (!undoEl) { undoEl = document.createElement('div'); undoEl.className = 'undo-toast'; undoEl.setAttribute('role', 'status'); document.body.append(undoEl); }
    undoEl.innerHTML = ''; undoEl.append(h('span', { text: msg })); if (fn) undoEl.append(btn('undo-btn', label || 'Undo', function () { hideUndo(); fn(); }, [label || 'Undo']));
    undoEl.classList.add('on'); clearTimeout(undoT); undoT = setTimeout(hideUndo, 7000);
  }
  function hideUndo() { if (undoEl) undoEl.classList.remove('on'); }
  function removeItemWithUndo(it) {
    var f = findItem(it.id); if (!f) return;
    var ent = linkedEntity(it), prev = ent ? ent.monthly : null, cat = f.c, idx = f.idx;
    cat.items.splice(idx, 1); if (ent) ent.monthly = '';
    commit();
    showUndo('Removed ' + (it.label || 'item'), function () {
      cat.items.splice(Math.min(idx, cat.items.length), 0, it);
      if (ent) { ent.monthly = prev; it.syncM = prev; }
      commit();
    });
  }
  function removeCatWithUndo(g, c) {
    var idx = g.categories.indexOf(c); if (idx < 0) return;
    g.categories.splice(idx, 1); commit();
    showUndo('Removed ' + (c.name || 'category'), function () { g.categories.splice(Math.min(idx, g.categories.length), 0, c); commit(); });
  }

  /* ---------- fold a group (trial) ----------
     Each group can be folded down to its header and totals. Folded groups are remembered.
     A folded group still says if anything in it is different this month. */
  function foldGroup(card, g) {
    groupIcon(card, g);
    var head = card.querySelector('.group-head'); if (!head) return;
    var folded = !!(state.folded || {})[g.key];
    var toggle = function () { var f = Object.assign({}, state.folded || {}); if (f[g.key]) delete f[g.key]; else f[g.key] = true; set({ folded: f }); };
    if (folded) {
      card.classList.add('folded');
      var n = 0; g.categories.forEach(function (c) { c.items.forEach(function (it) { if (Math.abs(amt(it.budgeted) - amt(it.target)) >= 0.005) n++; }); });
      var items = g.categories.reduce(function (a, c) { return a + c.items.length; }, 0);
      var h2 = head.querySelector('h2');
      if (h2) h2.after.apply(h2, [h('span', { class: 'fold-note', text: items + (items === 1 ? ' line' : ' lines') }), n && g.key !== 'income' ? h('span', { class: 'fold-chg', text: n + (n === 1 ? ' change' : ' changes') + ' this month' }) : null].filter(Boolean));
    }
    var b = h('button', { type: 'button', class: 'fold-btn', 'aria-expanded': String(!folded), 'aria-label': (folded ? 'Open ' : 'Fold ') + g.title, title: folded ? 'Open' : 'Fold away', html: IC.down });
    b.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
    head.append(b);
    head.classList.add('foldable');
    head.addEventListener('click', function (e) { if (!e.target.closest('button, input, select, a')) toggle(); });
  }

  /* ---------- the example plan ----------
     New people start with an example month. They can clear it (with Undo) from the card at the
     top of the planner, or from the account menu, and start with their own numbers. */
  /* v3.7: the quick start in the planner. Build a plan in four steps, then compare it with this planner:
     tick the lines to add or update, or replace the whole planner. Records, pots, investments and debts stay. */
  var qsInst = null;
  var QS_GROUPS = { income: ['Income', '#7E2A55'], investSavings: ['Investments & Savings', '#1E6B47'], costs: ['Costs', '#9A3A30'], guiltFree: ['Fun', '#245F8C'] };
  function qsPrefill() {
    var g = findGroup('income'), first = g && g.categories[0] && g.categories[0].items[0];
    var pay = g ? groupSum(g, 'target') || groupSum(g, 'budgeted') : 0;
    var pd = first && first.payDay ? ({ '1': '1st', '15': '15th', '25': '25th', '28': '28th', last: 'Last working day' }[first.payDay] || '') : '';
    return state.isExample ? {} : { pay: pay ? String(pay) : '', payday: pd };
  }
  function quickInst() { if (!qsInst) qsInst = PSQuick.create({ mode: 'planner', result: quickCompare, onClose: closeQuick, prefill: qsPrefill(), isNew: function () { return !!state.isExample; } }); return qsInst; }
  function openQuick() { qsInst = null; set({ qsOpen: true, openMenu: null, overlay: null }); }
  function closeQuick() { qsInst = null; PSQuick.clearDraft(); set({ qsOpen: false, planView: state.qsPlan ? 'cmp' : state.planView }); }
  function buildQuick() {
    var box = h('div', { class: 'qs-box' }), ov = h('div', { class: 'overlay qs-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Quick start' }, [box]);
    quickInst().mount(box);
    return ov;
  }
  var qsNorm = function (x) { return String(x || '').trim().toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' '); };
  function qsMatch(l) {
    var g = findGroup(l.group); if (!g) return null;
    if (l.group === 'income') { for (var a = 0; a < g.categories.length; a++) if (g.categories[a].items[0]) return { item: g.categories[a].items[0], cat: g.categories[a] }; return null; }
    var names = [qsNorm(l.name)].concat(qsNorm(l.name).split(' or '));
    for (var i = 0; i < g.categories.length; i++) for (var j = 0; j < g.categories[i].items.length; j++) {
      var it = g.categories[i].items[j]; if (names.indexOf(qsNorm(it.label)) > -1) return { item: it, cat: g.categories[i] };
    }
    return null;
  }
  function qsAddLine(l) {
    var g = findGroup(l.group);
    if (!g) { var G = QS_GROUPS[l.group] || [l.group, '#6B6478']; g = { key: l.group, title: G[0], color: G[1], categories: [] }; state.groups.push(g); }
    var c = g.categories.find(function (x) { return x.id === l.cat; }) || g.categories.find(function (x) { return qsNorm(x.name) === qsNorm(l.catName); });
    if (!c) { c = { id: g.categories.some(function (x) { return x.id === l.cat; }) ? uid('cat') : l.cat, name: l.catName, items: [] }; g.categories.push(c); }
    var v = l.amount ? String(l.amount) : '';
    var it = { id: uid('it'), label: l.name, target: v, budgeted: v, account: '', runs: '', due: '', automated: false };
    if (l.payDay) it.payDay = l.payDay;
    if (l.payRule) it.payRule = l.payRule;
    if (l.account) it.account = l.account;   // v4.3: from Try it
    if (l.note) it.note = l.note;
    c.items.push(it);
  }
  function applyQuick(S, mode) {
    track('plan_built', mode);
    if (mode === 'replace' && !state.currency) { var gc = guessCurrency(); if (gc && gc !== 'GBP') state.currency = gc; } // v4.1: a first guess from the browser
    var snap = {}; SAVED_KEYS.forEach(function (k) { if (state[k] !== undefined) snap[k] = JSON.parse(JSON.stringify(state[k])); });
    var L = PSQuick.lines(S), picks = S.picks || {}, n = 0;
    if (state.qsOpen) state.planView = 'mine'; // from the pop-up: show your planner with the changes
    if (mode === 'replace') {
      if (state.isExample) blankPlan();
      state.groups.forEach(function (g) { if (QS_GROUPS[g.key]) g.categories.forEach(function (c) { c.items = []; }); });
      L.forEach(function (l) { qsAddLine(l); n++; });
    } else L.forEach(function (l) {
      if (!picks[l.key]) return;
      var m = qsMatch(l), v = l.amount ? String(l.amount) : '';
      if (m) { m.item.target = v; m.item.budgeted = v; if (l.payDay) m.item.payDay = l.payDay; if (l.payRule) m.item.payRule = l.payRule; } else qsAddLine(l);
      n++;
    });
    state.isExample = false; state.exampleHidden = true; state.qsOpen = false; qsInst = null;
    PSQuick.clearDraft();
    commit(); window.scrollTo(0, 0);
    showUndo(mode === 'replace' ? 'Your planner now uses your new plan.' : n + (n === 1 ? ' line' : ' lines') + ' added or updated.', function () { Object.keys(snap).forEach(function (k) { state[k] = snap[k]; }); commit(); });
  }
  function quickCompare(S, inst) {
    var E = PSQuick.el, money2 = PSQuick.money, L = PSQuick.lines(S), picks = S.picks || (S.picks = {});
    // Still on the example plan: nothing of yours to compare with, so show the plan and use it.
    if (!state.isExample) state.qsPlan = S; // v3.7: kept, so you can flip between it and your planner later
    if (state.isExample) return E('div', {}, [PSQuick.preview(S), E('div', { class: 'qs-acts' }, [E('button', { type: 'button', class: 'qs-btn', onclick: function () { applyQuick(S, 'replace'); } }, ['Use this as my plan'])]),
      E('p', { class: 'qs-note', text: 'This replaces the example plan with yours. You can add more to it straight away.' })]);
    var rows = L.map(function (l) {
      var m = qsMatch(l), now = m ? amt(m.item.target || m.item.budgeted) : null, st = !m ? 'new' : Math.abs(now - l.amount) < 0.005 ? 'same' : 'chg';
      if (picks[l.key] === undefined) picks[l.key] = st !== 'same' && !!l.amount; // blank amounts start unticked, so nothing gets wiped or added empty
      return { l: l, m: m, now: now, st: st };
    });
    var gcol = function (k) { return (QS_GROUPS[k] || ['', '#6B6478'])[1]; };
    var sel = rows.filter(function (r) { return picks[r.l.key] && r.st !== 'same'; }).length;
    var table = E('div', { class: 'qs-cmp', role: 'table', 'aria-label': 'Your new plan compared with your planner' }, [
      E('div', { class: 'qs-cmp-h', role: 'row' }, [E('span'), E('span', { text: 'Line' }), E('span', { text: 'Now' }), E('span', { text: 'New plan' }), E('span')]) ]
      .concat(rows.map(function (r) {
        var on = r.st !== 'same' && picks[r.l.key];
        var cb = E('input', { type: 'checkbox', class: 'qs-cb', 'aria-label': (r.st === 'new' ? 'Add ' : 'Update ') + r.l.name, disabled: r.st === 'same' });
        cb.checked = !!on;
        cb.addEventListener('change', function () { picks[r.l.key] = cb.checked; inst.redraw(); });
        return E('div', { class: 'qs-cmp-r' + (on || r.st === 'same' ? '' : ' off'), role: 'row', style: '--c:' + gcol(r.l.group) }, [cb,
          E('span', {}, [r.l.key === 'pay' ? 'Pay' : r.l.name, E('small', { text: r.m ? r.m.cat.name + (r.m.item.label && r.l.key !== 'pay' && qsNorm(r.m.item.label) !== qsNorm(r.l.name) ? ' · ' + r.m.item.label : '') : r.l.catName })]),
          E('span', { class: 'qs-v now', text: r.m ? money2(r.now) : '–' }),
          E('span', { class: 'qs-v', text: money2(r.l.amount) }),
          E('span', { class: 'qs-st ' + r.st, text: r.st === 'new' ? 'New line' : r.st === 'chg' ? (r.l.amount > r.now ? '+' : '−') + money2(Math.abs(r.l.amount - r.now)) : 'Same' }) ]);
      })));
    var acts = state.isExample
      ? [E('button', { type: 'button', class: 'qs-btn', onclick: function () { applyQuick(S, 'replace'); } }, ['Use this as my plan']),
         E('p', { class: 'qs-note', text: 'This replaces the example plan with yours. You can add more to it straight away.' })]
      : [E('div', { class: 'qs-acts' }, [
          E('button', { type: 'button', class: 'qs-btn', disabled: !sel, onclick: function () { applyQuick(S, 'add'); } }, [sel ? 'Add ' + sel + (sel === 1 ? ' ticked line' : ' ticked lines') + ' to my planner' : 'Tick a line to add it']),
          E('button', { type: 'button', class: 'qs-link', onclick: function () { applyQuick(S, 'replace'); } }, ['Replace my whole planner with this plan']) ]),
         E('p', { class: 'qs-note', text: 'Ticked lines that are already in your planner get the new amount. New ones are added to the right group. Replacing clears the lines in your planner and adds these instead; your Records, savings pots, investments and debts stay. You can undo either.' })];
    return E('div', {}, [table].concat(acts));
  }
  /* v3.7: once you've rebuilt a plan it's kept next to your planner. Flip between My planner, My new plan
     and Compare as often as you like, and add any lines from the new plan whenever you want. */
  function editNewPlan() { qsInst = null; quickInst().load(Object.assign(JSON.parse(JSON.stringify(state.qsPlan)), { step: 0 })); set({ qsOpen: true, openMenu: null }); }
  function dropNewPlan() {
    var keep = state.qsPlan; set({ qsPlan: null, planView: 'mine' });
    showUndo('New plan removed. Your planner hasn’t changed.', function () { set({ qsPlan: keep }); });
  }
  function planSwitch() {
    if (!state.qsPlan || state.isExample) return null;
    var v = state.planView || 'mine', seg = function (k, label) {
      return h('button', { type: 'button', class: 'np-seg' + (v === k ? ' on' : ''), 'aria-pressed': v === k ? 'true' : 'false', onclick: function () { set({ planView: k }); window.scrollTo(0, 0); } }, [label]); };
    return h('div', { class: 'np-bar', role: 'group', 'aria-label': 'Switch between your planner and your new plan' }, [
      h('div', { class: 'np-segs' }, [seg('mine', 'My planner'), seg('new', 'My new plan'), seg('cmp', 'Compare')]),
      h('div', { class: 'np-acts' }, [
        h('button', { type: 'button', class: 'np-link', onclick: editNewPlan }, ['Edit new plan']),
        h('button', { type: 'button', class: 'np-link', onclick: dropNewPlan }, ['Remove']) ]) ]);
  }
  function newPlanPanel() {
    var S = state.qsPlan, v = state.planView;
    if (v === 'new') return h('div', { class: 'qs np-panel' }, [
      h('div', { class: 'np-h' }, [h('h3', { text: 'My new plan' }), h('p', { text: 'This is the plan you rebuilt. Your planner hasn’t changed. Use Compare to add any lines from it.' })]),
      PSQuick.preview(S),
      h('div', { class: 'qs-acts' }, [h('button', { type: 'button', class: 'qs-btn', onclick: function () { set({ planView: 'cmp' }); } }, ['Compare with my planner'])]) ]);
    return h('div', { class: 'qs np-panel' }, [
      h('div', { class: 'np-h' }, [h('h3', { text: 'Compare' }), h('p', { text: 'Your planner now, next to your new plan. Tick any lines you want and add them. Come back any time to add more.' })]),
      quickCompare(S, { redraw: function () { commit(); } }) ]);
  }
  function blankPlan() {
    var cat = function (id, name, items) { return { id: id, name: name, items: items || [] }; };
    state.groups = [
      { key: 'income', title: 'Income', color: '#7E2A55', categories: [cat('cat_income', 'Job', [{ id: uid('it'), label: 'Salary', target: '', budgeted: '', account: '', runs: '', due: '', automated: false }])] },
      { key: 'investSavings', title: 'Investments & Savings', color: '#1E6B47', categories: [cat('cat_invest', 'Investments'), cat('cat_savings', 'Savings goals')] },
      { key: 'costs', title: 'Costs', color: '#9A3A30', categories: [cat('cat_fixed', 'Fixed costs'), cat('cat_subscriptions', 'Subscriptions')] },
      { key: 'guiltFree', title: 'Fun', color: '#245F8C', categories: [cat('cat_guilt', 'Fun')] } ];
    state.debts = []; state.savings = []; state.investments = []; state.locations = [];
    state.targets = []; state.notes = []; state.records = []; state.drafts = {}; state.sent = {};
    state.debtExtras = []; state.savingExtras = []; state.savingUsed = []; state.investExtras = []; state.investUsed = [];
    state.efundStarter = ''; state.efundMain = ''; state.isExample = false; state.exampleHidden = false;
  }
  function clearExample() {
    var snap = {}; SAVED_KEYS.forEach(function (k) { if (state[k] !== undefined) snap[k] = JSON.parse(JSON.stringify(state[k])); });
    blankPlan();
    commit(); window.scrollTo(0, 0);
    showUndo('Example cleared. Your planner is ready for your own numbers.', function () { Object.keys(snap).forEach(function (k) { state[k] = snap[k]; }); commit(); });
  }

  /* ---------- bank accounts: where pay lands and how money gets around ----------
     Nothing connects to a real bank. Each account just says whether pay goes in there,
     and for the others whether money arrives by standing order or is moved by hand. */
  /* ---------- v3.4: pay into more than one account ----------
     Each pay line says which account it's paid into (blank = your main account). An account
     with pay going into it is a pay-in account; there can be several. Your main account is the one
     with the most pay. For every account: what it pays out minus the pay it gets. More out than in:
     that much needs moving in. More in than out: the spare can move on to your other accounts. */
  function explicitPay(name) { var p = 0; var g = findGroup('income'); if (g) g.categories.forEach(function (c) { c.items.forEach(function (it) { if (it.account === name) p += amt(it.budgeted); }); }); return p; }
  function mainPayName() {
    var ls = (state.locations || []).filter(function (l) { return l.payIn && l.name; }); if (!ls.length) return '';
    return ls.reduce(function (b, l) { return explicitPay(l.name) > explicitPay(b.name) ? l : b; }, ls[0]).name;
  }
  function accFlow(name) {
    var pay = 0, out = 0, main = mainPayName();
    state.groups.forEach(function (g) { g.categories.forEach(function (c) { c.items.forEach(function (it) {
      if (g.key === 'income') { if ((it.account || main) === name) pay += amt(it.budgeted); }
      else if (it.account === name) out += amt(it.budgeted);
    }); }); });
    return { pay: pay, out: out, net: Math.round((out - pay) * 100) / 100 };
  }
  // Any account a pay line goes into is a pay-in account.
  function syncPayIns() {
    var g = findGroup('income'); if (!g || !state.locations) return;
    // a pay line with no account goes into your main account (decided before any new pay-in accounts)
    var main = mainPayName(); if (main) g.categories.forEach(function (c) { c.items.forEach(function (it) { if (!it.account) it.account = main; }); });
    g.categories.forEach(function (c) { c.items.forEach(function (it) { if (!it.account || !(amt(it.budgeted) > 0 || amt(it.target) > 0)) return; var l = locByName(it.account); if (l && !l.cardId && !l.payIn) l.payIn = true; }); });
  }
  /* Per bank account notes (v3.4.2): say exactly where the money goes, so the numbers add up.
     The main bank: pay in, paid from here, what moves on to each other bank or card, and anything
     that hasn't been given a job. Other banks: what moves in, and from where. */
  function flowNote(name) {
    var l = locByName(name); if (!l || l.cardId) return null;
    var f = accFlow(name), c = locCur(l), main = mainPayName();
    if (name === main && f.pay) {
      var parts = ['Pay in ' + moneyAs(f.pay, c)], moved = 0, to = [], spare = 0;
      if (f.out > 0.005) parts.push(moneyAs(f.out, c) + ' paid from here');
      (state.locations || []).forEach(function (o) {
        if (!o.name || o.name === main) return;
        if (o.cardId) { var cd = findDebt(o.cardId), sp = cd ? cardSpend(cd) : 0; if (sp > 0.005) { moved += sp; to.push(moneyAs(sp, c) + ' to pay off ' + o.name); } return; }
        var n = accFlow(o.name).net;
        if (n > 0.005) { moved += n; to.push(moneyAs(n, c) + ' to ' + o.name); }
        else if (n < -0.005 && o.payIn) spare += -n;
      });
      var noBank = spendItems().reduce(function (t, x) { return t + (x.it.account ? 0 : amt(x.it.budgeted)); }, 0);
      if (to.length) parts.push('moves on: ' + to.join(', '));
      if (noBank > 0.005) parts.push(moneyAs(noBank, c) + ' on lines with no bank set');
      var rest = Math.round((f.pay + spare - f.out - moved - noBank) * 100) / 100;
      if (rest > 0.005) parts.push(moneyAs(rest, c) + ' not given a job yet');
      else if (rest < -0.005) parts.push(moneyAs(-rest, c) + ' short: you’ve planned more than comes in');
      return parts.join(' · ');
    }
    if (l.payIn && f.pay) {
      if (f.net > 0.005) return 'Pay in ' + moneyAs(f.pay, c) + ' · ' + moneyAs(f.net, c) + ' moves in from ' + (main || 'your main bank');
      if (f.net < -0.005) return 'Pay in ' + moneyAs(f.pay, c) + ' · ' + moneyAs(-f.net, c) + ' left over, move it to ' + (main || 'your main bank');
      return 'Pay in ' + moneyAs(f.pay, c) + ' · all used here';
    }
    if (f.net > 0.005) return moneyAs(f.net, c) + ' moves in from ' + (main || 'your main bank');
    return null;
  }
  function payIntoLines(name) { return payLines().filter(function (it) { return (it.account || mainPayName()) === name && (amt(it.target) || amt(it.budgeted) || it.label); }); }
  function locHow(l) {
    var sel = h('select', { class: 'how-sel', 'aria-label': 'How money gets into ' + (l.name || 'this account'), onchange: function (e) {
      var v = e.target.value;
      if (v === 'pay') l.payIn = true; // more than one account can have pay going in
      else { l.payIn = false; l.how = v; }
      commit(); } });
    [['pay', 'Pay goes in here'], ['auto', 'Standing order'], ['hand', 'I move it by hand']].forEach(function (o) { var e = document.createElement('option'); e.value = o[0]; e.textContent = o[1]; sel.append(e); });
    sel.value = l.payIn ? 'pay' : (l.how || 'auto');
    return sel;
  }

  /* ---------- Records as one neat table ----------
     Months across the top (newest on the right), groups down the side in their planner colours.
     Click a group to open its lines, or switch to Every line. The last column shows only what changed. */
  /* v3.7: Records you can edit. Change any number, rename or remove a line, add a line or a month.
     Totals are worked out again from the lines. Restamping a month from the planner replaces it. */
  function incomeTitle() { var g = findGroup('income'); return g ? g.title : 'Income'; }
  function recTotals(r) {
    var it = incomeTitle(), inc = 0, al = 0;
    (r.items || []).forEach(function (x) { var v = Number(x.value) || 0; if ((x.groupTitle || '') === it) inc += v; else al += v; });
    r.incomeTotal = Math.round(inc * 100) / 100; r.allocatedTotal = Math.round(al * 100) / 100; r.balance = Math.round((inc - al) * 100) / 100; r.edited = true;
  }
  function recSetVal(r, line, v) {
    var x = (r.items || []).find(function (y) { return y.id === line.id; });
    if (!x) { x = { id: line.id, name: line.name, groupTitle: line.groupTitle, color: line.color, value: 0 }; (r.items = r.items || []).push(x); }
    x.value = Math.round(amt(v) * 100) / 100; delete x.native; delete x.cur;
    recTotals(r); commit();
  }
  function recRename(id, name) { state.records.forEach(function (r) { (r.items || []).forEach(function (x) { if (x.id === id) x.name = name; }); }); commit(); }
  function recRemoveLine(id, name) {
    var kept = state.records.map(function (r) { return { r: r, items: (r.items || []).slice() }; });
    state.records.forEach(function (r) { r.items = (r.items || []).filter(function (x) { return x.id !== id; }); recTotals(r); });
    commit();
    showUndo('Removed ' + (name || 'line') + ' from your Records', function () { kept.forEach(function (k) { k.r.items = k.items; recTotals(k.r); }); commit(); });
  }
  function recRemoveMonth(r) {
    var i = state.records.indexOf(r); if (i < 0) return;
    state.records.splice(i, 1); commit();
    showUndo('Removed ' + r.month + ' ' + r.year + ' from your Records', function () { state.records.splice(i, 0, r); commit(); });
  }
  // A new month starts as a copy of the nearest month before it (or after, if there's none), ready to change.
  function recAddMonth(month, year) {
    var key = Number(year) * 12 + MONTHS.indexOf(month);
    if (state.records.some(function (r) { return r.month === month && String(r.year) === String(year); })) { set({ recMsg: month + ' ' + year + ' is already in your Records.' }); return; }
    var byIdx = state.records.map(function (r) { return { r: r, k: Number(r.year) * 12 + MONTHS.indexOf(r.month) }; });
    var before = byIdx.filter(function (x) { return x.k < key; }).sort(function (a, b) { return b.k - a.k; })[0], after = byIdx.filter(function (x) { return x.k > key; }).sort(function (a, b) { return a.k - b.k; })[0];
    var src = (before || after || {}).r;
    var items = src ? (src.items || []).map(function (x) { return { id: x.id, name: x.name, groupTitle: x.groupTitle, categoryName: x.categoryName, color: x.color, value: Number(x.value) || 0, debtId: x.debtId, savingId: x.savingId, investmentId: x.investmentId }; }) :[];
    // No months yet: start from your plan's Budgeted amounts.
    if (!src) state.groups.forEach(function (g) { g.categories.forEach(function (c) { c.items.forEach(function (it) {
      items.push({ id: it.id, name: it.label || 'Untitled', groupTitle: g.title, categoryName: c.name || 'Untitled', color: g.color, value: amt(it.target), debtId: it.debtId || undefined, savingId: it.savingId || undefined, investmentId: it.investmentId || undefined, coupleId: it.coupleId || undefined });
    }); }); });
    var r = { id: uid('rec'), month: month, year: String(year), stampedAt: new Date().toISOString(), items: items, addedByHand: true };
    recTotals(r); state.records.push(r); state.recMsg = null; state.recYear = Number(year); state.recAddMonth = null;
    commit();
  }
  // Preview and example plan: three made-up months, so you can see how Records work.
  function exampleRecords() {
    if ((state.records || []).length) return false;
    var now = monthIndexNow(), inc0 = incomeTitle();
    state.records = [3, 2, 1].map(function (back, k) {
      var i = now - back, items = [], inc = 0, al = 0;
      state.groups.forEach(function (g) { g.categories.forEach(function (c) { c.items.forEach(function (it) {
        var v = amt(it.target) || amt(it.budgeted), nm = it.label || '';
        if (g.key === 'income') v += [0, 120, 60][k];
        if (/grocer/i.test(nm)) v = [212, 236, 224][k];
        if (/eating out/i.test(nm)) v = [280, 320, 295][k];
        items.push({ id: it.id, name: nm || 'Untitled', groupTitle: g.title, categoryName: c.name || 'Untitled', color: g.color, value: v, debtId: it.debtId || undefined, savingId: it.savingId || undefined, investmentId: it.investmentId || undefined, coupleId: it.coupleId || undefined });
      }); }); });
      items.forEach(function (x) { if (x.groupTitle === inc0) inc += x.value; else al += x.value; });
      // the spare goes to Shopping, so most months add up to £0
      var shop = items.filter(function (x) { return /shopping/i.test(x.name); })[0], gap = Math.round((inc - al) * 100) / 100;
      if (shop && k < 2) { shop.value = Math.max(0, Math.round((shop.value + gap) * 100) / 100); }
      var r = { id: uid('rec'), month: MONTHS[i % 12], year: String(Math.floor(i / 12)), stampedAt: new Date().toISOString(), items: items, isExample: true };
      recTotals(r); delete r.edited; return r;
    });
    commit(); return true;
  }
  // v3.7: each line's colour comes from the planner item (you can change it there), or its group.
  function lineColor(id, fallback) { var f = findItem(id); return f ? (f.item.color || f.g.color) : freshCol(fallback) || '#6B6478'; }
  var recScrolled = false, recDrag = null;
  function recDragStart(e) {
    if (e.button != null && e.button !== 0) return;
    var row = e.currentTarget.closest('.rt-it'); if (!row) return;
    e.preventDefault();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    row.classList.add('rt-dragging'); document.body.classList.add('dragging');
    recDrag = { row: row };
    var move = function (ev) {
      var hit = document.elementFromPoint(ev.clientX, ev.clientY), t = hit && hit.closest('.rt-it[data-line]');
      if (!t || t === row || t.parentNode !== row.parentNode) return;
      var r = t.getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) t.before(row); else t.after(row);
    };
    var up = function () {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      row.classList.remove('rt-dragging'); document.body.classList.remove('dragging'); recDrag = null;
      state.recOrder = Array.prototype.map.call(document.querySelectorAll('.rt-it[data-line]'), function (x) { return x.dataset.line; });
      commit();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }
  /* v3.7: Records, one year at a time. Two tables like the planner: Income, then Where your money went,
     each totalled, then the zero-based balance (pay minus spending). Add a month at the top. */
  function recordsTable(allRecs) {
    var inc0 = incomeTitle(), nowI = monthIndexNow(), thisY = Math.floor(nowI / 12);
    var years = []; allRecs.forEach(function (r) { var y = Number(r.year); if (years.indexOf(y) < 0) years.push(y); });
    if (years.indexOf(thisY) < 0) years.push(thisY);
    years.sort(function (a, b) { return a - b; });
    var yr = state.recYear != null && years.indexOf(Number(state.recYear)) > -1 ? Number(state.recYear) : (allRecs.length ? Number(allRecs[allRecs.length - 1].year) : thisY);
    var shown = allRecs.filter(function (r) { return Number(r.year) === yr; });
    var yi = years.indexOf(yr);
    var nav = h('div', { class: 'mnav rx-nav' }, [
      btn('mbtn', 'Previous year', function () { if (yi > 0) set({ recYear: years[yi - 1], recMsg: null }); }, [], { html: IC.chevL, disabled: yi <= 0 }),
      h('span', { class: 'mlabel rx-year', 'aria-live': 'polite', text: String(yr) }),
      btn('mbtn', 'Next year', function () { if (yi < years.length - 1) set({ recYear: years[yi + 1], recMsg: null }); }, [], { html: IC.chevR, disabled: yi >= years.length - 1 }) ]);
    // v3.7: add a month with the + that shows between month names (or before/after them)
    var have = {}; shown.forEach(function (r) { have[r.month] = 1; });
    var free = MONTHS.filter(function (m, i) { return !have[m] && yr * 12 + i <= nowI; });
    var top = h('div', { class: 'rx-top' }, [nav]);
    if (!shown.length) return h('div', { class: 'rt-wrap' }, [top, state.recMsg ? h('p', { class: 'fb-err', text: state.recMsg }) : null,
      h('div', { class: 'empty' }, ['Nothing in ' + yr + ' yet. Stamp a month from your planner' + (free.length ? ', or ' : '.'),
        free.length ? btn('cp-inline', 'Add ' + free[free.length - 1] + ' ' + yr, function () { recAddMonth(free[free.length - 1], yr); }, ['add ' + free[free.length - 1] + ' by hand']) : null])]);
    // every line, in planner order (or the order you dragged them into)
    var info = {}, order = [];
    shown.forEach(function (r) { (r.items || []).forEach(function (x) {
      if (!info[x.id]) info[x.id] = { id: x.id, name: x.name, groupTitle: x.groupTitle || 'Other', color: x.color };
      else { info[x.id].name = x.name; info[x.id].groupTitle = x.groupTitle || info[x.id].groupTitle; }
    }); });
    state.groups.forEach(function (g) { g.categories.forEach(function (c) { c.items.forEach(function (it) { if (info[it.id] && order.indexOf(it.id) < 0) order.push(it.id); }); }); });
    Object.keys(info).forEach(function (id) { if (order.indexOf(id) < 0) order.push(id); });
    if (state.recOrder && state.recOrder.length) {
      var pos = {}; state.recOrder.forEach(function (id, i) { pos[id] = i; });
      order = order.map(function (id, i) { return { id: id, i: i }; }).sort(function (a, b) { var pa = pos[a.id], pb = pos[b.id]; if (pa != null && pb != null) return pa - pb; if (pa != null) return -1; if (pb != null) return 1; return a.i - b.i; }).map(function (x) { return x.id; });
    }
    var lines = order.map(function (id) { var x = info[id]; x.col = lineColor(id, x.color); return x; });
    var incLines = lines.filter(function (x) { return x.groupTitle === inc0; }), outLines = lines.filter(function (x) { return x.groupTitle !== inc0; });
    // add a new line just under another one (same group), or at the top of a table
    function recInsertAfter(afterId, groupTitle) {
      var gt = groupTitle || (outLines[0] ? outLines[0].groupTitle : (state.groups.filter(function (g) { return g.key !== 'income'; })[0] || {}).title || 'Costs');
      var id = uid('rx'), col = colorOf(gt);
      shown.forEach(function (r) { (r.items = r.items || []).push({ id: id, name: 'New line', groupTitle: gt, color: col, value: 0 }); recTotals(r); });
      var o = order.slice(), at;
      if (afterId) at = o.indexOf(afterId) + 1;
      else { var first = (gt === inc0 ? incLines : outLines)[0]; at = first ? o.indexOf(first.id) : o.length; }
      o.splice(at < 0 ? o.length : at, 0, id); state.recOrder = o;
      commit();
      setTimeout(function () { var e = document.getElementById('f-rxn-' + id); if (e) { e.focus(); e.select(); } }, 0);
    }
    var val = function (r, id) { var f = (r.items || []).find(function (x) { return x.id === id; }); return f ? Number(f.value) || 0 : 0; };
    var ph = innerWidth <= 640;
    var cols = 'grid-template-columns:' + (ph ? '20px minmax(132px,1fr)' : '24px minmax(190px,1fr)') + ' repeat(' + shown.length + ',' + (ph ? '76px' : 'minmax(96px,120px)') + ')';
    var groupTitles = state.groups.map(function (g) { return g.title; });
    var colorOf = function (title) { var g = state.groups.filter(function (x) { return x.title === title; })[0]; return g ? g.color : '#6B6478'; };
    var monthHead = function (label) {
      var hd = h('div', { class: 'rx-r rx-hd', style: cols }, [h('span'), h('span', { class: 'rx-hl', text: label })]);
      hd.lastChild.style.position = 'sticky';
      var addM = function (k, side) { var m = MONTHS[k - yr * 12];
        return btn('rx-plus m ' + side, 'Add ' + m + ' ' + yr, function (e) { e.stopPropagation(); recAddMonth(m, yr); }, ['+'], { title: 'Add ' + m }); };
      var okK = function (k) { return k >= yr * 12 && k < yr * 12 + 12 && k <= nowI && !have[MONTHS[k - yr * 12]]; };
      hd.append(h('span', { class: 'rx-ins-cell' }, [btn('rx-plus l top', 'Add a line at the top', function () { recInsertAfter(null, label === 'Pay' ? inc0 : null); }, ['+'], { title: 'Add a line' })]));
      shown.forEach(function (r, i) {
        var k = Number(r.year) * 12 + MONTHS.indexOf(r.month);
        hd.append(h('span', { class: 'rx-mh' }, [
          okK(k - 1) ? addM(k - 1, 'before') : null,
          i === shown.length - 1 && okK(k + 1) ? addM(k + 1, 'after') : null,
          btn('rx-month', 'Open ' + r.month + ' ' + r.year + ' in the planner', function () { openRecordMonth(r); }, [r.month.slice(0, 3), r.isExample ? h('small', { text: 'Example' }) : null]),
          btn('rx-mx', 'Remove ' + r.month + ' ' + r.year + ' from your Records', function () { recRemoveMonth(r); }, ['✕'], { title: 'Remove ' + r.month }) ]));
      });
      return hd;
    };
    var lineRow = function (it) {
      var ir = h('div', { class: 'rx-r rx-it rt-it', 'data-line': it.id, style: cols + ';--ld:' + it.col }, [
        h('button', { type: 'button', class: 'rt-grip', 'aria-label': 'Drag to move ' + it.name, title: 'Drag to move', html: GRIP, onpointerdown: recDragStart }),
        h('span', { class: 'rx-name' }, [btn('rx-plus l', 'Add a line under ' + it.name, function () { recInsertAfter(it.id, it.groupTitle); }, ['+'], { title: 'Add a line here' }),
          field('rxn-' + it.id, it.name, function (v) { recRename(it.id, String(v || '').trim() || 'Untitled'); }, { cls: 'rt-in rt-name', label: 'Name of this line' }),
          btn('rx-lx', 'Remove ' + it.name + ' from your Records', function () { recRemoveLine(it.id, it.name); }, ['✕'], { title: 'Remove this line' }) ])]);
      shown.forEach(function (r) { ir.append(field('rxv-' + r.id + '-' + it.id, String(val(r, it.id)), function (v) { recSetVal(r, it, v); }, { cls: 'rt-in num', num: true, money: true, label: it.name + ', ' + r.month + ' ' + r.year })); });
      return ir;
    };
    var totRow = function (label, fn, cls) {
      var r = h('div', { class: 'rx-r ' + cls, style: cols }, [h('span'), h('span', { class: 'rx-tl', text: label })]);
      shown.forEach(function (x) { r.append(h('span', { class: 'rx-n', text: signed(fn(x)) })); });
      return r;
    };
    var table = function (title, color, list, totalLabel, totalFn, addFn, grouped) {
      var body = h('div', { class: 'rx-body' });
      if (!grouped) list.forEach(function (it) { body.append(lineRow(it)); });
      else {
        var gts = []; list.forEach(function (x) { if (gts.indexOf(x.groupTitle) < 0) gts.push(x.groupTitle); });
        gts.sort(function (a, b) { var ia = groupTitles.indexOf(a), ib = groupTitles.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
        gts.forEach(function (gt) {
          var gl = list.filter(function (x) { return x.groupTitle === gt; }), gc = colorOf(gt);
          var gh = h('div', { class: 'rx-r rx-gh', style: cols + ';--gc:' + gc }, [h('span'), h('span', { class: 'rx-tl', text: gt })]);
          shown.forEach(function (r) { gh.append(h('span', { class: 'rx-n', text: gl.length > 1 ? '£' + fmt(gl.reduce(function (a, x) { return a + val(r, x.id); }, 0)) : '' })); });
          var gb = h('div', { class: 'rx-gbody' }); gl.forEach(function (it) { gb.append(lineRow(it)); });
          body.append(gh, gb);
        });
      }
      var t = h('div', { class: 'rx-t', style: '--g:' + color }, [monthHead(title === 'Income' ? 'Pay' : 'Line'), body,
        totRow(totalLabel, totalFn, 'rx-tot')]);
      return h('div', { class: 'rx-block' }, [h('div', { class: 'rx-scroll' }, [t])]);
    };
    // v3.7: income is one bar with its totals; open it to see and change the lines
    var incOpen = !!state.recIncOpen;
    var incBar = h('div', { class: 'rx-r rx-inc', style: cols, role: 'button', tabindex: '0', 'aria-expanded': String(incOpen), onclick: function (e) { if (!e.target.closest('input, .rx-mx, .rx-month')) set({ recIncOpen: !incOpen }); },
      onkeydown: function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); set({ recIncOpen: !incOpen }); } } },
      [h('span', { class: 'rx-chev', html: IC.down || '▾' }), h('span', { class: 'rx-tl' }, ['Income', h('small', { text: incOpen ? 'Hide lines' : 'Show ' + incLines.length + (incLines.length === 1 ? ' line' : ' lines') })])]);
    shown.forEach(function (r) { incBar.append(h('span', { class: 'rx-n' }, [incOpen ? null : h('small', { text: r.month.slice(0, 3) }), '£' + fmt(Number(r.incomeTotal) || 0)])); });
    var incBody = h('div', { class: 'rx-body' }); if (incOpen) incLines.forEach(function (it) { incBody.append(lineRow(it)); });
    var incT = h('div', { class: 'rx-block' }, [h('div', { class: 'rx-scroll' }, [h('div', { class: 'rx-t inc' + (incOpen ? ' open' : ''), style: '--g:' + colorOf(inc0) }, incOpen ? [monthHead('Pay'), incBody, incBar] : [incBar])]),
      ]);
    var outT = table('Where your money went', '#2B2433', outLines, 'Total', function (r) { return Number(r.allocatedTotal) || 0; }, null, false);
    // zero-based balance: pay minus spending
    var zb = h('div', { class: 'rx-r rx-zb', style: cols }, [h('span'), h('span', { class: 'rx-tl' }, ['Zero-based balance', h('small', { text: 'Pay minus where it went' })])]);
    shown.forEach(function (r) { var v = Number(r.balance) || 0, ok = Math.abs(v) < 0.005;
      zb.append(h('span', { class: 'rx-n ' + (ok ? 'ok' : v < 0 ? 'over' : 'left'), title: ok ? 'Every pound had a job' : v < 0 ? 'Spent more than you were paid' : 'Not given a job', text: (ok ? '✓ ' : '') + signed(v) })); });
    var zbT = h('div', { class: 'rx-scroll' }, [h('div', { class: 'rx-t zb', style: '--g:#1E6B47' }, [zb])]);
    if (!recScrolled) setTimeout(function () { document.querySelectorAll('.rx-scroll').forEach(function (e) { e.scrollLeft = e.scrollWidth; }); recScrolled = true; }, 0);
    return h('div', { class: 'rt-wrap' }, [top, state.recMsg ? h('p', { class: 'fb-err', text: state.recMsg }) : null, incT, outT, zbT,
      h('p', { class: 'rt-hint', text: (shown.some(function (r) { return r.isExample; }) ? 'These are example months, so you can see how Records work. ' : '') + 'Click any name or amount to change it, like a spreadsheet. Hover between lines for + to add one, or next to a month name for + to add a month. Drag ⠿ to move a line, ✕ to remove. Click a month to open it in your planner.' })]);
  }
  function openRecordMonth(r) {
    var cur = (state.month || MONTHS[new Date().getMonth()]) + ' ' + (state.year || String(new Date().getFullYear())), to = r.month + ' ' + r.year;
    if (cur !== to) switchVals(cur, to);
    state.month = r.month; state.year = String(r.year);
    go('plan'); setTimeout(function () { window.scrollTo(0, 0); }, 0);
  }

  /* ---------- setup for new people ----------
     A welcome choice (set up my plan, or look at the example), then four steps:
     pay, accounts, regular payments, and a summary. Nothing connects to a bank. */

  /* ---------- Debt, Savings and Investments: same layout, refined ----------
     Each page body is built as before, then tidied here: a headline card at the top, a progress
     line and a plain sentence under every name, "+ Add to plan" instead of £0, "?" tips instead of
     the grey paragraph, and the folded sections as a neat grid of cards with icons and a status. */
  var GOAL_IC = {
    calc: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M8 7h8M8 12h2M12 12h.01M16 12h.01M8 16h2M12 16h.01M16 16h.01"/></svg>',
    shield: '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    out: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/></svg>' };
  function goalHero(kicker, big, sub, sideTag, sideText) {
    return h('section', { class: 'g-hero' }, [
      h('div', { class: 'g-hero-main' }, [h('small', { text: kicker }), h('b', { text: big }), h('span', { text: sub })]),
      sideTag || sideText ? h('div', { class: 'g-hero-side' }, [sideTag ? h('em', { text: sideTag }) : null, sideText ? h('span', { text: sideText }) : null]) : null ]);
  }
  function qTip(label, tip) {
    var q = h('button', { type: 'button', class: 'qtip', 'aria-label': 'What is ' + label + '?', 'data-tip': tip, text: '?' });
    q.addEventListener('click', function () { q.classList.toggle('tip-on'); clearTimeout(q.t); q.t = setTimeout(function () { q.classList.remove('tip-on'); }, 5000); });
    return q;
  }
  function tipHead(body, cls, label, tip) {
    var s = body.querySelector('.colhead .' + cls); if (!s) return;
    s.textContent = ''; s.classList.add('col-q'); s.append(label); if (tip) s.append(qTip(label, tip));
  }
  function goalRow(row, o) {
    var nameEl = row.querySelector('.d-name'); if (!nameEl) return;
    var top;
    if (nameEl.tagName === 'INPUT') { nameEl.classList.remove('d-name'); top = h('div', { class: 'dn-top' }); nameEl.replaceWith(top); top.append(nameEl); }
    else { top = nameEl; top.className = 'dn-top'; }
    var wrap = h('div', { class: 'd-name dn' }); top.replaceWith(wrap); wrap.append(top);
    if (o.itemId) { var ft = fxTag(entCur(o.itemId)); if (ft) top.append(ft); }
    if (o.inPlan) top.append(h('button', { type: 'button', class: 'link-tag', 'data-tip': 'In your planner. Click to go to it.', 'aria-label': 'Show ' + (o.name || 'this') + ' in your Monthly Planner', html: IC[o.icon], onclick: function () { openInPlanner(o.itemId); } }));
    wrap.append(h('div', { class: 'dn-bar', style: '--bc:' + (o.color || '#7E2A55') }, [h('i', { style: 'width:' + Math.max(0, Math.min(100, o.pct || 0)).toFixed(1) + '%' })]));
    var sub = h(o.onSub ? 'button' : 'span', { class: 'dn-sub' + (o.nudge ? ' nudge' : '') + (o.onSub ? ' more' : ''), type: o.onSub ? 'button' : null, onclick: o.onSub || null, 'aria-expanded': o.onSub ? String(!!o.open) : null }, [o.sub]);
    if (o.onSub) sub.append(h('span', { class: 'dn-chev', text: o.open ? '▴' : '▾' }));
    wrap.append(sub);
    var pay = row.querySelector('.d-pay');
    if (pay && !o.inPlan && !amt(o.monthly) && !(state.pxShow || {})[o.id]) {
      pay.innerHTML = '';
      pay.append(btn('add-plan', 'Add ' + (o.name || 'this') + ' to your plan', function () {
        var s = Object.assign({}, state.pxShow || {}); s[o.id] = true; state.pxShow = s; scheduleRender();
        setTimeout(function () { var n = document.querySelector('[data-k="' + o.payKey + '"]'); if (n) n.focus(); }, 60);
      }, ['+ Add to plan']));
      row.classList.add('not-in-plan');
    }
  }
  function goalSections(body, status) {
    var secs = Array.prototype.slice.call(body.querySelectorAll(':scope > div > .dsec.prev, :scope > .dsec.prev'));
    if (!secs.length) return;
    var grid = h('div', { class: 'sec-grid' }); secs[0].before(grid);
    secs.forEach(function (s) {
      grid.append(s);
      var t = s.querySelector('.prev-toggle'), h4 = t && t.querySelector('h4'); if (!h4) return;
      var title = h4.textContent, ic = /What if/.test(title) ? 'calc' : /Emergency/.test(title) ? 'shield' : /before/.test(title) ? 'clock' : 'out';
      if (/What if Calculator/.test(title)) h4.textContent = 'What if';
      t.prepend(h('span', { class: 'sec-ic', html: GOAL_IC[ic] }));
      var st = status && status(title), sm = t.querySelector('small');
      if (st && sm) { sm.textContent = st.text; if (st.cls) sm.className = st.cls; }
    });
  }
  function tidyGoalBody(body) {
    var hint = body.querySelector('.debt-hint'); if (hint) hint.remove();
    var ov = body.querySelector('.debt-overall, .inv-sum'); if (ov) ov.remove();
    return body.firstChild;
  }

  // Debts with a minimum payment that isn't in the planner. The debt-free date counts those minimums, so the plan should too.
  function missingMinDebts() { if (debtAuto()) return []; return state.debts.filter(function (d) { return amt(d.min) > 0 && debtLeft(d) > 0.005 && !findItem(debtItemId(d)); }); }
  function minsMissing() {
    var ds = missingMinDebts(); if (!ds.length) return null;
    var tot = ds.reduce(function (t, d) { return t + amt(d.min) * entRate(debtItemId(d)); }, 0);
    return h('div', { class: 'cp-tip warn mins-miss' }, [
      h('span', {}, [h('b', { text: money(tot) + ' of minimum payments aren’t in your plan. ' }), (ds.length === 1 ? ds[0].name || 'One debt' : ds.map(function (d) { return d.name || 'Untitled'; }).join(', ')) + (ds.length === 1 ? ' has' : ' have') + ' a minimum but no line in your planner, so your plan may look like it adds up when it doesn’t.']),
      btn('pill-btn primary', 'Add the minimums to my plan', function () {
        ds.forEach(function (d) { if (!amt(d.monthly)) d.monthly = String(amt(d.min)); addDebtToPlanner(d); });
        commit(); showUndo('Added ' + ds.length + (ds.length === 1 ? ' minimum' : ' minimums') + ' to your plan', function () { ds.forEach(function (d) { removeDebtFromPlanner(d); }); commit(); });
      }, ['Add ' + (ds.length === 1 ? 'it' : 'them') + ' to my plan']) ]);
  }
  function debtBody2() {
    var body = debtBody(), first = tidyGoalBody(body);
    var cur = debtAuto() ? debtBudget() : state.debts.reduce(function (s, d) { return s + (debtLeft(d) > 0.005 ? Math.max(amt(debtMonthly(d)), amt(d.min)) * entRate(debtItemId(d)) : 0); }, 0);
    var leftAll = state.debts.reduce(function (s, d) { return s + debtLeft(d) * entRate(debtItemId(d)); }, 0), sim = payoffSim(cur);
    var big, sub;
    // v4.1: "I'm debt free", at the top. Tick it when your debts are paid off, or if you have none.
    var DF = state.debtFree, dfOn = !!(DF && DF.at);
    body.prepend(h('section', { class: 'df-card' + (dfOn ? ' on' : '') }, [
      h('button', { type: 'button', class: 'df-tick', role: 'checkbox', 'aria-checked': String(dfOn), 'aria-label': 'I’m debt free',
        onclick: function () { if (dfOn) { var old = state.debtFree; state.debtFree = null; commit(); showUndo('Unticked debt free', function () { state.debtFree = old; commit(); }); } else { state.debtFree = { at: new Date().toISOString() }; track('debt_free'); commit(); } } },
        [h('span', { class: 'df-box', html: dfOn ? TICK_SVG : '' }), h('span', { class: 'df-t' }, [h('b', { text: dfOn ? 'You’re debt free' : 'I’m debt free' }),
          h('small', { text: dfOn ? 'Ticked on ' + longDate(DF.at) + '. Well done.' : 'Tick this when your debts are paid off, or if you don’t have any.' })])]),
      dfOn && leftAll > 0.005 ? h('p', { class: 'df-note', text: 'Your list below still shows ' + money(Math.round(leftAll)) + ' left. Update the balances, or remove debts you’ve cleared.' }) : null ]));
    if (!state.debts.length) { big = 'No debts yet'; sub = 'Add one below to see your debt-free date.'; }
    else if (leftAll <= 0.005) { big = 'Debt-free'; sub = 'Nothing left to pay. Well done.'; }
    else if (cur <= 0) { big = 'Not set yet'; sub = 'Add monthly payments to see your date.'; }
    else if (!sim.ok) { big = 'Not on track'; sub = 'Your payments don’t cover the interest yet.'; }
    else { big = freeDateLabel(sim.months); sub = monthsText(sim.months) + ' · ' + money(leftAll) + ' left at ' + money(cur) + ' a month'; }
    var firstDebt = state.debts.find(function (d) { return debtLeft(d) > 0.005 && amt(debtMonthly(d)) > 0; });
    var planned = state.debts.reduce(function (s, d) { return s + amt(debtMonthly(d)) * entRate(debtItemId(d)); }, 0);
    var dbCard = body.querySelector('.debt-group:not(.save-group):not(.inv-group)'); if (dbCard) dbCard.classList.add('xl-tbl', 'xl-debt'); // v3.7: table look
    var mw = minsMissing(); if (mw && dbCard) { mw.style.marginTop = '12px'; dbCard.after(mw); }
    var free = body.querySelector('.dfree'); if (free) free.closest('.dsec').remove();
    tipHead(body, 'd-bal', 'Balance', 'What you owed on the date under it. Each month since, what you stamp comes off it, and a month you didn’t stamp counts your monthly payment.');
    tipHead(body, 'd-apr', 'APR', 'The yearly interest rate, from your statement or app.');
    tipHead(body, 'd-min', 'Minimum', null);
    tipHead(body, 'd-pay', 'Monthly', 'What you pay each month. It goes into your planner under Costs › Debt payments, and counts as paid when you stamp the month.');
    state.debts.forEach(function (d) {
      var row = body.querySelector('[data-row-id="' + d.id + '"]'); if (!row) return;
      var bal = amt(d.balance), paid = Math.min(debtPaid(d).paid, bal), pct = bal ? paid / bal * 100 : 0, left = debtLeft(d), inPlan = !!findItem(debtItemId(d));
      var pay = Math.max(amt(debtMonthly(d)), amt(d.min)), s = pay ? singleDebtSim(d, pay) : null, sub;
      var pp = pct >= 0.5 ? Math.round(pct) + '% paid off · ' : '';
      var dp = debtPaid(d), nowTxt = d.asOf && dp.paid > 0.005 && left > 0.005 ? 'about ' + money(Math.round(left)) + ' left now · ' : '';
      pp = nowTxt + pp;
      if (bal && left <= 0.005) sub = 'Paid off';
      else if (inPlan && s && s.ok && amt(debtMonthly(d))) sub = pp + 'clear by ' + freeDateLabel(s.months);
      else if (amt(d.min)) sub = pp + 'minimum only';
      else sub = pp ? pp.slice(0, -3) : 'Add a minimum or monthly payment';
      goalRow(row, { id: d.id, itemId: debtItemId(d), name: d.name, pct: pct, sub: sub, inPlan: inPlan, icon: 'debt', monthly: debtMonthly(d), payKey: 'dpay-' + d.id });
    });
    goalSections(body, function (title) {
      if (!/What if/.test(title) || cur <= 0 || !sim.ok) return null;
      var s2 = payoffSim(cur + 50), diff = sim.months - s2.months;
      return diff > 0 ? { text: 'Paying £50 more a month gets you debt-free ' + monthsText(diff) + ' sooner.' } : null;
    });
    // v4.1: no lessons any more
    return body;
  }
  function potMonths(sv) { var m = amt(savingMonthly(sv)), left = potLeft(sv); return m > 0 && left > 0.005 ? Math.ceil(left / m) : null; }
  function savingsBody2() {
    var body = savingsBody(), first = tidyGoalBody(body);
    var goalAll = 0, savedAll = 0, monthly = 0;
    state.savings.forEach(function (sv) { var k = entRate(savingItemId(sv)); goalAll += amt(sv.goal) * k; savedAll += savedNow(sv) * k; monthly += amt(savingMonthly(sv)) * k; });
    var next = null;
    state.savings.forEach(function (sv) { var m = potMonths(sv); if (m && (!next || m < next.m)) next = { sv: sv, m: m }; });
    // v3.7: no Saved so far box; the list is a plain, spreadsheet-style table
    var svCard = body.querySelector('.save-group'); if (svCard) svCard.classList.add('xl-tbl');
    tipHead(body, 'd-bal', 'Goal', null);
    tipHead(body, 'd-apr', 'Saved', 'Type what’s saved so far. Each month you stamp adds its amount on top.');
    tipHead(body, 'd-min', 'Interest', null);
    tipHead(body, 'd-pay', 'Monthly', 'What you put in each month. It goes into your planner under Investments & Savings › Savings.');
    var open = state.potOpen || {};
    state.savings.forEach(function (sv) {
      var row = body.querySelector('[data-row-id="' + sv.id + '"]'); if (!row) return;
      var g = amt(sv.goal), saved = savedNow(sv), pct = g ? saved / g * 100 : 0, m = potMonths(sv), inPlan = !!findItem(savingItemId(sv)), sub;
      if (g && saved >= g) sub = 'Goal reached';
      else if (!g) sub = 'Add a goal to track it';
      else if (m) sub = Math.round(pct) + '% · ready by ' + freeDateLabel(m);
      else sub = Math.round(pct) + '% · add a monthly amount to see when';
      var isOpen = !!open[sv.id] && g > 0;
      goalRow(row, { id: sv.id, itemId: savingItemId(sv), name: sv.name, pct: pct, sub: sub, inPlan: inPlan, icon: 'savings', color: '#1E6B47', monthly: savingMonthly(sv), payKey: 'spay-' + sv.id, open: isOpen,
        onSub: g ? function () { var o = Object.assign({}, state.potOpen || {}); o[sv.id] = !o[sv.id]; set({ potOpen: o }); } : null });
      if (isOpen) row.after(potDetail(sv));
    });
    goalSections(body, function (title) {
      if (/used/.test(title) && !(state.savingUsed || []).length) return { text: 'Nothing taken out' };
      if (/Emergency/.test(title)) { var ef = state.savings.find(function (x) { return x.id === state.efundStarter; }); if (ef && savedNow(ef) >= efGoal()) return { text: 'Emergency fund full', cls: 'st-ok' }; }
      return null;
    });
    // v4.1: no lessons any more
    return body;
  }
  function potDetail(sv) {
    var left = potLeft(sv), m = potMonths(sv), mon = amt(savingMonthly(sv));
    var now = new Date(), toDec = 11 - now.getMonth() + 1, need = toDec > 0 ? Math.ceil(left / toDec) : 0;
    var tip = null;
    if (left > 0.005 && toDec > 0 && need > mon) tip = h('div', { class: 'pd-tip' }, [
      h('span', { text: 'Want it by December ' + now.getFullYear() + '? That’s ' + money(need) + ' a month for ' + toDec + (toDec === 1 ? ' month.' : ' months.') }),
      btn('pd-use', 'Use ' + money(need) + ' a month', function () { sv.monthly = String(need); commit(); }, ['Use this amount ›']) ]);
    return h('div', { class: 'pot-detail' }, [
      h('div', {}, [h('small', { text: 'To go' }), h('b', { text: money(left) })]),
      h('div', {}, [h('small', { text: 'Ready by' }), h('b', { text: m ? freeDateLabel(m) : left <= 0.005 ? 'Done' : 'Add a monthly amount' })]),
      h('div', {}, [h('small', { text: 'Each month' }), h('b', { text: mon ? money(mon) : 'Not set' })]),
      tip ]);
  }
  function investmentsBody2() {
    var body = investmentsBody(), first = tidyGoalBody(body);
    var inAll = 0, valAll = 0, monthly = 0, top = null;
    state.investments.forEach(function (iv) { var k = entRate(invItemId(iv)); inAll += invested(iv) * k; valAll += invValue(iv) * k; var mo = amt(invMonthly(iv)) * k; monthly += mo; if (mo && (!top || mo > amt(invMonthly(top)))) top = iv; });
    var g = valAll - inAll, gp = inAll ? g / inAll * 100 : 0;
    // v3.7: no Worth now box; the list is a plain, spreadsheet-style table
    var ivCard = body.querySelector('.inv-group'); if (ivCard) ivCard.classList.add('xl-tbl');
    tipHead(body, 'd-bal', 'Put in', 'Type what you’ve put in so far. Each month you stamp adds its amount on top.');
    tipHead(body, 'd-apr', 'Worth now', 'Type what your provider’s app shows whenever you check. Money you put in afterwards is added on top.');
    tipHead(body, 'd-min', 'Growth', null);
    tipHead(body, 'd-pay', 'Monthly', 'What you put in each month. It goes into your planner under Investments & Savings › Investments.');
    state.investments.forEach(function (iv) {
      var row = body.querySelector('[data-row-id="' + iv.id + '"]'); if (!row) return;
      var val = invValue(iv), pct = valAll ? val / valAll * 100 : 0, inPlan = !!findItem(invItemId(iv)), sub, nudge = false;
      if (!iv.checkedAt) sub = Math.round(pct) + '% of your investments';
      else {
        var days = Math.floor((Date.now() - iv.checkedAt) / 864e5);
        sub = days < 1 ? 'Updated today' : days < 45 ? 'Updated ' + days + (days === 1 ? ' day ago' : ' days ago') : 'Last updated ' + Math.round(days / 30) + ' months ago · update Worth now';
        nudge = days >= 45;
      }
      var isa = row.querySelector('.isa-mark');
      if (isa) { isa.textContent = iv.isa ? 'ISA' : '+ ISA'; isa.title = iv.isa ? 'Counts towards your yearly ISA allowance. Click to unmark.' : 'Mark as an ISA'; }
      goalRow(row, { id: iv.id, itemId: invItemId(iv), name: iv.name, pct: pct, sub: sub, nudge: nudge, inPlan: inPlan, icon: 'investments', color: '#1E6B47', monthly: invMonthly(iv), payKey: 'ipay-' + iv.id });
    });
    goalSections(body, function (title) {
      if (/Sold/.test(title) && !(state.investUsed || []).length) return { text: 'Nothing taken out' };
      return null;
    });
    // v4.1: no lessons any more
    return body;
  }

  /* ---------- Fresh look ----------
     Founder places live in the bar as a small pill; group headers get an icon;
     group colours are softened to sit with the plum (older saved plans are mapped too). */
  function founderPill() {
    var F = state.founder;
    if (F.number) return btn('pn-fpill gift', F.placesLeft > 0 ? 'Gift a friend a founder place' : 'Share PayStamp', function () { openOverlay('invites'); },
      [h('span', { class: 'ic', html: IC.gift }), h('span', { class: 'fp-long', text: F.placesLeft > 0 ? 'Gift a founder place' : 'Share PayStamp' }), h('span', { class: 'fp-short', text: F.placesLeft > 0 ? 'Gift a place' : 'Share' })]);
    if (!(F.placesLeft > 0)) return null;
    return btn('pn-fpill', F.placesLeft + ' founder places left. What’s a founder?', function () { openOverlay('founderInfo'); },
      [h('b', { text: String(F.placesLeft) }), h('span', { class: 'fp-long', text: ' founder places left' }), h('span', { class: 'fp-short', text: ' places left' })]);
  }
  /* Tidy-up for plans saved before v3.3: the old Extras group filled itself from the
     Debt, Savings and Investments extras. Those automatic lines go; anything typed in by
     hand stays. The group goes only if nothing is left in it. */
  function dropOldExtras() {
    state.debtExtras = []; state.savingExtras = []; state.investExtras = [];
    state.groups.forEach(function (g) { g.categories.forEach(function (c) {
      c.items = c.items.filter(function (it) { return !(it.extraId || it.saveExtraId || it.investExtraId || /^(dbx|svx|ivx)_/.test(it.id)); });
    }); g.categories = g.categories.filter(function (c) { return !(/^cat_(debt|save|inv)_extras$/.test(c.id) && !c.items.length); }); });
    state.groups = state.groups.filter(function (g) { return !(g.key === 'extras' && !g.categories.some(function (c) { return c.items.length; })); });
  }
  var FRESH_COL = { '#00602a': '#1E6B47', '#8a2c24': '#9A3A30', '#00568d': '#245F8C' };
  function freshCol(c) { return FRESH_COL[(c || '').toLowerCase()] || c; }
  var GROUP_IC = {
    income: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M16 12.5h2"/><path d="M3 9.5h15a2 2 0 0 0 2-2V6"/></svg>',
    investSavings: '<svg viewBox="0 0 24 24"><path d="M8 3.5h8v3H8z"/><path d="M6.5 6.5h11v10.5a3 3 0 0 1-3 3h-5a3 3 0 0 1-3-3z"/><path d="M10 13h4"/></svg>',
    costs: '<svg viewBox="0 0 24 24"><path d="M4 11l8-6 8 6"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/></svg>',
    guiltFree: '<svg viewBox="0 0 24 24"><path d="M5 8h14l-1 11.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19.5z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/></svg>' };
  function groupIcon(card, g) {
    var h2 = card.querySelector('.group-head h2'); if (!h2 || !GROUP_IC[g.key] || h2.querySelector('.g-ic')) return;
    h2.prepend(h('span', { class: 'g-ic', html: GROUP_IC[g.key] }));
  }

  /* ---------- What's new: everything in PayStamp 3 ---------- */
  function whatsNewBody2() {
    return h('div', { class: 'wn3' }, WN_LATEST.map(function (r, i) {
        return h('section', { class: 'wn3-card', style: i ? '' : 'border-color:rgba(126,42,85,.4);box-shadow:0 0 0 3px var(--plum-soft)' }, [
          h('div', { class: 'wn3-t' }, [h('span', { class: 'wn3-ver', text: r.title })]),
          h('ul', {}, r.items.map(function (t) { return h('li', { text: t }); })) ]);
      }).concat([
      btn('wn3-more', state.wnOlder ? 'Hide earlier updates' : 'Show earlier updates', function () { set({ wnOlder: !state.wnOlder }); }, [state.wnOlder ? 'Hide earlier updates ▴' : 'Earlier updates ▾']),
      state.wnOlder ? h('div', { class: 'wn3-head' }, [h('span', { class: 'wn3-ver', text: 'PayStamp 3' }), h('p', { text: 'Everything added since the original planner, in one place.' })]) : null,
      !state.wnOlder ? null : h('div', { class: 'wn3-grid' }, WN_SECTIONS.map(function (s) {
        return h('section', { class: 'wn3-card' }, [
          h('div', { class: 'wn3-t' }, [h('span', { class: 'wn3-ic', html: IC[s.icon] }), h('h4', { text: s.title })]),
          h('ul', {}, s.items.map(function (t) { return h('li', { text: t }); })) ]);
      })) ]));
  }
  /* ---------- v3.7: the planner as a neat sheet ----------
     Tick which columns to show (This month is always shown). Cells look like text and become editable when clicked.
     state.showCols = { loc, date, auto, tgt }; new people start with Payday on. */
  var SHEET_COLS = [['loc', 'Bank'], ['date', 'Payday'], ['auto', 'Auto'], ['tgt', 'Budgeted']];
  // v3.7: banks, paydays and automated are set up in Compass › Automation, so the planner only shows the amounts.
  function showCols() { return { tgt: true }; }
  function sheetCls() { var sc = showCols(); return SHEET_COLS.filter(function (c) { return !sc[c[0]]; }).map(function (c) { return 'no-' + c[0]; }).join(' '); }
  function sheetCols() {
    var sc = showCols(), ph = window.matchMedia && matchMedia('(max-width:640px)').matches;
    var w = ph ? { loc: 84, date: 54, auto: 40, tgt: 66, bud: 74 } : sideOn().any ? { loc: 130, date: 84, auto: 60, tgt: 82, bud: 86 } : { loc: 130, date: 84, auto: 60, tgt: 128, bud: 128 };
    var t = '[l-h] ' + (ph ? 12 : 16) + 'px [l-name] minmax(' + (ph ? 96 : 0) + 'px,1fr)';
    if (sc.loc) t += ' [l-loc] ' + w.loc + 'px';
    if (sc.date) t += ' [l-date] ' + w.date + 'px';
    if (sc.auto) t += ' [l-auto] ' + w.auto + 'px';
    t += ' [l-nums' + (sc.tgt ? ' l-tgt] ' + w.tgt + 'px [l-bud] ' : ' l-bud] ') + w.bud + 'px [l-rm] 0px [l-end]';
    return t;
  }
  try { matchMedia('(max-width:640px)').addEventListener('change', function () { scheduleRender(); }); } catch (e) {}
  /* v3.7: Compass › Automation: every planner line with its bank, payday and automated tick, set up once. */

  // v3.7: per bank account totals live in Compass › Automation (moved from the planner)

  /* ---------- v4.1 (preview): side columns beside the planner ----------
     Left: each line's share of pay. Right: Automation (bank, paid on, automated) and the Costs review
     (need it, better deal, cut it, remind me), which used to live in Compass. Each column is its own box,
     lined up row by row with the category box. Toggled from the bar above the planner (state.sideCols). */

  // v4.1: email reminders, ticked from the bar above the planner. Ticking either switches the payday email on.
  function mailBar() {
    var E = state.emailPrefs || (state.emailPrefs = {}), on = emailOn(), rem = on && !!E.reminders;
    var chip = function (isOn, label, title, flip) {
      return btn('sd-chip' + (isOn ? ' on' : ''), (isOn ? 'Stop: ' : 'Email me: ') + title, function () { flip(); track('email_tick', label + (isOn ? ' off' : ' on')); commit(); },
        [h('span', { class: 'sd-box-ic', html: isOn ? TICK_SVG : '' }), label], { 'aria-pressed': String(isOn), title: title });
    };
    return h('div', { class: 'sd-bar sd-mail' }, [h('span', { class: 'sd-bar-t', text: 'Email reminders' }), h('div', { class: 'sd-chips' }, [
      chip(on, 'Payday', 'An email on payday to enter your pay, check your plan and stamp the month', function () { E.on = !on; if (on) E.reminders = false; E.mid = false; delete E.when; delete E.day; }),
      chip(rem, 'Review dates', 'Your Remind me dates, in your payday email the month before', function () { E.reminders = !rem; if (!rem) E.on = true; }) ])]);
  }
  function sideOn() {
    var sc = state.sideCols || { pct: false, auto: false, cost: false };
    var wide = !(window.matchMedia && matchMedia('(max-width:820px)').matches);
    var roomy = true;
    var o = { pct: wide && !!sc.pct, auto: wide && !!sc.auto, cost: roomy && !!sc.cost, notes: wide && !!sc.notes }; o.roomy = roomy; o.autoLeft = false;
    if (o.notes) { o.pct = o.auto = o.cost = false; }   // v4.3: Notes needs the room, so it shows on its own
    o.any = o.pct || o.auto || o.cost || o.notes; o.wide = wide; return o;
  }
  try { matchMedia('(max-width:820px)').addEventListener('change', function () { scheduleRender(); }); } catch (e) {}
  try { matchMedia('(max-width:1080px)').addEventListener('change', function () { scheduleRender(); }); } catch (e) {}
  function sideToolbar() {
    var sc = state.sideCols || { pct: false, auto: false, cost: false }, so = sideOn();
    var chip = function (k, label) {
      var on = !!sc[k];
      return btn('sd-chip' + (on ? ' on' : ''), (on ? 'Hide ' : 'Show ') + label, function () { var n = Object.assign({ pct: false, auto: false, cost: false, notes: false }, state.sideCols); n[k] = !n[k];
        if (n[k]) { if (k === 'notes') { n.pct = n.auto = n.cost = false; } else n.notes = false; }   // v4.3: Notes and the other tools take turns
        state.sideCols = n; track('cols', k + (n[k] ? '_on' : '_off')); commit(); },
        [h('span', { class: 'sd-box-ic', html: on ? TICK_SVG : '' }), label], { 'aria-pressed': String(on) });
    };
    // v4.3: Tools, laid out as one tidy card: the first column, the side columns, and email reminders
    var lm = lastMode(), lr = lastRecord(), pm = prevMonth();
    var segBtn = function (key, label, on) { return h('button', { type: 'button', class: 'tl-seg-b' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: function () {
      if (on) return; state.firstCol = key === 'last' ? 'last' : ''; track('first_col', key); commit(); } }, [label]); };
    var seg = h('div', { class: 'tl-seg', role: 'group', 'aria-label': 'What the first column shows' }, [segBtn('budgeted', 'Budgeted', !lm), segBtn('last', 'Last month', lm)]);
    seg.title = lm ? (lr ? 'Showing ' + pm.month + ' ' + pm.year + ', as you stamped it. Big changes are highlighted.' : 'Showing ' + pm.month + ' ' + pm.year + ' (not stamped yet). Big changes are highlighted.') : 'The first column shows Budgeted: your plan for every month.';
    var mailChips = mailBar().querySelector('.sd-chips');
    // v4.3: two compact lines: Tools, then Email reminders
    return h('div', { class: 'tl2' }, [
      h('div', { class: 'tl2-r' }, [h('span', { class: 'tl2-l', text: 'Tools' }), h('div', { class: 'tl2-c' }, [seg].concat(so.wide ? [chip('pct', '% of pay'), chip('auto', 'Automation'), chip('cost', 'Review'), chip('notes', 'Notes')] : []))]),
      h('div', { class: 'tl2-r' }, [h('span', { class: 'tl2-l', text: 'Email reminders' }), h('div', { class: 'tl2-c' }, [mailChips])]) ]);
  }
  function sideCell(forKey, cls, kids) { return h('div', { class: 'sd-cell ' + (cls || ''), 'data-for': forKey }, kids || []); }
  function sideBox(kind, g, title, cols, rowFn, catFn, footFn) {
    var box = h('aside', { class: 'sd-box sd-' + kind, style: '--g:' + g.color, 'aria-label': title + ' for ' + g.title });
    box.append(sideCell('ghead', 'sd-head', kind === 'pct' ? [] : [h('b', { text: title })]));
    box.append(sideCell('colhead', 'sd-colhead', cols.map(function (c) { return h('span', { text: c }); })));
    g.categories.forEach(function (c, ci) {
      box.append(sideCell('cat:' + c.id, 'sd-cat' + (catFn ? '' : ' sd-colhead'), catFn ? catFn(c) : ci ? [] : cols.map(function (x) { return h('span', { text: x }); })));
      c.items.forEach(function (it) { box.append(sideCell(it.id, 'sd-row', rowFn(it, c))); });
      if (c.items.length > 1) box.append(sideCell('catfoot:' + c.id, 'sd-catfoot', catFn ? catFn(c, true) : []));
    });
    box.append(sideCell('foot', 'sd-foot', footFn ? footFn() : []));
    return box;
  }
  var SD_IC = {
    keep: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    deal: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.6 7.4a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2.9-1.2 1.8v.6M10 14.8v.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cut: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5.5" cy="14.5" r="2.3" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="14.5" cy="14.5" r="2.3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7.2 12.8 15.5 3.5M12.8 12.8 4.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    bell: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2a3.6 3.6 0 0 0-3.6 3.6v2.4L3.2 10.6h9.6L11.6 8.2V5.8A3.6 3.6 0 0 0 8 2.2zM6.6 12.4a1.5 1.5 0 0 0 2.8 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  /* v4.3: this month's split as a pie chart, from the eye at the top of the % column */
  // v4.3: a small pie at the foot of the % column. Click it for the full chart.
  function pieParts() {
    var t = totals(), pay = t.income, parts = [];
    state.groups.forEach(function (g) { if (g.key === 'income') return; var v = groupSum(g, 'budgeted'); if (v > 0.004) parts.push({ name: g.title, v: v, col: g.color, cats: g.categories.map(function (c) { return { name: c.name, v: catSum(c, 'budgeted') }; }).filter(function (c) { return c.v > 0.004; }) }); });
    var used = parts.reduce(function (a, p2) { return a + p2.v; }, 0), left = pay - used;
    if (left > 0.5) parts.push({ name: 'Not given a job yet', v: left, col: '#CFC8D6', cats: [] });
    return { parts: parts, pay: pay, whole: Math.max(pay, used) || 1 };
  }
  function pieSvg(P, size, hole, label) {
    var R = size / 2 - hole / 2, C = 2 * Math.PI * R, off = 0, c = size / 2;
    return '<svg viewBox="0 0 ' + size + ' ' + size + '"' + (label ? ' class="pie-svg" role="img" aria-label="' + P.parts.map(function (p2) { return p2.name + ' ' + pct(p2.v, P.whole); }).join(', ') + '"' : ' aria-hidden="true"') + '>'
      + P.parts.map(function (p2) { var len = p2.v / P.whole * C, seg = '<circle cx="' + c + '" cy="' + c + '" r="' + R + '" fill="none" stroke="' + p2.col + '" stroke-width="' + hole + '" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 ' + c + ' ' + c + ')"/>'; off += len; return seg; }).join('')
      + (label ? '<text x="' + c + '" y="' + (c - 6) + '" text-anchor="middle" class="pie-c1">' + money(Math.round(P.pay)) + '</text><text x="' + c + '" y="' + (c + 16) + '" text-anchor="middle" class="pie-c2">pay this month</text>' : '') + '</svg>';
  }
  function miniPie() { return btn('zb-pie', 'See this month’s split as a pie chart', openPie, [h('span', { html: pieSvg(pieParts(), 30, 12, false) })], { title: 'See this month’s split as a pie chart' }); }
  function openPie() {
    track('pie', null, true);
    var P = pieParts(), parts = P.parts, whole = P.whole, svg = pieSvg(P, 240, 44, true);
    var back = h('div', { class: 'pie-back', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'This month’s split' });
    var close = function () { back.remove(); document.removeEventListener('keydown', esc); };
    var esc = function (e) { if (e.key === 'Escape') close(); };
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', esc);
    var legend = h('div', { class: 'pie-leg' }, parts.map(function (p2) {
      return h('div', { class: 'pie-g' }, [h('div', { class: 'pie-gh' }, [h('i', { style: 'background:' + p2.col }), h('b', { text: p2.name }), h('span', { text: pct(p2.v, whole) + ' · ' + money(Math.round(p2.v)) })]),
        p2.cats.length > 1 ? h('div', { class: 'pie-cats' }, p2.cats.map(function (c) { return h('div', {}, [h('span', { text: c.name }), h('span', { text: pct(c.v, whole) })]); })) : null]);
    }));
    var pop = h('div', { class: 'pie-pop' }, [btn('pie-x', 'Close', close, ['✕']), h('h3', { text: 'This month’s split' }), h('p', { class: 'pie-sub', text: 'Where your pay goes this month, as a share of your take-home pay.' }), h('div', { class: 'pie-body' }, [h('div', { class: 'pie-chart', html: svg }), legend])]);
    back.append(pop); document.body.append(back);
    setTimeout(function () { var x = pop.querySelector('.pie-x'); if (x) x.focus(); }, 0);
  }
  function sideLane(card, cls) {
    var so = sideOn(); if (!so.any) return card;
    var lane = h('div', { class: 'sd-lane ' + (cls || '') }, [so.auto && so.autoLeft ? h('div') : null, so.pct ? h('div') : null, card, so.auto && !so.autoLeft ? h('div') : null, so.cost ? h('div') : null, so.notes ? h('div') : null].filter(Boolean));
    lane.style.gridTemplateColumns = [so.auto && so.autoLeft ? 'var(--sd-w-auto)' : null, so.pct ? 'var(--sd-w-pct)' : null, 'minmax(0,var(--sd-w-card))', so.auto && !so.autoLeft ? 'var(--sd-w-auto)' : null, so.cost ? 'var(--sd-w-cost)' : null, so.notes ? 'var(--sd-w-notes)' : null].filter(Boolean).join(' ');
    return lane;
  }
  // v4.1: the zero-based balance, as a black box lined up under Budgeted and This month.
  function zeroBox(t) {
    var inG = state.groups.filter(function (g) { return g.key === 'income'; }), outG = state.groups.filter(function (g) { return g.key !== 'income'; });
    var bal = function (f) { return inG.reduce(function (a, g) { return a + groupSum(g, f); }, 0) - outG.reduce(function (a, g) { return a + groupSum(g, f); }, 0); };
    var bt = bal('first'), bm = bal('budgeted');
    var cell = function (cls, v) { var z = Math.abs(v) < 0.005; return h('span', { class: cls + ' zb-v' + (z ? ' ok' : v > 0 ? ' left' : ' over'), title: z ? 'Every pound has a job' : v > 0 ? 'Left to give a job' : 'Planned more than your pay' }, [z ? '£0 ✓' : signed(v)]); };
    var card = h('section', { class: 'group zb-box', 'data-g': 'zero', style: '--g:#211C2E;--gm:#211C2E;--gl:#F1EFF3;--gl2:#CFCBD6' }, [
      h('div', { class: 'row foot zb-row' }, [h('span', { class: 'c-label', text: 'Zero-based balance' }), cell('c-tgt', bt), cell('c-bud', bm)]) ]);
    var so = sideOn();
    if (!so.any) return card;
    var lane = h('div', { class: 'sd-lane zb-lane' }, [so.auto && so.autoLeft ? h('div') : null, so.pct ? h('div', { class: 'zb-pie-cell' }, [miniPie()]) : null, card, so.auto && !so.autoLeft ? h('div') : null, so.cost ? h('div') : null, so.notes ? h('div') : null].filter(Boolean));
    lane.style.gridTemplateColumns = [so.auto && so.autoLeft ? 'var(--sd-w-auto)' : null, so.pct ? 'var(--sd-w-pct)' : null, 'minmax(0,var(--sd-w-card))', so.auto && !so.autoLeft ? 'var(--sd-w-auto)' : null, so.cost ? 'var(--sd-w-cost)' : null, so.notes ? 'var(--sd-w-notes)' : null].filter(Boolean).join(' ');
    return lane;
  }
  // v4.3: with Automation showing, what goes out of each bank account each month (money going in isn't counted).
  function bankBox() {
    var so = sideOn(); if (!so.auto) return null;
    var by = {}, order = [];
    state.groups.forEach(function (g) { if (g.key === 'income') return; g.categories.forEach(function (c) { c.items.forEach(function (it) {
      var b = String(it.account || '').trim(); if (!b) return;
      if (!by[b]) { by[b] = { t: 0, m: 0 }; order.push(b); }
      by[b].t += firstVal(it) * itemRate(it); by[b].m += amt(it.budgeted) * itemRate(it); }); }); });
    var rows = order.filter(function (b) { return Math.abs(by[b].t) > 0.004 || Math.abs(by[b].m) > 0.004; });
    if (!rows.length) return null;
    var card = h('section', { class: 'group zb-box bank-box', 'data-g': 'banks', style: '--g:#211C2E;--gm:#211C2E;--gl:#F1EFF3;--gl2:#CFCBD6' },
      [h('div', { class: 'row foot zb-row bb-h' }, [h('span', { class: 'c-label', text: 'Out of each bank' }), h('span', { class: 'c-tgt bb-col', text: firstLabel(false) }), h('span', { class: 'c-bud bb-col', text: monthLabel() })])]
      .concat(rows.map(function (b) { return h('div', { class: 'row foot zb-row bb-r' }, [h('span', { class: 'c-label', text: b }), h('span', { class: 'c-tgt', text: money(cpR2(by[b].t)) }), h('span', { class: 'c-bud', text: money(cpR2(by[b].m)) })]); })));
    var lane = h('div', { class: 'sd-lane zb-lane' }, [so.auto && so.autoLeft ? h('div') : null, so.pct ? h('div') : null, card, so.auto && !so.autoLeft ? h('div') : null, so.cost ? h('div') : null, so.notes ? h('div') : null].filter(Boolean));
    lane.style.gridTemplateColumns = [so.auto && so.autoLeft ? 'var(--sd-w-auto)' : null, so.pct ? 'var(--sd-w-pct)' : null, 'minmax(0,var(--sd-w-card))', so.auto && !so.autoLeft ? 'var(--sd-w-auto)' : null, so.cost ? 'var(--sd-w-cost)' : null, so.notes ? 'var(--sd-w-notes)' : null].filter(Boolean).join(' ');
    return lane;
  }
  function laneFor(g, t) {
    var card = groupCard(g, t), so = sideOn();
    if (!so.any) return card;
    var inc = g.key === 'income', income = t.income;
    var lane = h('div', { class: 'sd-lane', 'data-lane': g.key });
    // % of pay
    var autoBox = null;
    if (so.pct) lane.append(sideBox('pct', g, '%', [inc ? 'Of pay' : 'Of pay'],
      function (it) { var v = amt(it.budgeted) * itemRate(it); return [h('b', { class: 'sd-pct' + (v ? '' : ' zero'), text: income ? pct(v, income) : '–' })]; },
      function (c, foot) { return foot ? [h('span', { class: 'sd-pct sd-sub', text: pct(catSum(c, 'budgeted'), income) })] : []; }, // v4.1: only beside lines and totals
      function () { return [h('b', { class: 'sd-pct tot', text: pct(groupSum(g, 'budgeted'), income) })]; }));
    lane.append(card);
    var AUTO_AT = lane.childNodes.length;
    // Automation: the bank, paid-on and automated controls are the planner line's own (built by itemRow).
    if (so.auto) autoBox = sideBox('auto', g, 'Automation', [inc ? 'Paid into' : 'Paid from', inc ? 'Payday' : 'Paid on', inc ? '' : 'Auto'],
      function (it) {
        var r = itemRow(it, inc, g.key), parts = ['.c-loc', '.c-date', '.c-auto'].map(function (q) { var n = r.querySelector(q); return n; });
        if (inc && parts[2]) parts[2].style.visibility = 'hidden';
        return [h('div', { class: 'sd-auto-row' + (it.automated ? ' on' : '') }, parts.filter(Boolean))];
      }, null,
      function () { var all = 0, on = 0; g.categories.forEach(function (c) { c.items.forEach(function (it) { all++; if (it.automated) on++; }); });
        return inc ? [] : [h('span', { class: 'sd-auto-tot', text: on + ' of ' + all + ' automated' })]; });
    if (autoBox) { if (so.autoLeft) lane.insertBefore(autoBox, lane.firstChild); else lane.append(autoBox); }
    // Costs review: only the Costs box has costs to go through; other boxes keep the column lined up.
    if (so.notes) lane.append(sideBox('notes', g, 'Notes', ['Note'],
      function (it) {
        var nm = it.label || 'this line';
        return [field('note-' + it.id, it.note || '', function (v) { var t = String(v || '').trim().slice(0, 300); if ((it.note || '') === t) return; if (t) it.note = t; else delete it.note; track('note', t ? 'set' : 'clear', true); commit(); },
          { cls: 'sd-note-in', ph: 'Add a note…', label: 'Note for ' + nm })];
      }, null,
      function () { var n = 0; g.categories.forEach(function (c) { c.items.forEach(function (it) { if (it.note) n++; }); }); return [h('span', { class: 'sd-auto-tot', text: n ? n + (n === 1 ? ' note' : ' notes') : '' })]; }));
    if (so.cost) {
      {
        var CRV = state.costReview || (state.costReview = {}), REM = state.costRemind || (state.costRemind = {});
        var ok = {}; g.categories.forEach(function (c) { c.items.forEach(function (it) { ok[it.id] = true; }); });
        var anyRv = true, incRv = g.key === 'income';   // v4.3: Income has a review too, e.g. a reminder to ask for a pay rise
        lane.append(sideBox('cost', g, 'Review', anyRv ? ['Review', 'Remind me'] : [''],
          function (it) {
            if (!ok[it.id] || !anyRv) return [h('span', { class: 'sd-na', text: '' })];
            var k = costKey(it), name = it.label || 'this cost';
            var RVS = incRv ? { keep: ['✓', 'Happy with it'], deal: ['?', 'Could be more'] } : { keep: ['✓', 'Need it'], deal: ['?', 'Better deal?'], cut: ['✕', 'Cut it'] }, cur = CRV[k] && RVS[CRV[k]] ? CRV[k] : '';
            var sel = h('select', { class: 'sd-rv-pick', 'aria-label': 'Review ' + name + (cur ? ': ' + RVS[cur][1] : ''),
              onchange: function (e) { var v = e.target.value; if (v) CRV[k] = v; else delete CRV[k]; track('review', v || 'clear'); commit(); } },
              (incRv ? [['', 'Not reviewed'], ['keep', '✓  Happy with it'], ['deal', '?  Could be more']] : [['', 'Not reviewed'], ['keep', '✓  Need it'], ['deal', '?  Better deal'], ['cut', '✕  Cut it']]).map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
            sel.value = cur;
            var chips = h('label', { class: 'sd-rv-sym ' + (cur || 'none'), title: cur ? RVS[cur][1] : incRv ? 'Review: happy with it, or could it be more?' : 'Review: need it, better deal or cut it' }, [h('span', { text: cur ? RVS[cur][0] : '·' }), sel]);
            var r = REM[k], editing = state.sdRemEdit === k;
            var shortD = r && r.d ? new Date(r.d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '';
            var remEl;
            if (editing) {
              remEl = h('input', { type: 'date', class: 'sd-date-in', 'data-k': 'rem-' + k, 'aria-label': 'Remind me about ' + name + ' on this date',
                onchange: function (e) { var v = e.target.value;
                  // v4.2: a shared cost's date is kept on the shared line, so you both get the reminder
                  if (/^cp:/.test(k)) { var SL = C().lines.find(function (x) { return 'cp:' + x.id === k; }); if (SL) { if (v && Number(v.split('-')[0]) < new Date().getFullYear()) return; SL.remind = v || ''; if (v) track('remind_set', 'shared', true); commit(); return; } }
                  if (!v) { delete REM[k]; save(); return; } var p2 = v.split('-'); if (Number(p2[0]) < new Date().getFullYear()) return; REM[k] = { m: Number(p2[0]) * 12 + Number(p2[1]) - 1, d: v, name: name }; track('remind_set', null, true); save(); },
                onkeydown: function (e) { if (e.key === 'Enter' || e.key === 'Escape') e.target.blur(); },
                onblur: function () { if (state.sdRemEdit === k) { state.sdRemEdit = null; commit(); } } });
              remEl.value = r ? (r.d || '') : '';
              setTimeout(function () { var n = document.querySelector('[data-k="rem-' + k + '"]'); if (n) { n.focus(); try { if (n.showPicker) n.showPicker(); } catch (err) {} } }, 0);
            } else {
              remEl = h('button', { type: 'button', class: 'sd-rem' + (r ? ' set' : ''), title: r ? 'Reminder on ' + r.d + '. Click to change or clear it.' : incRv ? 'Remind me about ' + name + ', like when to ask for a pay rise' : 'Remind me about ' + name + ', like when a contract ends',
                onclick: function () { state.sdRemEdit = k; scheduleRender(); } }, [h('span', { class: 'sd-bell', html: SD_IC.bell }), h('span', { class: 'sd-rem-d', text: shortD || 'Remind' })]);
            }
            return [h('div', { class: 'sd-cost-row ' + (CRV[k] || '') }, [chips, remEl])];
          }, null,
          function () { if (!anyRv) return []; var its = []; g.categories.forEach(function (c) { c.items.forEach(function (it) { if (ok[it.id]) its.push(it); }); });
            var keys = its.map(costKey), n = keys.filter(function (k) { return CRV[k]; }).length;
            var cut = its.reduce(function (a, it) { return a + (CRV[costKey(it)] === 'cut' ? amt(it.budgeted) : 0); }, 0);
            return [h('span', { class: 'sd-auto-tot', text: n + ' of ' + keys.length + ' checked' + (cut > 0 ? ' · −' + money(Math.round(cut)) + '/mo' : '') })]; }));
      }
    }
    lane.style.gridTemplateColumns = [so.auto && so.autoLeft ? 'var(--sd-w-auto)' : null, so.pct ? 'var(--sd-w-pct)' : null, 'minmax(0,var(--sd-w-card))', so.auto && !so.autoLeft ? 'var(--sd-w-auto)' : null, so.cost ? 'var(--sd-w-cost)' : null, so.notes ? 'var(--sd-w-notes)' : null].filter(Boolean).join(' ');
    return lane;
  }
  // Line every side cell up with its row in the category box.
  function sdTarget(card, key) {
    if (key === 'ghead') return card.querySelector('.group-head');
    if (key === 'colhead') return card.querySelector('.row.colhead');
    if (key === 'foot') return card.querySelector('.row.foot');
    if (key.indexOf('catfoot:') === 0) { var c1 = card.querySelector('.cat[data-row-id="' + key.slice(8) + '"]'); return c1 && c1.querySelector(':scope > .cat-foot'); }
    if (key.indexOf('cat:') === 0) { var c2 = card.querySelector('.cat[data-row-id="' + key.slice(4) + '"]'); return c2 && c2.querySelector(':scope > .cat-head'); }
    return card.querySelector('.item-row[data-row-id="' + key + '"]');
  }
  function sdAlign() {
    document.querySelectorAll('.sd-lane').forEach(function (lane) {
      var card = lane.querySelector(':scope > .group'); if (!card) return;
      var top0 = card.getBoundingClientRect().top, H = card.offsetHeight;
      lane.querySelectorAll(':scope > .sd-box').forEach(function (box) {
        box.style.height = H + 'px';
        var last = null;
        box.querySelectorAll(':scope > .sd-cell').forEach(function (cell) {
          var tg = sdTarget(card, cell.getAttribute('data-for')), r = tg && tg.offsetParent ? tg.getBoundingClientRect() : null;
          if (!r || r.height < 1) { cell.style.display = 'none'; return; }
          cell.style.display = ''; cell.style.top = (r.top - top0) + 'px'; cell.style.height = r.height + 'px';
          if (cell.classList.contains('sd-foot')) { cell.style.height = (H - (r.top - top0)) + 'px'; }
        });
        var hd = box.querySelector('.sd-head'); if (hd && hd.style.display !== 'none') hd.style.top = '0px';
      });
    });
  }
  (function () {
    var q = false; function sched() { if (q) return; q = true; requestAnimationFrame(function () { q = false; sdAlign(); }); }
    var root = document.getElementById('app');
    if (root && window.MutationObserver) new MutationObserver(sched).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
    window.addEventListener('resize', sched);
    try { document.fonts.ready.then(sched); } catch (e) {}
    window.addEventListener('load', sched);
  })();

  function groupCard(g, t) {
    var nLines = g.categories.reduce(function (a, c) { return a + c.items.length; }, 0);
    var card = h('section', { 'data-g': g.key, class: 'group' + (g.key === 'income' ? ' inc-loc' : '') + (g.categories.length === 1 ? ' one-cat' : '') + (nLines <= 1 ? ' one-line' : ''), style: '--g:' + g.color + ';--gm:' + g.color + ';--gl:' + lighten(g.color, .86) + ';--gl2:' + lighten(g.color, .6) + ';--gb:' + lighten(g.color, .93) });
    var budget = groupSum(g, 'budgeted');
    card.append(h('div', { class: 'group-head' }, [h('h2', { text: g.title }),
      g.key === 'income' ? null : h('span', { class: 'share', title: 'Share of take-home pay', text: pct(budget, t.income) + ' of pay' }),
      btn('g-add', 'Add a category to ' + g.title, function () {
        var id = uid('cat'); g.categories.push({ id: id, name: '', items: [] }); commit();
        setTimeout(function () { var n = document.querySelector('[data-k="cat-' + id + '"]'); if (n) n.focus(); }, 0);
      }, ['+ Category'])]));
    // v3.7: the column headings once per group, not under every category
    card.append(h('div', { class: 'row colhead' }, [
      h('span', { class: 'c-name', text: 'Item' }), h('span', { class: 'c-loc', text: g.key === 'income' ? 'Paid into' : 'Paid from' }), h('span', { class: 'c-date', text: 'Paid on' }), h('span', { class: 'c-auto', text: 'Automated' }),
      colHead('c-tgt', g.key === 'income'), colHead('c-bud', g.key === 'income') ]));
    var catList = h('div', { class: 'cat-list', 'data-drop-kind': g.key === 'income' ? 'cat-inc' : 'cat-out', 'data-list-id': g.key });
    g.categories.forEach(function (c) { catList.append(categoryBlock(g, c)); });
    card.append(catList);
    card.append(h('div', { class: 'row foot' }, [
      h('span', { class: 'c-label', text: 'Total' }),
      h('span', { class: 'c-tgt', text: '£' + fmt(groupSum(g, 'first')) }),
      h('span', { class: 'c-bud', text: '£' + fmt(budget) }) ]));
    foldGroup(card, g);
    return card;
  }

  function categoryBlock(g, c) {
    var blk = h('div', { class: 'cat', 'data-drop-block': 'item', 'data-row-id': c.id });
    var addItem = function () {
      var id = uid('it');
      c.items.push({ id: id, label: '', target: '', budgeted: '', account: '', runs: '', due: '', automated: false });
      commit();
      var n = document.querySelector('[data-k="lbl-' + id + '"]'); if (n) n.focus();
    };
    var cgrip = h('button', { type: 'button', class: 'handle cat-grip', 'data-cgrip': c.id, 'aria-label': 'Move the ' + (c.name || 'category') + ' category (drag, or use arrow keys)', title: 'Drag to move this category', html: GRIP });
    cgrip.addEventListener('pointerdown', function (e) { startDrag(e, g.key === 'income' ? 'cat-inc' : 'cat-out'); });
    cgrip.addEventListener('keydown', function (e) { catKeyMove(e, g, c); });
    blk.append(h('div', { class: 'cat-head' + (c.items.length <= 1 ? ' one-item' : '') }, [h('span', { class: 'cat-l' }, [cgrip,
      (function () { var f = field('cat-' + c.id, c.name, function (v) { c.name = v; commit(); }, { cls: 'cat-name', ph: 'Category name', label: 'Category name' }); f.size = Math.max(10, (c.name || '').length + 1); f.addEventListener('input', function () { f.size = Math.max(10, f.value.length + 1); }); return f; })(),
      g.key !== 'income' ? h('span', { class: 'cat-share', title: 'Share of take-home pay', text: pct(catSum(c, 'budgeted'), totals().income) + ' of pay' }) : null,
      btn('cat-add', 'Add an item to ' + (c.name || 'this category'), addItem, ['+ Add line'], { title: 'Add an item' }) ]),
      // v3.7: like a spreadsheet: the category heading carries the column names; its total sits under its lines
      h('span', { class: 'cat-tot' }, [h('span', { class: 'c-tgt', title: COL_TIPS[g.key === 'income' ? 'tgtPay' : 'tgt'], text: firstLabel(g.key === 'income') }), h('span', { class: 'c-bud', title: COL_TIPS[g.key === 'income' ? 'budPay' : 'bud'], text: monthLabel() })]),
      btn('rm', 'Remove category ' + (c.name || ''), function () { removeCatWithUndo(g, c); }, ['✕']) ]));
    var list = h('div', { class: 'item-list', 'data-drop-kind': 'item', 'data-list-id': c.id }, [h('div', { class: 'empty-hint', text: 'No items yet. Press + above, or drag one here.' })]);
    c.items.forEach(function (it) { list.append(itemRow(it, g.key === 'income', g.key)); });
    blk.append(list);
    if (c.items.length > 1) blk.append(h('div', { class: 'row cat-foot' }, [
      h('span', { class: 'c-label', text: 'Total' }),
      h('span', { class: 'c-tgt', text: '£' + fmt(catSum(c, 'first')) }),
      h('span', { class: 'c-bud', text: '£' + fmt(catSum(c, 'budgeted')) }) ]));
    return blk;
  }

  // v3.7: each item can have its own colour. It shows in Records as the line's background.
  document.addEventListener('click', function (e) { if (state.swOpen && !e.target.closest('.it-pal, .it-sw')) set({ swOpen: null }); });
  function itemRow(it, isIncome, gkey) {
    var row = h('div', { class: 'row item-row', 'data-row-id': it.id });
    var grip = h('button', { type: 'button', class: 'handle c-h', 'data-grip': it.id, 'aria-label': 'Move ' + (it.label || 'item') + ' (drag, or use arrow keys)', html: GRIP });
    grip.addEventListener('pointerdown', function (e) { startDrag(e, 'item'); });
    grip.addEventListener('keydown', function (e) { itemKeyMove(e, it.id); });
    var names = state.locations.map(function (l) { return l.name; }).filter(Boolean);
    if (it.account && names.indexOf(it.account) < 0) names.push(it.account);
    var loc = h('select', { class: 'loc-select c-loc' + (it.account || (isIncome && mainPayName()) ? '' : ' is-empty'), 'data-k': 'loc-' + it.id, id: 'loc-' + it.id, 'aria-label': (isIncome ? 'Account ' + (it.label || 'this pay') + ' is paid into' : 'Bank account for ' + (it.label || 'item')),
      onchange: function (e) { if (e.target.value === '__banks') { e.target.value = it.account || ''; go('accounts'); return; } it.account = e.target.value; commit(); } },
      [h('option', { value: '', text: isIncome && mainPayName() ? mainPayName() + ' (main)' : 'None' })].concat(names.map(function (n) { var lc = locCur(locByName(n)); return h('option', { value: n, text: n + (lc !== homeCode() ? ' · ' + curSym(lc).trim() : '') }); }),
        [h('option', { disabled: true, text: '──────────' }), h('option', { value: '__banks', text: '✎ Add or edit bank accounts…' })]));
    loc.value = it.account || '';
    var auto = h('button', { type: 'button', class: 'auto c-auto', 'aria-pressed': String(!!it.automated), 'aria-label': 'Automated: ' + (it.label || 'item'), title: it.automated ? 'Automated' : 'Not automated', html: CHECK,
      onclick: function () { it.automated = !it.automated; track('automated', null, true); commit(); } });
    row.append(grip,
      linkTag(it) ? h('div', { class: 'c-name name-wrap' }, [field('lbl-' + it.id, it.label, function (v) { it.label = v; commit(); }, { cls: 'cell', ph: 'Item name', label: 'Item name' }), linkTag(it)])
        : field('lbl-' + it.id, it.label, function (v) { it.label = v; commit(); }, { cls: 'cell c-name', ph: 'Item name', label: 'Item name' }),
      loc,
      isIncome ? h('button', { type: 'button', class: 'c-date pay-btn' + (lineRuleShort(it) ? '' : ' empty'), 'data-k': 'day-' + it.id, 'aria-label': 'Payday for ' + (it.label || 'this pay') + ': ' + (lineRuleShort(it) || 'not set'), onclick: function () { set({ overlay: 'payLine', payLineId: it.id }); } }, [lineRuleShort(it) || 'Set']) : daySelect('day-' + it.id, it.payDay, function (v) { it.payDay = v; commit(); }, 'c-date', 'Payment date for ' + (it.label || 'item')),
      auto,
      lastMode() ? (function () { var lv = lastVal(it), pm2 = prevMonth(); return h('span', { class: 'cell num c-tgt c-last', title: 'Your ' + pm2.month + ' ' + pm2.year + ' amount, as the planner shows that month. Switch to Budgeted in Tools to change your plan.', text: '£' + fmt(lv) }); })()
        : field('tgt-' + it.id, it.target, function (v) { setBudgeted(it, v); }, { cls: 'cell num c-tgt', ph: '0', num: true, money: true, label: (isIncome ? 'Budgeted pay for ' : 'Budgeted for ') + (it.label || 'item') }),
      field('bud-' + it.id, it.budgeted, function (v) { it.budgeted = v; commit(); }, { cls: 'cell num c-bud', ph: '0', num: true, money: true, label: (isIncome ? 'This pay for ' : 'This month for ') + (it.label || 'item') }),
      btn('rm c-rm', 'Remove ' + (it.label || 'item'), function () { if (it.extraId) state.debtExtras = state.debtExtras.filter(function (y) { return y.id !== it.extraId; }); if (it.saveExtraId) state.savingExtras = state.savingExtras.filter(function (y) { return y.id !== it.saveExtraId; }); if (it.investExtraId) state.investExtras = state.investExtras.filter(function (y) { return y.id !== it.investExtraId; }); removeItemWithUndo(it); }, ['✕']));
    var icur = itemCur(it);
    if (icur !== homeCode()) {
      fxRow(row, icur); row.classList.add('fx-row');
      row.append(h('span', { class: 'fx-home', title: 'In ' + curPlural(homeCode()) + ', at your rate', text: '≈ ' + money(amt(it.budgeted) * fxRate(icur)) }));
    }
    decorateRow(row, it, isIncome, gkey);
    if (gkey === 'costs' && !it.payDay) { var ds = row.querySelector('.c-date'); if (ds) { ds.classList.add('needs-date'); ds.title = 'Set the day this bill is paid'; } }
    return row;
  }

  // One strip per other currency: what comes in and goes out in it this month, kept in that currency.
  function fxStrip(code) {
    var inn = 0, out = 0, n = 0;
    state.groups.forEach(function (g) { g.categories.forEach(function (c) { c.items.forEach(function (it) {
      if (itemCur(it) !== code) return; n++;
      if (g.key === 'income') inn += amt(it.budgeted); else out += amt(it.budgeted);
    }); }); });
    var has = fxHasRate(code), left = inn - out, sy = curSym(code).trim();
    var stat = function (k, v, cls) { return h('div', { class: 'fx-stat' + (cls ? ' ' + cls : '') }, [h('span', { text: k }), h('b', { text: moneyAs(v, code) })]); };
    return h('section', { class: 'fx-strip' + (has ? '' : ' warn') }, [
      h('span', { class: 'fx-ic', text: sy }),
      h('div', { class: 'fx-t' }, [h('b', { text: 'Your ' + curName(code).toLowerCase() + ' money this month' }),
        h('small', {}, [n ? 'Kept in ' + curPlural(code) + '. Only your totals are converted. ' : 'Nothing paid from or into your ' + sy + ' accounts yet. ',
          has ? h('span', { text: sy + '1 = ' + money(fxRate(code)) + ' · ' }) : h('b', { text: 'Add a rate so your totals are right. ' }),
          btn('fx-change', has ? 'Change the rate' : 'Add the rate', function () { go('accounts'); }, [has ? 'Change rate' : 'Add rate ›'])])]),
      n ? h('div', { class: 'fx-stats' }, [stat('In', inn), stat('Out', out), stat('Left', left, left < 0 ? 'neg' : 'pos')]) : null ]);
  }

  /* ---------- overlays ---------- */
  function sheet(title, sub, body, wide) {
    var back = h('div', { class: 'overlay' + (shown.overlayEnter ? ' enter' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
      onclick: function (e) { if (e.target === back) closeOverlay(); } });
    back.append(h('div', { class: 'sheet' + (wide === true ? ' wide' : wide ? ' ' + wide : '') }, [
      btn('sheet-close', 'Close ' + title, function () { set({ overlay: null, exportMsg: null }); }, ['✕']),
      h('h3', { text: title }), h('p', { class: 'sub', text: sub }), body ]));
    return back;
  }
  function locationsBody() {
    var t = totals(), list = h('div', { class: 'sheet-list' });
    state.locations.forEach(function (l) {
      // Two lines: the name and totals on top, how money gets there underneath, so the name never gets squeezed.
      list.append(h('div', { class: 'sheet-row loc-row' }, [
        h('div', { class: 'loc-top' }, [
          field('locname-' + l.id, l.name, function (v) { setLocationName(l, v.trim()); }, { ph: 'Bank or account name', label: 'Bank account name' }),
          h('span', { class: 'loc-total', title: flowNote(l.name) || '', text: moneyAs(t.byLoc[l.name] || 0, locCur(l)) + ' out' + (l.payIn && accFlow(l.name).pay ? ' · ' + moneyAs(accFlow(l.name).pay, locCur(l)) + ' in' : '') }),
          btn('rm', 'Remove bank account', function () { removeLocation(l); }, ['✕']) ]),
        h('div', { class: 'loc-bot' }, [
          locHow(l),
          payIntoLines(l.name).length ? h('span', { class: 'loc-pays' }, payIntoLines(l.name).map(function (it) { return btn('pay-btn', 'Payday for ' + (it.label || 'pay'), function () { set({ overlay: 'payLine', payLineId: it.id }); }, [(it.label || 'Pay') + ': ' + (lineRuleShort(it) || 'set payday')]); }))
            : h('label', { class: 'loc-day', for: 'locday-' + l.id }, [h('span', { text: l.how === 'hand' ? 'Moved on' : 'Moves on' }), daySelect('locday-' + l.id, l.day, function (v) { l.day = v; commit(); }, '', 'Day money moves into ' + (l.name || 'this location'))]),
          multiCur() ? (function () { var cs = h('select', { class: 'cur-sel loc-cur', 'aria-label': 'Currency for ' + (l.name || 'this account'), onchange: function (e) { l.cur = e.target.value === homeCode() ? '' : e.target.value; commit(); } });
            CURS.forEach(function (c) { var o = document.createElement('option'); o.value = c[0]; o.textContent = c[1].trim() + ' ' + c[0]; cs.append(o); }); cs.value = l.cur || homeCode(); return cs; })() : null ]) ]));
    });
    var rates = fxCodes().length ? h('div', { class: 'fx-rates' }, [h('h4', { class: 'cp-k', text: 'Exchange rates' }),
      h('small', { class: 'cp-sub', text: 'What 1 of each currency is worth in ' + curPlural(homeCode()) + '. Check your bank app or Wise and update it now and then. When you stamp a month, the rate is saved with it.' })].concat(fxCodes().map(function (code) {
        var at = (state.fxRatesAt || {})[code];
        return h('label', { class: 'fx-rate', for: 'f-fx-' + code }, [h('span', { text: curSym(code).trim() + '1 is worth ' + cur().trim() }),
          field('fx-' + code, (state.fxRates || {})[code] || '', function (v) { state.fxRates = Object.assign({}, state.fxRates); state.fxRates[code] = v; state.fxRatesAt = Object.assign({}, state.fxRatesAt); state.fxRatesAt[code] = Date.now(); commit(); }, { cls: 'cp-in cp-in-sm', num: true, ph: cur() + '0.00', label: 'Rate for ' + curName(code) }),
          h('small', { class: 'cp-sub', text: at ? 'Updated ' + new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'Not set yet' })]);
      }))) : null;
    return h('div', {}, [list, rates, h('div', { class: 'btn-row', style: 'margin-top:14px' }, [btn('sheet-add', 'Add bank account', function () { state.locations.push({ id: uid('loc'), name: '' }); commit(); }, ['+ Add bank account'])]),
      h('div', { class: 'hint', text: 'Say which account your pay goes into, and how money gets to the others: by standing order, or moved by hand. PayStamp never connects to your bank. Removing an account clears it from any items that used it.' })]);
  }
  /* ---------- v3.4: the PayStamp app (a PWA) ----------
     Android and laptop Chrome/Edge offer an install prompt (beforeinstallprompt), which we keep for the button.
     iPhone and iPad have no prompt, so the page shows the Share › Add to Home Screen steps instead. */
  var installEvt = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvt = e; scheduleRender(); });
  window.addEventListener('appinstalled', function () { installEvt = null; state.appInstalled = true; scheduleRender(); });
  function isAppMode() { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { return false; } }
  function deviceKind() {
    var ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    return 'desktop';
  }
  function runInstall() {
    if (!installEvt) return;
    var e = installEvt; installEvt = null;
    e.prompt();
    (e.userChoice || Promise.resolve({})).then(function (c) { if (c && c.outcome === 'accepted') state.appInstalled = true; scheduleRender(); });
  }
  var SHARE_IC = '<svg class="ios-share" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="the Share button"><path d="M12 3v12M7.5 7.5L12 3l4.5 4.5"/><path d="M7 11H5.5A1.5 1.5 0 0 0 4 12.5v7A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H17"/></svg>';
  function appBody() {
    var kind = state.appTab || deviceKind();
    var steps = {
      ios: ['Open <b>paystamp.co.uk</b> in <b>Safari</b> (the app can only be added from Safari on older iPhones).',
            'Tap the <b>Share</b> button ' + SHARE_IC + ' at the bottom of the screen (at the top on an iPad).',
            'Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.',
            'Open PayStamp from your home screen. You’ll only need to sign in once.'],
      android: ['Open <b>paystamp.co.uk</b> in <b>Chrome</b>.',
            'Tap the <b>⋮</b> menu in the top corner.',
            'Tap <b>Install app</b> (or <b>Add to Home screen</b>), then <b>Install</b>.',
            'Open PayStamp from your home screen or app drawer.'],
      desktop: ['Open <b>paystamp.co.uk</b> in <b>Chrome</b> or <b>Edge</b>.',
            'Click the <b>install</b> icon at the right-hand end of the address bar (a screen with a down arrow).',
            'Click <b>Install</b>. PayStamp opens in its own window and appears with your other apps.'] };
    var hero = h('div', { class: 'app-hero' }, [h('img', { src: '/icon-192.png', alt: '', class: 'app-ic', onerror: function () { this.style.display = 'none'; } }), h('div', {}, [h('b', { text: 'PayStamp on your home screen' }), h('span', { text: 'One tap to your plan, full screen, no browser bars.' })])]);
    if (isAppMode() || state.appInstalled) return h('div', { class: 'f-body' }, [hero,
      h('div', { class: 'app-ok' }, [h('span', { class: 'xb-ok-ic', html: TICK_SVG }), isAppMode() ? 'You’re using the PayStamp app. Nice.' : 'PayStamp is installed. Open it from your home screen.']),
      h('p', { class: 'app-note', text: 'Updates arrive by themselves: whenever PayStamp changes, the app picks it up the next time you open it.' }) ]);
    var tabs = h('div', { class: 'seg-o app-tabs' }, [['ios', 'iPhone / iPad'], ['android', 'Android'], ['desktop', 'Laptop']].map(function (t) {
      return btn('', t[1], function () { set({ appTab: t[0] }); }, [t[1]], { 'aria-pressed': String(kind === t[0]) });
    }));
    var list = h('ol', { class: 'app-steps' });
    steps[kind].forEach(function (x) { list.append(h('li', { html: '<span>' + x + '</span>' })); });
    return h('div', { class: 'f-body' }, [hero,
      installEvt ? h('div', { class: 'btn-row' }, [btn('pill-btn primary', 'Install PayStamp', runInstall, ['Install PayStamp']), h('span', { class: 'app-note', text: 'Your browser can install it in one click.' })]) : null,
      tabs, list,
      h('p', { class: 'app-note', text: 'It’s the same PayStamp, with the same account and plan, just quicker to open. Nothing is downloaded from an app store, and you can remove it like any other app.' }) ]);
  }
  // A one-off card on phones, once someone has their own plan, until they add the app or say no thanks.
  /* v4.3: ask for a review once someone has stamped two months. It goes to PayStamp as feedback (area "Review");
     it only appears on the home page if they ticked that it can be shown there. */
  function reviewCard() {
    if (state.reviewDone || state.isExample || (state.records || []).filter(function (r) { return !r.example; }).length < 2) return null;
    return h('section', { class: 'ex-card rv-ask' }, [
      h('span', { class: 'ex-ic', text: '★' }),
      h('div', { class: 'ex-t' }, [h('b', { text: 'How’s PayStamp going?' }), h('span', { text: 'A short review helps other people decide to try it. It takes a minute.' })]),
      h('div', { class: 'ex-btns' }, [
        btn('ex-keep', 'Not now', function () { set({ reviewDone: 'later' }); }, ['Not now']),
        btn('ex-clear', 'Write a review', function () { state.rv = { stars: 0, text: '', name: '', show: true }; openOverlay('review'); }, ['Write a review']) ]) ]);
  }
  function reviewBody() {
    var R = state.rv || (state.rv = { stars: 0, text: '', name: '', show: true });
    if (R.sent) return h('div', { class: 'rv-form' }, [h('p', { class: 'rv-thanks', text: 'Thank you! Your review has been sent.' }), btn('pill-btn primary', 'Close', function () { set({ overlay: null }); }, ['Close'])]);
    var stars = h('div', { class: 'rv-stars', role: 'radiogroup', 'aria-label': 'Stars' }, [1, 2, 3, 4, 5].map(function (n) {
      return btn('rv-star' + (n <= R.stars ? ' on' : ''), n + (n === 1 ? ' star' : ' stars'), function () { R.stars = n; set({}); }, ['★'], { role: 'radio', 'aria-checked': n === R.stars ? 'true' : 'false' }); }));
    var ta = h('textarea', { class: 'rv-ta', rows: '4', placeholder: 'What do you like about PayStamp? What has it helped you with?', 'aria-label': 'Your review' }); ta.value = R.text;
    ta.addEventListener('input', function () { R.text = ta.value; });
    var nm = h('input', { type: 'text', class: 'rv-in', placeholder: 'e.g. Sam, Leeds', 'aria-label': 'Name to show' }); nm.value = R.name;
    nm.addEventListener('input', function () { R.name = nm.value; });
    var chk = h('input', { type: 'checkbox' }); chk.checked = R.show !== false; chk.addEventListener('change', function () { R.show = chk.checked; });
    var P = window.PayStamp || {};
    return h('div', { class: 'rv-form' }, [stars, ta,
      h('label', { class: 'rv-l' }, [h('span', { text: 'Name to show (first name and town is fine)' }), nm]),
      h('label', { class: 'rv-c2' }, [chk, h('span', { text: 'PayStamp can show this review on its home page' })]),
      R.err ? h('p', { class: 'rv-err', text: R.err }) : null,
      btn('pill-btn primary', 'Send review', function () {
        if (!R.stars) { R.err = 'Pick how many stars first.'; set({}); return; }
        R.err = '';
        var msg = '★'.repeat(R.stars) + '☆'.repeat(5 - R.stars) + ' (' + R.stars + '/5)\n\n' + (R.text || '(no words)') + '\n\nName to show: ' + (R.name || '(none)') + '\nOK to show on the home page: ' + (R.show !== false ? 'YES' : 'no');
        var F = state.founder || {};
        Promise.resolve(P.sendFeedback ? P.sendFeedback({ kind: 'feedback', area: 'Review', message: msg, contactOk: false, founder: F.number || null, month: (state.month || '') + ' ' + (state.year || ''), userAgent: navigator.userAgent, screen: innerWidth + 'x' + innerHeight }) : null)
          .then(function () { R.sent = true; set({ reviewDone: 'sent' }); }, function () { R.err = 'That didn’t send. Check your connection and try again.'; set({}); });
      }, ['Send review']) ]);
  }
  function appNudge() {
    if (isAppMode() || state.appInstalled || state.appNudgeHidden || state.isExample || deviceKind() === 'desktop') return null;
    if (!(state.records || []).length && !state.setupDone) return null;
    return h('section', { class: 'ex-card app-nudge' }, [
      h('span', { class: 'ex-ic', html: IC.phone }),
      h('div', { class: 'ex-t' }, [h('b', { text: 'Put PayStamp on your home screen' }), h('span', { text: 'It opens like an app, so your plan is one tap away on payday.' })]),
      h('div', { class: 'ex-btns' }, [
        btn('ex-keep', 'No thanks', function () { set({ appNudgeHidden: true }); }, ['No thanks']),
        btn('ex-clear', 'Show me how', function () { if (installEvt) runInstall(); else go('app'); }, [installEvt ? 'Install' : 'Show me how']) ]) ]);
  }
  /* ---------- v3.5: your data ----------
     Download everything as a file, read the privacy page, or delete the account. */
  function downloadData() {
    var P = window.PayStamp || {}, out = { app: 'PayStamp', version: WN[0].version, exported: new Date().toISOString(), email: P.getEmail ? P.getEmail() : '', plan: {} };
    SAVED_KEYS.forEach(function (k) { if (state[k] !== undefined) out.plan[k] = state[k]; });
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    var a = document.createElement('a'), d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = 'paystamp-data-' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '.json';
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }
  function dataBody() {
    var P = window.PayStamp || {}, del = state.delStep || 0;
    var danger;
    if (!del) danger = h('div', { class: 'danger' }, [h('b', { text: 'Delete my account' }),
      h('p', { text: 'Deletes your plan, Records, founder number and sign-in for good. It can’t be undone, so download your data first if you might want it.' }),
      h('div', { class: 'btn-row' }, [btn('btn-danger-ghost', 'Delete my account', function () { set({ delStep: 1, delErr: '' }); }, ['Delete my account…'])]) ]);
    else {
      var box = h('input', { type: 'text', class: 'tf', id: 'del-confirm', 'data-k': 'del-confirm', autocomplete: 'off', placeholder: 'DELETE', 'aria-label': 'Type DELETE to confirm' });
      var go1 = btn('btn-danger', 'Delete my account for good', function () {
        if (box.value.trim().toUpperCase() !== 'DELETE') return;
        if (!P.deleteAccount) { set({ delErr: 'This is a preview, so there’s no account to delete.' }); return; }
        go1.disabled = true; go1.textContent = 'Deleting…';
        P.deleteAccount().catch(function (e) { set({ delErr: 'That didn’t work (' + ((e && e.message) || 'unknown error') + '). Nothing was deleted. Please try again, or email hello@paystamp.co.uk.' }); });
      }, ['Delete for good'], { disabled: true });
      box.addEventListener('input', function () { go1.disabled = box.value.trim().toUpperCase() !== 'DELETE'; });
      danger = h('div', { class: 'danger' }, [h('b', { text: 'Are you sure?' }),
        h('p', { text: 'Your whole plan, Records and founder number will be deleted straight away. Suggestions you sent are kept without your name or email. Type DELETE to confirm.' }),
        box, state.delErr ? h('p', { style: 'color:var(--warn);font-weight:600', text: state.delErr }) : null,
        h('div', { class: 'btn-row' }, [go1, btn('pill-btn', 'Keep my account', function () { set({ delStep: 0, delErr: '' }); }, ['Keep my account'])]) ]);
    }
    return h('div', { class: 'data-card' }, [
      h('div', { class: 'card-box' }, [
        h('p', { class: 'f-hint', style: 'margin:0 0 12px', text: 'Other users can never see your plan. PayStamp never connects to your bank, has no adverts and never sells your data.' }),
        h('div', { class: 'btn-row' }, [btn('pill-btn', 'Download my data', downloadData, ['Download my data']),
          btn('pill-btn', 'Read the privacy page', function () { go('privacy'); }, ['Read the privacy page'])]) ]),
      usageSwitch(),
      danger ]);
  }

  /* ---------- v3.5: Admin (owner only) ----------
     Numbers, feedback with a status for each, and the founders. Loaded fresh each time it opens. */
  var adminData = null, adminBusy = false, adminErr = '';
  function adminLoad() {
    var P = window.PayStamp || {}; if (!P.adminOverview || adminBusy) return;
    adminBusy = true; adminErr = '';
    P.adminOverview().then(function (d) { adminData = d; adminBusy = false; scheduleRender(); },
      function (e) { adminBusy = false; adminErr = (e && e.message) || 'Couldn’t load'; scheduleRender(); });
  }
  var FB_STATUS = [['new', 'New'], ['noted', 'Noted'], ['planned', 'Planned'], ['done', 'Fixed ✓'], ['not_now', 'Not now']];
  var FB_OPEN = { 'new': 1, noted: 1, planned: 1 };
  function fbKindName(k) { return k === 'bug' ? 'Bug' : k === 'feedback' ? 'Feedback' : 'Idea'; }
  function fbStatusName(v) { for (var i = 0; i < FB_STATUS.length; i++) if (FB_STATUS[i][0] === v) return FB_STATUS[i][1].replace(' ✓', ''); return 'New'; }
  // v4.3: a review sent from inside PayStamp, read back out of the message
  function parseReview(f) {
    var m = String(f.message || ''), stars = (m.match(/★/g) || []).length;
    var parts = m.split('\n\n'), words = parts.length > 2 ? parts.slice(1, -1).join('\n\n') : '';
    var name = (m.match(/Name to show: (.*)/) || [])[1] || '', ok = /OK to show on the home page: YES/.test(m);
    if (words === '(no words)') words = ''; if (name === '(none)') name = '';
    return { stars: stars, words: words, name: name, ok: ok };
  }
  function reviewView(f) {
    var R = parseReview(f);
    var line = '[' + R.stars + ', ' + JSON.stringify(R.words) + ', ' + JSON.stringify(R.name || 'A PayStamp user') + ', ' + JSON.stringify(f.founder_number ? String(f.founder_number) : '') + '],';
    return h('div', { class: 'pa-rv' }, [
      h('div', { class: 'pa-rv-s', 'aria-label': R.stars + ' out of 5 stars' }, ['★★★★★'.slice(0, R.stars), h('i', { text: '★★★★★'.slice(R.stars) })]),
      R.words ? h('blockquote', { text: R.words }) : h('p', { class: 'f-hint', text: 'No words, just stars.' }),
      h('div', { class: 'pa-rv-f' }, [h('span', { text: R.name ? '— ' + R.name : '— no name given' }),
        R.ok ? h('span', { class: 'pa-rv-ok', text: 'Happy to be shown' }) : h('span', { class: 'pa-rv-no', text: 'Not for the home page' }),
        R.ok && R.words ? btn('pill-btn', 'Copy this review for the home page', function () { copyText(line, 'rvCopy' + f.id); }, [state.cpCopied === 'rvCopy' + f.id ? 'Copied: send it to Claude' : 'Copy for the home page']) : null ]) ]);
  }
  function adminBody() {
    var P = window.PayStamp || {};
    if (!(P.isOwner && P.isOwner())) return h('p', { class: 'f-hint', text: 'This page is only for the PayStamp owner.' });
    if (!adminData && !adminBusy && !adminErr) setTimeout(adminLoad, 0);
    if (adminErr) return h('div', { class: 'f-body' }, [h('p', { class: 'f-hint', style: 'color:var(--warn)', text: 'Couldn’t load the admin data: ' + adminErr + '. Have you run supabase-v4.1.sql?' }), btn('pill-btn', 'Try again', adminLoad, ['Try again'])]);
    if (!adminData) return h('p', { class: 'f-hint', text: 'Loading…' });
    var D = adminData, tab = state.adminTab || 'usage', filt = state.adminFilter || 'open';
    if (!usageMore[7] && !usageMoreBusy[7]) setTimeout(function () { usageMoreLoad(7); }, 0);
    var stat = function (n, label, hot) { return h('div', { class: 'pa-stat' + (hot ? ' hot' : '') }, [h('b', { text: String(n) }), h('small', { text: label })]); };
    var stats = h('div', { class: 'pa-stats' }, [stat(D.users, 'Accounts'), stat(D.new_7d, 'New this week'), stat(usageMore[7] ? (usageMore[7].error ? (D.active_7d != null ? D.active_7d : '–') : usageMore[7].active) : '…', 'Active this week'),
      stat(D.founders, 'Founders'), stat(D.places_left, 'Places left'), stat(D.feedback_new, 'New feedback', D.feedback_new > 0), stat((D.answers || []).length, 'Answers' + (D.answers_7d ? ' · ' + D.answers_7d + ' new' : ''), D.answers_7d > 0)]);
    var seg = h('div', { class: 'seg-o' }, [['usage', 'Usage'], ['feedback', 'Feedback' + (D.feedback_new ? ' (' + D.feedback_new + ')' : '')], ['answers', 'Answers (' + (D.answers || []).length + ')'], ['founders', 'Founders']].map(function (t) {
      return btn('', t[1], function () { set({ adminTab: t[0] }); }, [t[1]], { 'aria-pressed': String(tab === t[0]) });
    }));
    var body;
    if (tab === 'usage') body = usageBody();
    else if (tab === 'answers') body = adminAnswers(D);
    else if (tab === 'feedback') {
      if (filt === 'open' || filt === 'todo') filt = 'todo';
      var all = D.feedback || [];
      var isRv = function (f) { return f.area === 'Review'; };
      var cnt = { todo: 0, done: 0, not_now: 0, reviews: 0 };
      all.forEach(function (f) { var st = f.status || 'new'; if (isRv(f)) cnt.reviews++; if (FB_OPEN[st]) cnt.todo++; else if (st === 'done') cnt.done++; else cnt.not_now++; });
      var list = all.filter(function (f) { var st = f.status || 'new'; return filt === 'all' || (filt === 'reviews' ? isRv(f) : filt === 'todo' ? FB_OPEN[st] : st === filt); });
      var fseg = h('div', { class: 'seg-o pa-fseg' }, [['todo', 'To do (' + cnt.todo + ')'], ['reviews', '★ Reviews (' + cnt.reviews + ')'], ['done', 'Fixed (' + cnt.done + ')'], ['not_now', 'Not now (' + cnt.not_now + ')'], ['all', 'Everything']].map(function (t) {
        return btn('', t[1], function () { set({ adminFilter: t[0] }); }, [t[1]], { 'aria-pressed': String(filt === t[0]) });
      }));
      var copyAll = btn('pill-btn', 'Copy these messages as a list', function () {
        var txt = 'PayStamp feedback (' + list.length + '), newest first. The #numbers match Admin › Feedback.\n\n' + list.map(function (f) { var d = new Date(f.created_at); return '#' + f.id + ' [' + fbKindName(f.kind) + '] [' + fbStatusName(f.status || 'new') + '] ' + (f.area || '') + ' · ' + d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) + (f.founder_number ? ' · Founder #' + f.founder_number : '') + (f.screen ? ' · ' + f.screen : '') + '\n   ' + String(f.message || '').replace(/\n/g, '\n   '); }).join('\n\n');
        copyText(txt, 'adminCopy');
      }, [state.cpCopied === 'adminCopy' ? 'Copied' : 'Copy as a list']);
      var setSt = function (f, v) {
        var old = f.status || 'new'; if (old === v) return; f.status = v; scheduleRender();
        var undo = function () { f.status = old; scheduleRender(); P.adminSetStatus(f.id, old).then(recount, function () {}); };
        P.adminSetStatus(f.id, v).then(function () { recount(); if (v === 'done') showUndo('#' + f.id + ' ticked off as fixed', undo); },
          function () { f.status = old; scheduleRender(); showUndo('Couldn’t save that. Has the v3.4.2 SQL been run?', function () {}); });
      };
      var recount = function () { D.feedback_new = (D.feedback || []).filter(function (x) { return (x.status || 'new') === 'new'; }).length; scheduleRender(); };
      body = h('div', { class: 'pa-list' }, [h('div', { class: 'pa-bar' }, [fseg, h('span', { class: 'pa-bar-r' }, [copyAll])])].concat(
        list.length ? list.map(function (f) {
          var st = f.status || 'new', d = new Date(f.created_at);
          var chips = h('div', { class: 'pa-sts', role: 'group', 'aria-label': 'Status of #' + f.id }, FB_STATUS.map(function (x) {
            return btn('pa-sb s-' + x[0], x[1], function () { setSt(f, x[0]); }, [x[1]], { 'aria-pressed': String(st === x[0]) });
          }));
          return h('article', { class: 'pa-fb st-' + st + (st === 'new' ? ' new' : '') }, [
            h('div', { class: 'pa-top' }, [h('span', { class: 'pa-id', text: '#' + f.id }), h('span', { class: 'pa-kind' + (f.kind === 'bug' ? ' bug' : f.kind === 'feedback' ? ' fbk' : ''), text: fbKindName(f.kind) }),
              f.area ? h('b', { text: f.area }) : null, h('span', { text: d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getFullYear() }),
              f.founder_number ? h('span', { text: 'Founder #' + f.founder_number }) : null]),
            f.area === 'Review' ? reviewView(f) : h('p', { class: 'pa-msg', text: f.message }),
            h('div', { class: 'pa-foot' }, [
              f.email ? (f.contact_ok ? h('a', { href: 'mailto:' + f.email + '?subject=' + encodeURIComponent('Your PayStamp message'), text: 'Reply to ' + f.email }) : h('span', { text: f.email + ' · didn’t ask for a reply' })) : h('span', { text: 'Account deleted' }),
              chips ]) ]);
        }) : [h('p', { class: 'f-hint', text: filt === 'todo' ? 'Nothing to do. Everything has been ticked off.' : filt === 'all' ? 'No feedback yet.' : 'Nothing here yet.' })]));
    } else {
      var rows = (D.founder_list || []).map(function (x) {
        return h('div', { class: 'pa-tr' }, [h('b', { text: '#' + x.founder_number }), h('span', { text: x.email + (x.elite_number ? ' · Elite #' + x.elite_number : '') }), h('span', { text: x.founder_since || '' }), h('span', { text: x.invited + ' invited' })]);
      });
      body = h('div', { class: 'pa-tbl' }, [h('div', { class: 'pa-tr' }, [h('span', { text: 'No.' }), h('span', { text: 'Email' }), h('span', { text: 'Since' }), h('span', { text: 'Invites' })])].concat(rows));
    }
    return h('div', { class: 'f-body' }, [stats, h('div', { class: 'pa-bar' }, [seg, tab === 'usage' ? null : btn('pill-btn', 'Refresh', function () { adminData = null; adminLoad(); scheduleRender(); }, ['Refresh'])]), body]);
  }
  /* ---------- v3.5: the privacy page inside PayStamp ----------
     Reads privacy.html (the same page the home page links to), so there's only one copy to keep up to date. */
  var privacyHTML = null, privacyErr = false;
  function privacyBody() {
    if (privacyHTML == null && !privacyErr) {
      fetch('privacy.html', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); }).then(function (t) {
        var doc = new DOMParser().parseFromString(t, 'text/html'), main = doc.querySelector('main');
        if (!main) throw new Error('no content');
        var h1 = main.querySelector('h1'); if (h1) h1.remove();
        var lede = main.querySelector('.lede'); if (lede) lede.remove();
        main.querySelectorAll('script, style, iframe').forEach(function (n) { n.remove(); });
        main.querySelectorAll('a[href^="http"]').forEach(function (a) { a.target = '_blank'; a.rel = 'noopener'; });
        privacyHTML = main.innerHTML; scheduleRender();
      }).catch(function () { privacyErr = true; scheduleRender(); });
    }
    if (privacyErr) return h('p', { class: 'f-hint' }, ['The privacy page didn’t load. You can read it at paystamp.co.uk/privacy.html, or email hello@paystamp.co.uk.']);
    if (privacyHTML == null) return h('p', { class: 'f-hint', text: 'Loading…' });
    return h('div', { class: 'pv-body', html: privacyHTML });
  }
  /* =====================================================================
     v3.4: COMPASS
     Compass replaces More. In the plum bar it opens a dropdown (on a phone, a sheet) with the
     overview, the 9 topics, Shape PayStamp and the tools. Each topic opens as an overlay with
     Learn (a short lesson, from the PayStamp course), Do (a working part built from the plan) and Check.
     Saved keys: cpRead {topic: true}, sinking [{id, name, yearly}], direct {answers, sentAt},
     creditTarget (a % of each card's limit). Debts can have card, limit and dueDay.
     ===================================================================== */
  PAGE_INFO['cp-direct'] = ['Shape PayStamp', 'Report a bug, suggest an idea, or answer a few quick questions. Come back any time.', 'mid'];

  // v3.7: Percentages can be worked out from your Budgeted pay, this month's pay, or a number you type.

  function debtsMonthlyTotal() { return (state.debts || []).reduce(function (t, d) { return t + debtPayNow(d); }, 0); }

  function efGoal() { return amt(state.efGoal) > 0 ? amt(state.efGoal) : 1000; }

  function cards() { return (state.debts || []).filter(function (d) { return d.card; }); }
  // A credit card is also somewhere to pay from: it gets a matching bank account (loc.cardId).
  function cardLoc(d) { return (state.locations || []).find(function (l) { return l.cardId === d.id; }); }
  function syncCardLocs() {
    if (!state.locations || !state.debts) return;
    cards().forEach(function (d) { if (!cardLoc(d)) state.locations.push({ id: uid('loc'), name: d.name || 'Credit card', day: '', how: 'auto', cardId: d.id }); });
    state.locations = state.locations.filter(function (l) { return !l.cardId || findDebt(l.cardId); });
  }

  function cardSpend(d) { var l = cardLoc(d); if (!l) return 0; return spendItems().reduce(function (t, x) { return t + (x.it.account === l.name ? amt(x.it.budgeted) : 0); }, 0); }
  // A sinking fund's money so far: what you had before PayStamp plus every stamped month's payment into it.
  /* v3.4.2: the type of each cost is the planner group it sits in. */

  function costKey(it) { return it.coupleId ? 'cp:' + it.coupleId : /^snk_/.test(it.id) ? 's:' + it.id.slice(4) : 'c:' + it.id; }

  // Sinking funds in the planner: one line for all, or one line per fund, in Costs › Sinking funds.
  function syncSinking() {
    if (!state.groups || !state.sinking) return;
    var g = findGroup('costs'); if (!g) return;
    state.sinkPlan = 'each'; // always one planner line (and pot) per sinking fund
    // variable costs used to have their own group: they now sit in Fixed costs
    var vc = g.categories.find(function (c) { return c.id === 'cat_variable'; });
    if (vc) { var fx = g.categories.find(function (c) { return c.id === 'cat_fixed'; }); if (fx) { fx.items = fx.items.concat(vc.items); g.categories = g.categories.filter(function (c) { return c !== vc; }); } else { vc.id = 'cat_fixed'; vc.name = 'Fixed costs'; } }
    var mode = state.sinkPlan; if (!mode) return;
    var cat = g.categories.find(function (c) { return c.id === 'cat_sinking'; });
    if (!cat) { cat = { id: 'cat_sinking', name: 'Sinking funds', items: [] }; g.categories.push(cat); }
    var want = {};
    // v3.4.2: a change made in the planner (Budgeted or the name) updates the sinking fund itself
    state.sinking.forEach(function (x) {
      var f0 = findItem('snk_' + x.id); if (!f0) return;
      if (f0.item.snkT != null && f0.item.target !== f0.item.snkT && amt(f0.item.target) > 0) x.yearly = String(Math.round(amt(f0.item.target) * 12 * 100) / 100);
      if (f0.item.snkL != null && f0.item.label !== f0.item.snkL && f0.item.label) x.name = f0.item.label;
    });
    state.sinking.forEach(function (x) { if (amt(x.yearly) > 0) want['snk_' + x.id] = { label: x.name || 'Sinking fund', amt: Math.round(amt(x.yearly) / 12 * 100) / 100 }; });
    spendItems().forEach(function (x) { if (/^snk_/.test(x.it.id) && !want[x.it.id]) { var f = findItem(x.it.id); if (f) f.c.items.splice(f.idx, 1); } });
    Object.keys(want).forEach(function (id) {
      var w = want[id], f = findItem(id), v = String(w.amt);
      if (!f) { cat.items.push({ id: id, label: w.label, target: v, budgeted: v, account: '', runs: '', due: '', automated: false, snkT: v, snkL: w.label }); return; }
      if (f.c !== cat) { f.c.items.splice(f.idx, 1); cat.items.push(f.item); }
      f.item.label = w.label;
      if (amt(f.item.target) !== amt(v)) { if (!f.item.target || f.item.target === f.item.budgeted) f.item.budgeted = v; f.item.target = v; }
      f.item.snkT = f.item.target; f.item.snkL = f.item.label;
    });
    g.categories = g.categories.filter(function (c) { return !(c.id === 'cat_sinking' && !c.items.length); });
  }
  
  // Money put into ISA investments this tax year (6 April to 5 April), from stamped months.

  /* Each topic's status and one-line summary, worked out from the plan. */
  /* Money flow: pay arrives in one bank, standing orders move it to your other banks, then each
     bank pays its bills, pots and investments. autoCheck = { ticks: { key: true }, last: ISO date, started: ISO date }.
     "Start a check" unticks everything so you can go through each one again. */
  /* v3.4.2: compare accounts for a pot of money (emergency fund, savings goals).
     base = how much is saved there now, rate = the rate it earns now (average), so each account shows
     what moving that money would earn in a year compared with today. */

  /* ---------- v3.4.2: the Automation plan ----------
     autoModel() lays out the next pay cycle day by day (pay landing, money moving between banks, pots,
     card payments and every dated bill), works out the real day each one happens (standing orders and
     Direct Debits set for a weekend go on the next working day) and spots timing clashes: a bill leaving
     an account before that account's money arrives. Each move remembers the amount its standing order
     was set to (soAmt) so PayStamp can say when the plan has changed and the standing order needs updating. */

  // what the standing order should send: the Budgeted amounts (anything above Budgeted this month is sent by hand, in the Extras box)

  function copyText(txt, key) {
    var done = function () { state.cpCopied = key; scheduleRender(); setTimeout(function () { if (state.cpCopied === key) { state.cpCopied = ''; scheduleRender(); } }, 2000); };
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).then(done, done); return; } } catch (e) {}
    var ta = document.createElement('textarea'); ta.value = txt; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {} ta.remove(); done();
  }

  function longDate(iso) { var d = new Date(iso); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }
  
  // Learn: lesson read. Plan: the worksheet is on course. Check: every checklist item done.

  // Group headings with progress, then each group's topics, for the menus.

  /* ---------- the lessons (from the PayStamp course) ---------- */

  /* ---------- checks ---------- */

  // Staged topics take their own part of the full checklist, plus a few of their own.

  /* ---------- Do: the working parts ---------- */

  /* ---------- a topic, opened as an overlay ---------- */

  /* ---------- v3.7: PayStamp Pro ----------
     Free: Monthly Planner, Investments, Savings, Debt, Records, Couples, the Overview and the Control topics.
     Pro (£1.99 a month): the rest of Compass, PayStamp Hustle, and later Penny (AI) and Moai.
     Founding members get Pro free for now. Live: the site sets window.PayStamp.isPro() from the account's Pro flag
     (kept up to date by Stripe through the stripe-webhook function), and window.PayStamp.startCheckout() opens Stripe's checkout. */
  var PRO_PRICE = '£1.99';
  
  function proTag() { return h('span', { class: 'pro-tag', text: 'Pro' }); }

  // v3.7: each topic is three numbered steps, the same as the Debt payoff plan
  
  // Debt and Savings have their own pages, so the topic points there instead of repeating them

  // v3.7: what used to be the Debt, Savings and Investments pages, kept whole, at the top of their topic.
   // v3.7: the lists live on the Debt, Savings and Investments pages again

  // **bold** in lesson text
  function richLine(t) { return String(t).split('**').map(function (part, i) { return i % 2 ? h('b', { text: part }) : part; }); }
  // **bold**, and lines starting "- " become a neat list.
  function rich(t) {
    var lines = String(t).split('\n'); if (lines.length === 1) return richLine(t);
    var out = [], ul = null;
    lines.forEach(function (ln) {
      if (/^- /.test(ln)) { if (!ul) { ul = h('ul', { class: 'cp-ul' }); out.push(ul); } ul.append(h('li', {}, richLine(ln.slice(2)))); }
      else { ul = null; out.push(h('span', { class: 'cp-ln' }, richLine(ln))); }
    });
    return out;
  }

  /* The lesson as short cards. Tap a card to read it: that ticks it off. Once every card is read the
     lesson folds away into one line, so the working part has the room. You can open it again any time. */
  var cpOpen = {}, cpKeepOpen = {};

  // v3.7: the first 4 cards; the rest wait behind "Show more", so each lesson is short

  // A short version of your checklist for the Compass overview, with a quick way to add to it.

  /* ---------- Compass › Notebook: your checklist, notes and monthly email ---------- */
  var EMAIL_OPTS = [
    ['topic', 'Your check-up topics', 'The Compass topics up for checking, with a few questions on each. Set how many in Check-ups below.'],
    ['reminders', 'Your reminders', 'Anything you asked to be reminded about, like a contract ending, the month before.'] ];
  // A small summary the monthly email is built from. Saved with your plan.
  function syncEmailDigest() {
    if (!state.groups) return;
    var pd = typeof nextPayDate === 'function' ? nextPayDate() : null;
    // v4.1: the emails only use your name, the payday date and your reminders
    var d = { name: userName() || '',
      payday: pd ? pd.getFullYear() + '-' + String(pd.getMonth() + 1).padStart(2, '0') + '-' + String(pd.getDate()).padStart(2, '0') : '',
      reminders: (function () { var R = state.costRemind || {}, mi = monthIndexNow(); return Object.keys(R).filter(function (k) { return R[k] && R[k].m <= mi + 1; }).sort(function (a, b) { return R[a].m - R[b].m; }).slice(0, 10).map(function (k) { return { name: R[k].name || 'Reminder', when: MONTHS[R[k].m % 12].slice(0, 3) + ' ' + Math.floor(R[k].m / 12) }; }); })() };
    if (JSON.stringify(d) !== JSON.stringify(state.emailDigest || null)) state.emailDigest = d;
  }
  // The payday email: one switch to turn it on, then optional extras. Older plans that ticked an extra count as on.
  function emailOn() { var E = state.emailPrefs || {}; return E.on != null ? !!E.on : EMAIL_OPTS.some(function (o) { return E[o[0]]; }); }
  
  function openFeedbackKind(kind) { if (!state.fbDraft) state.fbDraft = { kind: kind, message: '', contactOk: true }; else state.fbDraft.kind = kind; openFeedback('other'); }
  
  /* v3.7: the Overview: what you're worth now, where it's heading, and when each debt goes.
     Pensions linked to an investment aren't counted twice. Nothing here changes your plan. */
  // Growth for the forecast: the rate in your Invest calculator (8% unless you've changed it).
  function ovGrowth() { var r = amt((state.invCalc || {}).rate); return r > 0 ? Math.min(r, 20) : 8; }
  function worthNow() {
    var sv = (state.savings || []).reduce(function (t, x) { return t + Math.max(0, savedNow(x)) * entRate(savingItemId(x)); }, 0);
    var iv = (state.investments || []).reduce(function (t, x) { return t + invValue(x) * entRate(invItemId(x)); }, 0);
    var pn = (state.pensions || []).filter(function (x) { return !x.invId; }).reduce(function (t, x) { return t + amt(x.value); }, 0);
    var db = (state.debts || []).reduce(function (t, d) { return t + debtLeft(d) * entRate(debtItemId(d)); }, 0);
    return { savings: sv, invest: iv, pension: pn, debt: db, total: sv + iv + pn - db };
  }
  // Total debt left after n months, paying what your plan pays (same order and maths as the Debt topic).
  function debtAfter(n) {
    var all = state.debts || [], lt = all.filter(function (d) { return isLongTerm(d); });
    var cur = Math.max(0, (debtAuto() ? debtBudget() : debtsMonthlyTotal()) - lt.reduce(function (t, d) { return t + debtPayNow(d); }, 0));
    var list = orderedFor(state.debtOrder || 'custom').map(function (d) { var k = entRate(debtItemId(d)); return { bal: debtLeft(d) * k, r: amt(d.apr) / 1200, min: amt(d.min) * k }; });
    for (var m = 0; m < n; m++) {
      var lf = list.filter(function (x) { return x.bal > 0.005; }); if (!lf.length) break;
      var b = cur;
      lf.forEach(function (x) { x.bal += x.bal * x.r; });
      lf.forEach(function (x) { var p = Math.max(0, Math.min(x.bal, x.min, b)); x.bal -= p; b -= p; });
      lf.forEach(function (x) { if (b <= 0.005) return; var p = Math.min(x.bal, b); x.bal -= p; b -= p; });
    }
    var longTerm = lt.reduce(function (t, d) { return t + debtLeft(d) * entRate(debtItemId(d)); }, 0);
    return list.reduce(function (t, x) { return t + Math.max(0, x.bal); }, 0) + longTerm;
  }
  function worthAfter(n) {
    var sv = (state.savings || []).reduce(function (t, x) {
      var k = entRate(savingItemId(x)), v = Math.max(0, savedNow(x)), mo = amt(savingMonthly(x)), r = amt(x.aer) / 1200, g = amt(x.goal);
      for (var m = 0; m < n; m++) { v = v * (1 + r) + (g > 0 && v >= g ? 0 : mo); }
      return t + v * k;
    }, 0);
    var gr = ovGrowth() / 1200;
    var iv = (state.investments || []).reduce(function (t, x) {
      var k = entRate(invItemId(x)), v = invValue(x), mo = amt(invMonthly(x));
      for (var m = 0; m < n; m++) v = v * (1 + gr) + mo;
      return t + v * k;
    }, 0);
    var pn = (state.pensions || []).filter(function (x) { return !x.invId; }).reduce(function (t, x) { return t + amt(x.value) * Math.pow(1 + gr, n); }, 0);
    return sv + iv + pn - debtAfter(n);
  }
  function worthOverview() {
    var W = worthNow();
    var svMo = (state.savings || []).reduce(function (t, x) { return t + amt(savingMonthly(x)) * entRate(savingItemId(x)); }, 0);
    var ivMo = (state.investments || []).reduce(function (t, x) { return t + amt(invMonthly(x)) * entRate(invItemId(x)); }, 0);
    var tile = function (k, v, sub, go2, cls) {
      return h('button', { type: 'button', class: 'ov-tile' + (cls ? ' ' + cls : ''), onclick: function () { go(go2); } }, [h('small', { text: k }), h('b', { text: v }), h('span', { text: sub })]);
    };
    var kids = [];
    // v4.1: which way it's heading, over the next year
    var dir = (worthAfter(12) - W.total) / 12, up = dir >= 0;
    kids.push(goalHero('Overall worth', (W.total < 0 ? '−' : '') + money(Math.round(Math.abs(W.total))), 'Savings + investments' + (W.pension ? ' + pensions' : '') + ' − debts',
      Math.abs(dir) < 0.5 ? 'Holding steady' : (up ? '▲ Heading up' : '▼ Heading down'), Math.abs(dir) < 0.5 ? 'No change expected over the next year' : (up ? 'About +' : 'About −') + money(Math.round(Math.abs(dir))) + ' a month over the next year'));
    if (kids[0]) kids[0].classList.add(Math.abs(dir) < 0.5 ? 'dir-flat' : up ? 'dir-up' : 'dir-down');
    kids.push(h('div', { class: 'ov-tiles' }, [
      tile('Savings', money(Math.round(W.savings)), (state.savings || []).length + ((state.savings || []).length === 1 ? ' pot' : ' pots') + (svMo ? ' · ' + money(Math.round(svMo)) + ' a month' : ''), 'savings'),
      tile('Investments', money(Math.round(W.invest)), ivMo ? money(Math.round(ivMo)) + ' a month' : 'Nothing going in yet', 'investments'),
      W.pension ? tile('Pensions', money(Math.round(W.pension)), (state.pensions || []).filter(function (x) { return !x.invId; }).length + ' pensions', 'investments') : null,
      tile('Debt', money(Math.round(W.debt)), W.debt > 0.005 ? 'left to pay' : 'Nothing owed', 'debt', W.debt > 0.005 ? 'owe' : '') ]));
    // Debt-free date, and when each debt goes
    var ds = state.debts || [], act = activeDebts(), lt = ds.filter(function (d) { return isLongTerm(d) && debtLeft(d) > 0.005; });
    if (act.length) {
      var cur = Math.max(0, (debtAuto() ? debtBudget() : debtsMonthlyTotal()) - lt.reduce(function (t, d) { return t + debtPayNow(d); }, 0));
      var order = orderedFor(state.debtOrder || 'custom'), sim = simDebts(order, cur), mo = sim.ok && cur > 0 ? sim.months : null;
      var rows = order.map(function (d, i) { return { d: d, m: sim.cleared[i] }; }).filter(function (x) { return debtLeft(x.d) > 0.005; })
        .sort(function (a, b) { return (a.m == null ? 1e9 : a.m) - (b.m == null ? 1e9 : b.m); });
      var span = Math.max(1, mo || 1);
      kids.push(h('section', { class: 'ov-card' }, [
        h('div', { class: 'ov-card-h' }, [h('h4', { text: mo ? 'Debt-free by ' + freeDateLabel(mo) : 'No debt-free date yet' }),
          btn('cp-inline', 'Open Debt', function () { go('debt'); }, ['Debt ›'])]),
        h('small', { class: 'cp-sub', text: mo ? (mo === 1 ? '1 month' : mo + ' months') + ' to go at ' + money(Math.round(cur)) + ' a month' + (lt.length ? '. ' + lt.map(function (d) { return d.name || 'Debt'; }).join(' and ') + ' is long-term, so it isn’t counted here.' : '.') : cur > 0 ? 'Your payments don’t cover the interest yet.' : 'Set your monthly payments in the Debt topic to see your date.' }),
        h('div', { class: 'ov-debts' }, rows.map(function (x) {
          return h('div', { class: 'ov-debt' }, [
            h('span', { class: 'ov-dn' }, [h('b', { text: x.d.name || 'Debt' }), h('small', { text: money(Math.round(debtLeft(x.d))) + ' left' + (amt(x.d.apr) ? ' · ' + amt(x.d.apr) + '%' : '') })]),
            h('span', { class: 'ov-dbar', 'aria-hidden': 'true' }, [h('i', { style: 'width:' + (x.m ? Math.max(4, x.m / span * 100) : 100).toFixed(1) + '%', class: x.m ? '' : 'none' })]),
            h('span', { class: 'ov-dd', text: x.m ? freeDateLabel(x.m) : 'No date yet' }) ]);
        })) ]));
    }
    // Where it's heading: a line for each year over 10 years
    // v3.7: 10 years by default; switch to 20 or 30
    var Yrs = [10, 20, 30].indexOf(Number(state.ovYears)) > -1 ? Number(state.ovYears) : 10, MK = Yrs === 10 ? [0, 1, 5, 10] : Yrs === 20 ? [0, 5, 10, 20] : [0, 10, 20, 30];
    var pts = []; for (var y = 0; y <= Yrs; y++) pts.push({ y: y, v: y === 0 ? W.total : worthAfter(y * 12) });
    var lo = Math.min(0, Math.min.apply(null, pts.map(function (q) { return q.v; }))), hi = Math.max.apply(null, pts.map(function (q) { return q.v; }));
    var stepV = (function (r) { var m = Math.pow(10, Math.floor(Math.log10(Math.max(r, 1) / 4))), c = [1, 2, 2.5, 5, 10]; for (var i = 0; i < c.length; i++) if (r / (c[i] * m) <= 5) return c[i] * m; return 10 * m; })(hi - lo || 1);
    lo = Math.floor(lo / stepV) * stepV; hi = Math.ceil(hi / stepV) * stepV; if (hi === lo) hi = lo + stepV;
    var narrow = window.innerWidth <= 640, VW = narrow ? 340 : 640, VH = narrow ? 210 : 240, L = narrow ? 42 : 58, R = narrow ? 12 : 18, T = 26, B = 28;
    var X = function (yr) { return L + yr / Yrs * (VW - L - R); }, Y = function (v) { return T + (hi - v) / (hi - lo) * (VH - T - B); };
    var short = function (v) { var a = Math.abs(v), sgn = v < 0 ? '−' : ''; return sgn + (a >= 1e6 ? '£' + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'm' : a >= 1e3 ? '£' + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k' : '£' + Math.round(a)); };
    var svg = '<svg viewBox="0 0 ' + VW + ' ' + VH + '" class="ov-line" role="img" aria-label="Total worth over the next ' + Yrs + ' years: ' + pts.filter(function (q) { return MK.indexOf(q.y) > -1; }).map(function (q) { return (q.y ? 'in ' + q.y + (q.y === 1 ? ' year ' : ' years ') : 'now ') + money(Math.round(q.v)); }).join(', ') + '">';
    for (var g = lo; g <= hi + 0.001; g += stepV) svg += '<line x1="' + L + '" x2="' + (VW - R) + '" y1="' + Y(g).toFixed(1) + '" y2="' + Y(g).toFixed(1) + '" class="' + (Math.abs(g) < 0.001 ? 'zero' : 'grid') + '"/><text x="' + (L - 8) + '" y="' + (Y(g) + 4).toFixed(1) + '" text-anchor="end" class="ax">' + short(g) + '</text>';
    pts.filter(function (q) { var st = Yrs === 10 ? (narrow ? 2 : 1) : (narrow ? 10 : 5); return q.y % st === 0; }).map(function (q) { return q.y; }).forEach(function (yr) { svg += '<text x="' + X(yr).toFixed(1) + '" y="' + (VH - 8) + '" text-anchor="middle" class="ax">' + (yr === 0 ? 'Now' : yr + 'y') + '</text>'; });
    var line = pts.map(function (q, i) { return (i ? 'L' : 'M') + X(q.y).toFixed(1) + ' ' + Y(q.v).toFixed(1); }).join(' ');
    svg += '<path d="' + line + ' L' + X(Yrs).toFixed(1) + ' ' + Y(Math.max(lo, 0)).toFixed(1) + ' L' + X(0).toFixed(1) + ' ' + Y(Math.max(lo, 0)).toFixed(1) + ' Z" class="area"/>';
    svg += '<path d="' + line + '" class="ln"/>';
    pts.filter(function (q) { return MK.indexOf(q.y) > -1; }).forEach(function (q) {
      var x = X(q.y), yv = Y(q.v), anchor = q.y === 0 ? 'start' : q.y === Yrs ? 'end' : 'middle';
      svg += '<circle cx="' + x.toFixed(1) + '" cy="' + yv.toFixed(1) + '" r="5" class="' + (q.y === 0 ? 'pt now' : 'pt') + '"/>';
      svg += '<text x="' + (q.y === 0 ? x + 8 : q.y === Yrs ? x - 6 : x).toFixed(1) + '" y="' + (q.y === 0 && yv + 22 < VH - B - 6 ? yv + 22 : yv - 11).toFixed(1) + '" text-anchor="' + anchor + '" class="lbl">' + short(q.v) + '</text>';
    });
    svg += '</svg>';
    kids.push(h('section', { class: 'ov-card' }, [
      h('div', { class: 'ov-card-h' }, [h('h4', { text: 'Where your total worth is heading' }),
        h('div', { class: 'rt-seg ov-yrs', role: 'group', 'aria-label': 'How far ahead' }, [10, 20, 30].map(function (n) { return btn(n === Yrs ? 'on' : '', 'Show ' + n + ' years', function () { set({ ovYears: n }); }, [n + ' years'], { 'aria-pressed': String(n === Yrs) }); }))]),
      h('div', { class: 'ov-chart', html: svg }),
      h('div', { class: 'ov-fc' }, [{ label: 'Now', v: W.total }].concat(MK.slice(1).map(function (yr) { return { label: 'In ' + yr + (yr === 1 ? ' year' : ' years'), v: pts[yr].v }; })).map(function (x) {
        return h('div', { class: 'ov-fc-c' }, [h('small', { text: x.label }), h('b', { text: (x.v < 0 ? '−' : '') + money(Math.round(Math.abs(x.v))) })]);
      })),
      h('small', { class: 'cp-sub', text: 'A rough guide, not a promise. It keeps your plan as it is now: savings pots fill until they reach their goal, debts are paid as planned, and investments and pensions grow ' + ovGrowth() + '% a year, the rate in your Invest calculator. Real growth goes up and down.' }) ]));
    return h('div', { class: 'ov' }, kids);
  }
  // Getting started now lives on the planner, until it's done or you hide it.
  function startCard() { return null; } // v4.1: everyone builds their plan when they sign up
  
  // The dropdown under Compass in the plum bar (laptop).

  /* ---------- Shape PayStamp: the questions ---------- */
  var DQ = [
    { id: 'enjoying', q: 'Are you enjoying PayStamp?', type: 'yesno', opts: ['Yes!', 'Not yet'] },
    { id: 'allin', q: 'Do you do all your money planning on PayStamp?', type: 'yesno', opts: ['Yes, all of it', 'Not yet'] },
    { id: 'stopping', q: 'What’s stopping you from moving it all to PayStamp?', type: 'many', showIf: ['allin', 'Not yet'], opts: ['It’s missing something I need', 'I’m still learning how it works', 'Habit: I’m used to my old way', 'I’m not sure I trust it yet', 'I also use Excel or Google Sheets', 'I also use another app', 'Something else'], more: 'Tell us more (optional)' },
    { id: 'confusing', q: 'Is anything confusing or hard to find?', type: 'text', ph: 'e.g. I couldn’t work out how to…' },
    { id: 'add', q: 'What one thing should PayStamp add?', type: 'text', ph: 'Your idea…' } ];
  function directBody() {
    var D = state.direct || (state.direct = { answers: {} }), A = D.answers || (D.answers = {}), P = window.PayStamp || {};
    var setA = function (id, v) { A[id] = v; D.dirty = true; commit(); };
    var shown = DQ.filter(function (q) { return !q.showIf || A[q.showIf[0]] === q.showIf[1]; });
    var qs = shown.map(function (q, i) {
      var body;
      if (q.type === 'yesno') body = h('div', { class: 'dq-yn' }, q.opts.map(function (o, j) {
        var on = A[q.id] === o;
        return btn('dq-ynb' + (j === 0 ? ' yes' : '') + (on ? ' on' : ''), o, function () { setA(q.id, on ? '' : o); }, [o], { 'aria-pressed': String(on) });
      }));
      else if (q.type === 'one' || q.type === 'many') body = h('div', { class: 'dq-opts' }, q.opts.map(function (o) {
        var on = q.type === 'one' ? A[q.id] === o : (A[q.id] || []).indexOf(o) > -1;
        return btn('fb-chips-b' + (on ? ' on' : ''), o, function () {
          if (q.type === 'one') setA(q.id, on ? '' : o);
          else { var cur = (A[q.id] || []).slice(); if (on) cur = cur.filter(function (x) { return x !== o; }); else cur.push(o); setA(q.id, cur); }
        }, [o], { 'aria-pressed': String(on) });
      }));
      else if (q.type === 'scale') body = h('div', { class: 'dq-scale' }, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (n) {
        return btn('dq-n' + (A[q.id] === n ? ' on' : ''), String(n), function () { setA(q.id, A[q.id] === n ? null : n); }, [String(n)], { 'aria-pressed': String(A[q.id] === n) });
      }).concat([h('div', { class: 'dq-ends' }, [h('span', { text: 'Not likely' }), h('span', { text: 'Very likely' })])]));
      else { var ta = h('textarea', { class: 'fb-text dq-text', 'data-k': 'dq-' + q.id, placeholder: q.ph || '', 'aria-label': q.q }); ta.value = A[q.id] || ''; ta.addEventListener('change', function () { setA(q.id, ta.value.slice(0, 1000)); }); body = ta; }
      var more = null;
      if (q.more) { more = h('textarea', { class: 'fb-text dq-text sm', 'data-k': 'dq-' + q.id + '-more', placeholder: q.more, 'aria-label': q.more }); more.value = A[q.id + 'More'] || ''; more.addEventListener('change', function () { setA(q.id + 'More', more.value.slice(0, 1000)); }); }
      return h('section', { class: 'dq' + (q.showIf ? ' follow' : '') }, [h('h4', {}, [h('span', { class: 'cp-n', text: q.showIf ? '↳' : String(i + 1 - shown.slice(0, i).filter(function (x) { return x.showIf; }).length) }), q.q]), body, more]);
    });
    var answered = shown.filter(function (q) { var v = A[q.id]; return v != null && v !== '' && !(Array.isArray(v) && !v.length); }).length;
    var send = btn('fb-send', 'Send my answers', function () {
      document.activeElement && document.activeElement.blur && document.activeElement.blur();
      var payload = JSON.parse(JSON.stringify(A));
      var done = function () { D.sentAt = new Date().toISOString(); D.dirty = false; D.err = ''; commit(); showUndo('Thanks! Your answers have been sent.', null); };
      if (!P.saveAnswers) { done(); return; }
      send.disabled = true; send.textContent = 'Sending…';
      P.saveAnswers(payload).then(done, function (e) { D.err = 'They didn’t send (' + ((e && e.message) || 'connection problem') + '). Please try again.'; commit(); });
    }, [D.sentAt && !D.dirty ? 'Sent ✓' : D.sentAt ? 'Send updated answers' : 'Send my answers'], { disabled: answered ? null : true });
    var hero = h('div', { class: 'dq-hero' }, [h('span', { class: 'dq-clock', 'aria-hidden': 'true', text: '1' }), h('span', {}, [h('b', { text: '60 seconds. Real changes.' }), h('small', { text: 'Your answers decide what PayStamp builds next.' })])]);
    var hub = h('div', { class: 'dq-hub' }, [
      btn('cp-shape-b big', 'Report a bug', function () { openFeedbackKind('bug'); }, [h('b', { text: 'Report a bug' }), h('small', { text: 'Something not working? Tell us what happened.' })]),
      btn('cp-shape-b big', 'Suggest an idea', function () { openFeedbackKind('suggestion'); }, [h('b', { text: 'Suggest an idea' }), h('small', { text: 'Something to add, change or make easier.' })]) ]);
    return h('div', { class: 'f-body dq-body' }, [hub, h('h2', { class: 'sec-h', text: 'Quick questions' }), hero].concat(qs).concat([
      h('div', { class: 'fb-foot' }, [h('span', { class: 'fb-note', text: answered + ' of ' + shown.length + ' answered. Change your answers whenever you like and send them again. They’re only used to improve PayStamp.' }), send]),
      D.err ? h('p', { class: 'fb-err', text: D.err }) : null ]));
  }

  // Admin › Answers: the Shape PayStamp answers, added up. No names or emails are shown.
  function adminAnswers(D) {
    var rows = (D.answers || []).map(function (r) { return r.answers || {}; });
    if (!rows.length) return h('p', { class: 'f-hint', text: 'No answers yet. They appear here when people send them from More › Shape PayStamp.' });
    var view = state.adminAnsView || 'people';
    var vseg = h('div', { class: 'seg-o' }, [['people', 'Each person'], ['summary', 'Added up']].map(function (t) { return btn('', t[1], function () { set({ adminAnsView: t[0] }); }, [t[1]], { 'aria-pressed': String(view === t[0]) }); }));
    if (view === 'people') {
      var known = {}; DQ.forEach(function (q) { known[q.id] = q; });
      var show = function (v) { return Array.isArray(v) ? v.join(', ') : typeof v === 'number' ? v + ' out of 10' : String(v); };
      return h('div', { class: 'pa-list' }, [h('div', { class: 'pa-bar' }, [h('span', { class: 'f-hint', text: rows.length + (rows.length === 1 ? ' person has' : ' people have') + ' answered · newest first' }), vseg])].concat((D.answers || []).map(function (r) {
        var A = r.answers || {}, d = r.updated_at ? new Date(r.updated_at) : null, lines = [];
        DQ.forEach(function (q) { var v = A[q.id]; if (v == null || v === '' || (Array.isArray(v) && !v.length)) return; lines.push(h('div', { class: 'pa-qa' }, [h('small', { text: q.q }), h('b', { text: show(v) }), A[q.id + 'More'] ? h('p', { class: 'pa-msg pa-quote', text: A[q.id + 'More'] }) : null])); });
        Object.keys(A).forEach(function (k) { if (known[k] || /More$/.test(k) && known[k.slice(0, -4)]) return; var v = A[k]; if (v == null || v === '' || (Array.isArray(v) && !v.length)) return; lines.push(h('div', { class: 'pa-qa old' }, [h('small', { text: 'Older question: ' + k }), h('b', { text: show(v) })])); });
        return h('article', { class: 'pa-fb' }, [
          h('div', { class: 'pa-top' }, [h('b', { text: r.email || 'Account' }), d ? h('span', { text: d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getFullYear() }) : null, r.founder_number ? h('span', { text: 'Founder #' + r.founder_number }) : null]),
          lines.length ? h('div', { class: 'pa-qas' }, lines) : h('p', { class: 'f-hint', text: 'No answers filled in.' }) ]);
      })));
    }
    var out = [h('div', { class: 'pa-bar' }, [h('span', { class: 'f-hint', text: rows.length + (rows.length === 1 ? ' person has' : ' people have') + ' answered.' }), vseg])];
    DQ.forEach(function (q, i) {
      var box = h('section', { class: 'pa-fb' }, [h('div', { class: 'pa-top' }, [h('b', { text: (i + 1) + '. ' + q.q })])]);
      if (q.type === 'one' || q.type === 'many' || q.type === 'yesno') {
        var n = rows.filter(function (a) { var v = a[q.id]; return v && (!Array.isArray(v) || v.length); }).length;
        q.opts.forEach(function (o) {
          var c = rows.filter(function (a) { var v = a[q.id]; return Array.isArray(v) ? v.indexOf(o) > -1 : v === o; }).length, pc = n ? Math.round(c / n * 100) : 0;
          box.append(h('div', { class: 'pa-tally' }, [h('span', { text: o }), h('div', { class: 'cp-bar good' }, [h('i', { style: 'width:' + pc + '%' })]), h('b', { text: pc + '% (' + c + ')' })]));
        });
        if (q.more) rows.forEach(function (a) { if (a[q.id + 'More']) box.append(h('p', { class: 'pa-msg pa-quote', text: a[q.id + 'More'] })); });
      } else if (q.type === 'scale') {
        var v = rows.map(function (a) { return a[q.id]; }).filter(function (x) { return typeof x === 'number'; });
        if (v.length) {
          var pro = v.filter(function (x) { return x >= 9; }).length, det = v.filter(function (x) { return x <= 6; }).length;
          box.append(h('div', { class: 'pa-stats' }, [h('div', { class: 'pa-stat' }, [h('b', { text: (v.reduce(function (a, b) { return a + b; }, 0) / v.length).toFixed(1) }), h('small', { text: 'Average out of 10' })]),
            h('div', { class: 'pa-stat' }, [h('b', { text: String(Math.round((pro - det) / v.length * 100)) }), h('small', { text: 'Recommend score (−100 to 100)' })])]));
        } else box.append(h('p', { class: 'f-hint', text: 'No answers yet.' }));
      } else {
        var texts = rows.map(function (a) { return a[q.id]; }).filter(Boolean);
        if (!texts.length) box.append(h('p', { class: 'f-hint', text: 'No answers yet.' }));
        texts.forEach(function (t) { box.append(h('p', { class: 'pa-msg pa-quote', text: t })); });
      }
      out.push(box);
    });
    return h('div', { class: 'pa-list' }, out);
  }
  function recordsBody() {
    var recs = state.records.slice().sort(function (a, b) { return a.year !== b.year ? a.year - b.year : MONTHS.indexOf(a.month) - MONTHS.indexOf(b.month); });
    if (!recs.length) return h('div', {}, [h('div', { class: 'empty', text: 'No months stamped yet. Press Stamp at the bottom of your Monthly Planner once you’re happy with the numbers.' }),
      h('div', { class: 'btn-row', style: 'justify-content:center' }, [btn('pill-btn', 'Add last month by hand', function () { var i = monthIndexNow() - 1; recAddMonth(MONTHS[i % 12], Math.floor(i / 12)); }, ['+ Add last month by hand'])]), fbCard('records')]);
    return h('div', {}, [recordsTable(recs), fbCard('records')]);
  }

  function buildTour() {
    var i = state.introStep || 0, t = TOUR[i], last = i >= TOUR.length - 1;
    return h('div', { class: 'tour' + (t.id === 'tour-feedback' ? ' raised' : ''), role: 'dialog', 'aria-label': 'Intro tour' }, [
      btn('x', 'Close tour', function () { set({ introOpen: false }); }, ['✕']),
      h('div', { class: 'accent', style: 'background:' + t.accent }),
      h('h4', { text: t.title }), h('p', { text: matchMedia('(hover: none)').matches ? t.body.replace(/\bClick\b/g, 'Tap').replace(/\bclick\b/g, 'tap') : t.body }),
      h('div', { class: 'dots' }, TOUR.map(function (_, j) {
        var s = j === i ? 9 : 7;
        return btn('', 'Go to step ' + (j + 1), function () { tourGo(j); }, [], { style: 'width:' + s + 'px;height:' + s + 'px;background:' + (j === i ? '#7E2A55' : '#E2DDE4') });
      })),
      h('div', { class: 'foot-t' }, [
        i > 0 ? btn('ghost', 'Back', function () { tourGo(i - 1); }, ['Back']) : btn('ghost', 'Skip tour', function () { set({ introOpen: false }); }, ['Skip tour']),
        h('span', { class: 'step', text: (i + 1) + ' of ' + TOUR.length }),
        btn('next', last ? 'Get started' : 'Next', function () { if (last) set({ introOpen: false }); else tourGo(i + 1); }, [last ? 'Get started' : 'Next']) ]) ]);
  }

  /* ---------- debt (overlay) ----------
     debts: [{ id, name, balance, apr, min, monthly }], in the order the user sets.
     "In planner" = a planner item with id 'dbt_<debt id>' exists (Costs › Debt payments).
     Paid = what that item had budgeted in each stamped Record. Restamping a month replaces
     its Record, so a month can never be counted twice. */
  var DEBT_COLOR = '#7E2A55';
  function findDebt(id) { return (state.debts || []).find(function (d) { return d.id === id; }); }
  function debtItemId(d) { return 'dbt_' + d.id; }
  /* v4.3: dates on balances. When you type a balance (debt), what's saved (savings) or what it's worth (investments),
     PayStamp keeps the date. From then on: a month you stamp counts what you stamped; a month whose payday has
     passed but isn't stamped counts the planned monthly amount (if the line is in your planner), as an estimate. */
  function recIdx(r) { return Number(r.year) * 12 + MONTHS.indexOf(r.month); }
  function sinceAsOf(asOf, match, monthly, inPlan) {
    var at = new Date(asOf); if (isNaN(at)) return { amount: 0, est: 0, months: 0 };
    var now = new Date(), atIdx = at.getFullYear() * 12 + at.getMonth(), nowIdx = monthIndexNow(), npd = null;
    try { npd = nextPayDate(); } catch (e) {}
    var pd = npd ? npd.getDate() : 28, res = { amount: 0, est: 0, months: 0 };
    for (var m = atIdx; m <= nowIdx; m++) {
      var y = Math.floor(m / 12), mo = m % 12, payD = new Date(y, mo, Math.min(pd, new Date(y, mo + 1, 0).getDate()), 12);
      var rec = (state.records || []).find(function (r) { return recIdx(r) === m; });
      if (rec) {
        if (new Date(rec.stampedAt || 0) <= at) continue;            // stamped before the balance was typed: already in it
        var v = 0, hit = false; (rec.items || []).forEach(function (it) { if (match(it)) { v += recAmt(it); hit = true; } });
        if (hit) { res.amount += v; res.months++; }
        continue;
      }
      if (inPlan && amt(monthly) > 0 && payD > at && payD <= now) { res.amount += amt(monthly); res.est += amt(monthly); res.months++; }
    }
    return res;
  }
  function asOfLabel(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + String(d.getFullYear()).slice(2); }
  // A small "as of" date under a balance. Tap it to change the date.
  function asOfChip(key, iso, onSet, what) {
    if (state.asOfEdit === key) {
      var inp = h('input', { type: 'date', class: 'asof-in', 'data-k': 'asof-' + key, 'aria-label': 'The date ' + what + ' was this amount',
        onchange: function (e) { var v = e.target.value; if (!v) return; var d = new Date(v + 'T12:00:00'); if (d > new Date()) d = new Date(); state.asOfEdit = null; onSet(d.toISOString()); },
        onblur: function () { if (state.asOfEdit === key) { state.asOfEdit = null; scheduleRender(); } } });
      if (iso) { var d0 = new Date(iso); if (!isNaN(d0)) inp.value = d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0') + '-' + String(d0.getDate()).padStart(2, '0'); }
      setTimeout(function () { var n = document.querySelector('[data-k="asof-' + key + '"]'); if (n) { n.focus(); try { if (n.showPicker) n.showPicker(); } catch (er) {} } }, 0);
      return inp;
    }
    return h('button', { type: 'button', class: 'asof' + (iso ? '' : ' none'), title: iso ? 'The date this amount was right. Change it if you typed it on a different day.' : 'Add the date this amount was right, so PayStamp can keep it up to date',
      onclick: function () { state.asOfEdit = key; scheduleRender(); } }, [iso ? 'as of ' + asOfLabel(iso) : 'as of']);
  }
  function debtPaid(d) {
    if (d.asOf) { var sa = sinceAsOf(d.asOf, function (it) { return it.id === debtItemId(d) || it.debtId === d.id; }, Math.max(amt(debtMonthly(d)), amt(d.min)), !!findItem(debtItemId(d))); return { paid: sa.amount, months: sa.months, est: sa.est }; }
    var id = debtItemId(d), paid = 0, months = 0;
    state.records.forEach(function (r) {
      var hit = false;
      (r.items || []).forEach(function (it) { if (it.id === id || it.debtId === d.id) { paid += recAmt(it); hit = true; } });
      if (hit) months++;
    });
    return { paid: paid, months: months };
  }
  function debtCategory() {
    var g = findGroup('costs') || state.groups.filter(function (x) { return x.key !== 'income'; })[0];
    var c = g.categories.find(function (x) { return x.id === 'cat_debts'; });
    if (!c) { c = { id: 'cat_debts', name: 'Debt payments', items: [] }; g.categories.push(c); }
    return c;
  }
  function addDebtToPlanner(d) {
    if (findItem(debtItemId(d))) return;
    debtCategory().items.push({ id: debtItemId(d), label: d.name || 'Debt', target: d.monthly || '', budgeted: d.monthly || '', account: '', runs: '', due: '', automated: false, debtId: d.id });
  }
  function removeDebtFromPlanner(d) {
    var f = findItem(debtItemId(d)); if (!f) return;
    d.monthly = f.item.budgeted;
    f.c.items.splice(f.idx, 1);
    if (f.c.id === 'cat_debts' && !f.c.items.length) f.g.categories = f.g.categories.filter(function (c) { return c !== f.c; });
  }
  // When a debt is in the planner, its monthly payment IS the planner item's Budgeted amount.
  function debtMonthly(d) { return d.monthly; }
  /* Pay-off order. Snowball: smallest amount left first. Avalanche: highest APR first.
     Custom: the user's own order, which is remembered while another order is showing. */
  var DEBT_ORDERS = [
    { key: 'custom', label: 'Custom', note: 'Your own order. Drag the ⠿ grip to change it.' },
    { key: 'snowball', label: 'Snowball', note: 'Smallest amount left first, for quick wins.' },
    { key: 'avalanche', label: 'Avalanche', note: 'Highest APR first, to pay the least interest.' } ];
  function debtLeft(d) { return Math.max(0, amt(d.balance) - debtPaid(d).paid); }
  function sortDebts() {
    var mode = state.debtOrder || 'custom';
    if (mode === 'snowball') state.debts.sort(function (a, b) { return debtLeft(a) - debtLeft(b) || amt(b.apr) - amt(a.apr); });
    if (mode === 'avalanche') state.debts.sort(function (a, b) { return amt(b.apr) - amt(a.apr) || debtLeft(a) - debtLeft(b); });
  }
  function setDebtOrder(mode) {
    var cur = state.debtOrder || 'custom';
    if (mode === cur) return;
    if (cur === 'custom') state.debtCustomOrder = state.debts.map(function (d) { return d.id; });
    if (mode === 'custom' && state.debtCustomOrder) {
      var pos = {}; state.debtCustomOrder.forEach(function (id, i) { pos[id] = i; });
      state.debts.sort(function (a, b) { return (pos[a.id] == null ? 1e9 : pos[a.id]) - (pos[b.id] == null ? 1e9 : pos[b.id]); });
    }
    state.debtOrder = mode;
    sortDebts(); commit();
  }
  function debtMovedByHand() { state.debtOrder = 'custom'; state.debtCustomOrder = state.debts.map(function (d) { return d.id; }); }
  function orderPicker() {
    var mode = state.debtOrder || 'custom', cur = DEBT_ORDERS.find(function (o) { return o.key === mode; });
    return h('div', { class: 'order-pick' }, [
      h('span', { class: 'lbl', id: 'order-lbl', text: 'Order' }),
      h('div', { class: 'seg-o', role: 'group', 'aria-labelledby': 'order-lbl' }, DEBT_ORDERS.map(function (o) {
        return btn('', o.label + ' order', function () { setDebtOrder(o.key); }, [o.label], { 'aria-pressed': String(o.key === mode) });
      })),
      // All three notes share one grid cell, so the line is always as tall as the longest and nothing below moves.
      h('div', { class: 'order-notes', 'aria-live': 'polite' }, DEBT_ORDERS.map(function (o) { return h('span', { class: o.key === mode ? 'on' : null, 'aria-hidden': o.key === mode ? null : 'true', text: o.note }); })) ]);
  }
  function bar(p) { return h('div', { class: 'pbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(p)) }, [h('i', { style: 'width:' + p.toFixed(1) + '%' })]); }

  function debtBody() {
    sortDebts();
    var c = DEBT_COLOR;
    var card = h('section', { class: 'group debt-group flip-group', style: '--g:' + c + ';--gm:' + c + ';--gl:' + lighten(c, .86) + ';--gl2:' + lighten(c, .6) + ';--gb:' + lighten(c, .93) });
    var total = 0, paidAll = 0;
    state.debts.forEach(function (d) { var b = amt(d.balance), k = entRate(debtItemId(d)); total += b * k; paidAll += Math.min(debtPaid(d).paid, b) * k; });
    var pAll = total ? paidAll / total * 100 : 0;
    card.append(h('div', { class: 'group-head' }, [h('h2', { text: 'Debts' }), h('span', { class: 'share', text: money(total - paidAll) + ' left' })]));
    card.append(h('div', { class: 'debt-overall' }, [h('span', { text: 'Paid off' }), bar(pAll), h('span', { class: 'num', text: Math.round(pAll) + '% · ' + money(paidAll) + ' of ' + money(total) })]));
    card.append(h('div', { class: 'drow colhead' }, [
      h('span', { class: 'd-name', text: 'Debt' }), h('span', { class: 'd-bal', text: 'Balance' }), h('span', { class: 'd-apr', text: 'APR' }),
      h('span', { class: 'd-min', text: 'Minimum' }), h('span', { class: 'd-pay', text: 'Monthly payment' }) ]));
    var list = h('div', { class: 'item-list', 'data-drop-kind': 'debt', 'data-list-id': 'debts' }, [h('div', { class: 'empty-hint', text: 'No debts yet. Add one below.' })]);
    state.debts.forEach(function (d) { list.append(debtRow(d)); });
    card.append(list);
    card.append(h('div', { class: 'add-row' }, [btn('add-btn', 'Add a debt', function () {
      var id = uid('debt');
      state.debts.push({ id: id, name: '', balance: '', apr: '', min: '', monthly: '' });
      commit();
      var n = document.querySelector('[data-k="dname-' + id + '"]'); if (n) n.focus();
    }, ['+ Add debt'])]));
    card.append(h('div', { class: 'drow foot' }, [
      h('span', { class: 'd-name', text: 'Total' }),
      h('span', { class: 'd-bal', text: '£' + fmt(total) }),
      h('span', { class: 'd-min', text: '£' + fmt(state.debts.reduce(function (s, d) { return s + amt(d.min) * entRate(debtItemId(d)); }, 0)) }),
      h('span', { class: 'd-pay', text: '£' + fmt(state.debts.reduce(function (s, d) { return s + amt(debtMonthly(d)) * entRate(debtItemId(d)); }, 0)) }) ]));
    // Every debt is paid at least its minimum, even if its monthly payment isn't set yet.
    var curMonthly = debtAuto() ? debtBudget() : state.debts.reduce(function (s, d) { return s + (debtLeft(d) > 0.005 ? Math.max(amt(debtMonthly(d)), amt(d.min)) * entRate(debtItemId(d)) : 0); }, 0);
    var leftAll = state.debts.reduce(function (s, d) { return s + debtLeft(d) * entRate(debtItemId(d)); }, 0);
    var planSec = null;
    if (debtAuto() && leftAll > 0.005) {
      var sch = debtSchedule(debtBudget());
      planSec = h('section', { class: 'dsec' }, [
        h('div', { class: 'dsec-head' }, [h('h4', { text: 'Your payoff plan' }), h('p', { text: money(debtBudget()) + ' a month, ' + ((state.debtOrder || 'custom') === 'snowball' ? 'smallest first' : (state.debtOrder || 'custom') === 'avalanche' ? 'highest interest first' : 'in your own order') + '. Each debt gets its minimum, the rest goes to the top debt, and a cleared debt’s payment rolls onto the next.' })]),
        sch.ok ? planSteps(sch) : h('p', { class: 'cp-tip warn', text: 'At this amount the interest grows faster than you pay it off. Raise your monthly total.' }),
        sch.ok ? planTable(sch) : null ]);
    }
    return h('div', {}, [card, h('div', { class: 'debt-hint' }, debtAuto() ? [
      'Your ', h('b', { text: 'Monthly payments' }), ' are set by your total each month and update themselves after you stamp a month. They show in your Monthly Planner under Costs › Debt payments. Clear the total to set them by hand.' ] : [
      'Any debt with a ', h('b', { text: 'Monthly payment' }), ' shows in your Monthly Planner under Costs › Debt payments. When you stamp a month, what you budgeted for it there counts as paid. Restamping a month replaces it, so it’s never counted twice.' ]),
      payoffPlan(curMonthly, leftAll), whatIfSection(curMonthly, leftAll), fbCard('debt') ]);
  }

  function debtRow(d) {
    var row = h('div', { class: 'drow item-row', 'data-row-id': d.id });
    var grip = h('button', { type: 'button', class: 'handle d-h', 'data-grip': d.id, 'aria-label': 'Move ' + (d.name || 'debt') + ' (drag, or use arrow keys)', html: GRIP });
    grip.addEventListener('pointerdown', function (e) { startDrag(e, 'debt'); });
    grip.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return; e.preventDefault();
      var i = state.debts.indexOf(d), ni = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (ni < 0 || ni >= state.debts.length) return;
      moveInList(state.debts, d.id, ni); debtMovedByHand(); commit();
      var n = document.querySelector('[data-grip="' + d.id + '"]'); if (n) n.focus();
    });
    var nm = d.name || 'debt', linked = findItem(debtItemId(d));
    var num = function (key, prop, label, onSet, value) {
      return field(key + '-' + d.id, value !== undefined ? value : d[prop], function (v) { var old = d[prop]; d[prop] = v; if (onSet) onSet(old, v); commit(); }, { cls: 'cell num', ph: '0', num: true, money: !/APR|Interest/.test(label), label: label + ' for ' + nm });
    };
    var sw = h('button', { type: 'button', class: 'sw d-sw', role: 'switch', 'aria-checked': String(!!linked), 'aria-label': 'Show ' + nm + ' in the Monthly Planner',
      title: linked ? 'In your Monthly Planner (Costs › Debt payments)' : 'Add to your Monthly Planner',
      onclick: function () { if (findItem(debtItemId(d))) removeDebtFromPlanner(d); else addDebtToPlanner(d); commit(); } }, [h('i')]);
    row.append(grip,
      field('dname-' + d.id, d.name, function (v) { d.name = v; var f = findItem(debtItemId(d)); if (f) f.item.label = v || 'Debt'; commit(); }, { cls: 'cell d-name', ph: 'Debt name', label: 'Debt name' }),
      h('div', { class: 'd-bal has-asof' }, [num('dbal', 'balance', 'Balance', function () { d.asOf = new Date().toISOString(); }), amt(d.balance) ? asOfChip('d' + d.id, d.asOf, function (iso) { d.asOf = iso; commit(); }, 'this balance') : null]),
      h('div', { class: 'd-apr pct-wrap' }, [num('dapr', 'apr', 'APR'), '%']),
      h('div', { class: 'd-min' }, [num('dmin', 'min', 'Minimum payment')]),
      h('div', { class: 'd-pay' }, [num('dpay', 'monthly', 'Monthly payment', function (old, v) {
        debtManual();   // v4.3: typing a debt's own payment takes over from the monthly total
        var f = findItem(debtItemId(d)); if (!f) return;
        if (!f.item.target || f.item.target === f.item.budgeted) f.item.target = v;
        f.item.budgeted = v;
      }, debtMonthly(d))]),
      btn('rm d-rm', 'Remove ' + nm, function () { removeDebtFromPlanner(d); state.debts = state.debts.filter(function (x) { return x !== d; }); state.debtExtras = state.debtExtras.filter(function (x) { return x.debtId !== d.id; }); commit(); }, ['✕']));
    return fxRow(row, entCur(debtItemId(d)));
  }

  /* ---------- extra (one-off) debt payments ----------
     debtExtras: [{ id, debtId, amount, monthKey:'October 2026', inPlanner }]
     In planner: shown in Extras › Extra debt payments only while the planner is on that month,
     so it's stamped once with that month and never carries over. Out of the planner: counts as paid now. */
  function r2(n) { return Math.round(n * 100) / 100; }
  function findExtra(id) { return (state.debtExtras || []).find(function (x) { return x.id === id; }); }
  function plannerMonthKey() { return (state.month || MONTHS[new Date().getMonth()]) + ' ' + (state.year || String(new Date().getFullYear())); }
  function extraCategory() {
    var g = findGroup('extras') || state.groups.filter(function (x) { return x.key !== 'income'; }).slice(-1)[0];
    var c = g.categories.find(function (x) { return x.id === 'cat_debt_extras'; });
    if (!c) { c = { id: 'cat_debt_extras', name: 'Extra debt payments', items: [] }; g.categories.push(c); }
    return c;
  }
  function syncDebtExtras() {
    if (!state.debtExtras || !state.groups || !state.debts) return;
    var key = plannerMonthKey();
    var wanted = function (x) { return x && x.monthKey === key && findDebt(x.debtId); };
    state.groups.forEach(function (g) { g.categories.forEach(function (c) {
      c.items = c.items.filter(function (it) { return !it.extraId || wanted(findExtra(it.extraId)); });
    }); });
    state.debtExtras.forEach(function (x) {
      if (!wanted(x)) return;
      var d = findDebt(x.debtId), id = 'dbx_' + x.id, f = findItem(id), label = 'Extra · ' + (d.name || 'Debt');
      if (f) { f.item.label = label; f.item.budgeted = x.amount; f.item.target = x.amount; }
      else extraCategory().items.push({ id: id, label: label, target: x.amount, budgeted: x.amount, account: '', runs: '', due: '', automated: false, debtId: d.id, extraId: x.id });
    });
    state.groups.forEach(function (g) { g.categories = g.categories.filter(function (c) { return !(c.id === 'cat_debt_extras' && !c.items.length); }); });
  }

  /* ---------- debt-free date + what if ----------
     Each month: interest is added (APR / 12), every minimum is paid, and the rest of the money
     goes down the list in your chosen order, so a cleared debt's payment rolls onto the next. */
  function payoffSim(monthly) {
    var list = state.debts.map(function (d) { var k = entRate(debtItemId(d)); return { bal: debtLeft(d) * k, r: amt(d.apr) / 1200, min: amt(d.min) * k }; }).filter(function (x) { return x.bal > 0.005; });
    var res = { months: 0, interest: 0, ok: true };
    if (!list.length) return res;
    for (var m = 0; m < 600; m++) {
      var left = list.filter(function (x) { return x.bal > 0.005; });
      if (!left.length) break;
      var b = monthly;
      left.forEach(function (x) { var i = x.bal * x.r; x.bal += i; res.interest += i; });
      left.forEach(function (x) { var p = Math.max(0, Math.min(x.bal, x.min, b)); x.bal -= p; b -= p; });
      left.forEach(function (x) { if (b <= 0.005) return; var p = Math.min(x.bal, b); x.bal -= p; b -= p; });
      res.months = m + 1;
    }
    if (list.some(function (x) { return x.bal > 0.005; })) res.ok = false;
    return res;
  }
  /* The payoff plan. One monthly total (state.debtBudget). Each month: interest is added, every
     debt gets its minimum, and the rest goes down the list in your order. When a debt is cleared,
     the part of its payment it no longer needs goes to the next debt that same month, and from
     then on its whole payment rolls onto the next one. This month's split is copied to the planner. */
  function debtBudget() { return amt(state.debtBudget); }
  // v4.3: when you type one debt's payment (here or in the planner), each debt keeps the payment you've given it.
  function debtManual() { if (!debtAuto()) return; var was = state.debtBudget; state.debtBudget = ''; showUndo('Each debt now uses the monthly payment you type. Type a total on the Debt page to have PayStamp share it out again.', function () { state.debtBudget = was; commit(); }); }
  function debtAuto() { return debtBudget() > 0; }
  function debtSchedule(budget) {
    var list = state.debts.filter(function (d) { return debtLeft(d) > 0.005; }).map(function (d) { var k = entRate(debtItemId(d)); return { d: d, k: k, bal: debtLeft(d) * k, r: amt(d.apr) / 1200, min: amt(d.min) * k, cleared: null, last: 0, slot: 0 }; });
    var res = { list: list, months: [], interest: 0, ok: true, minTotal: list.reduce(function (t, x) { return t + x.min; }, 0) };
    for (var m = 0; m < 600 && list.some(function (x) { return x.bal > 0.005; }); m++) {
      var b = budget, pays = list.map(function () { return 0; }), before = list.map(function (x) { return x.bal; });
      list.forEach(function (x) { if (x.bal > 0.005) { var i = x.bal * x.r; x.bal += i; res.interest += i; } });
      list.forEach(function (x, k) { if (x.bal <= 0.005) return; var p = Math.max(0, Math.min(x.bal, x.min, b)); x.bal -= p; b -= p; pays[k] += p; });
      list.forEach(function (x, k) { if (b <= 0.005 || x.bal <= 0.005) return; var p = Math.min(x.bal, b); x.bal -= p; b -= p; pays[k] += p; });
      list.forEach(function (x, k) {
        if (before[k] > 0.005 && x.bal <= 0.005) { x.bal = 0; x.cleared = m; x.last = pays[k]; x.slot = m > 0 ? res.months[m - 1].pays[k] : pays[k]; }
      });
      res.months.push({ pays: pays, left: list.reduce(function (t, x) { return t + x.bal; }, 0), total: pays.reduce(function (t, v) { return t + v; }, 0) });
    }
    if (list.some(function (x) { return x.bal > 0.005; })) res.ok = false;
    return res;
  }
  function syncDebtPlan() {
    if (!state.debts || !state.groups || !debtAuto()) return;
    sortDebts();
    var sch = debtSchedule(debtBudget()), first = sch.months[0];
    state.debts.forEach(function (d) {
      var k = sch.list.findIndex(function (x) { return x.d === d; });
      if (k < 0) { if (findItem(debtItemId(d))) { removeDebtFromPlanner(d); } d.monthly = ''; return; }
      var pay = String(first ? r2(first.pays[k] / (sch.list[k].k || 1)) : 0); // back into the debt's own currency
      d.monthly = pay;
      if (!findItem(debtItemId(d))) addDebtToPlanner(d);
      var f = findItem(debtItemId(d));
      if (f.item.target !== pay) { if (!f.item.target || f.item.target === f.item.budgeted) f.item.budgeted = pay; f.item.target = pay; }
    });
  }
  // The plan as steps: one line per debt, in the order they're cleared.
  function planSteps(sch) {
    var order = sch.list.map(function (x, k) { return k; }).filter(function (k) { return sch.list[k].cleared != null; }).sort(function (a, b) { return sch.list[a].cleared - sch.list[b].cleared || a - b; });
    var items = order.map(function (k, i) {
      var x = sch.list[k], nextK = order.slice(i + 1).find(function (j) { return sch.list[j].cleared > x.cleared || (sch.list[j].cleared === x.cleared && j > k); });
      var nx = nextK != null ? sch.list[nextK] : null, spare = r2(x.slot - x.last), when = freeDateLabel(x.cleared + 1), after = freeDateLabel(x.cleared + 2);
      var line;
      if (!nx) line = ['Last payment ', h('b', { text: money(r2(x.last)) }), '. You’re debt-free!'];
      else if (x.cleared === 0 || spare <= 0.005) line = ['Last payment ', h('b', { text: money(r2(x.last)) }), '. From ' + after + ', its payment rolls onto ', h('b', { text: nx.d.name || 'the next debt' }), '.'];
      else line = ['Last payment ', h('b', { text: money(r2(x.last)) }), ', so the spare ', h('b', { text: money(spare) }), ' goes to ', h('b', { text: nx.d.name || 'the next debt' }), ' that month. From ' + after + ', its whole ', h('b', { text: money(r2(x.slot)) }), ' rolls on too.'];
      return h('li', {}, [h('span', { class: 'ps-n', text: String(i + 1) }), h('span', { class: 'ps-t' }, [h('span', { class: 'ps-h' }, [h('b', { text: x.d.name || 'Debt' }), h('span', { text: 'Paid off ' + when })]), h('small', {}, line)])]);
    });
    return h('ol', { class: 'plan-steps' }, items);
  }
  function planTable(sch) {
    var all = !!state.planAll, rows = all ? sch.months : sch.months.slice(0, 12);
    var head = h('tr', {}, [h('th', { text: 'Month' })].concat(sch.list.map(function (x) { return h('th', { text: x.d.name || 'Debt' }); }), [h('th', { text: 'Left after' })]));
    var body = rows.map(function (mo, m) {
      var ev = sch.list.some(function (x) { return x.cleared === m; });
      return h('tr', { class: ev ? 'ev' : null }, [h('td', { text: freeDateLabel(m + 1) })].concat(sch.list.map(function (x, k) {
        if (x.cleared != null && m > x.cleared) return h('td', { class: 'gone', text: '–' });
        return h('td', {}, [money(r2(mo.pays[k])), x.cleared === m ? h('span', { class: 'pt-done', text: ' ✓ paid off' }) : null]);
      }), [h('td', { class: 'left', text: money(Math.round(mo.left)) })]));
    });
    return h('div', { class: 'plan-table-wrap' }, [
      h('div', { class: 'plan-scroll' }, [h('table', { class: 'plan-table' }, [h('thead', {}, [head]), h('tbody', {}, body)])]),
      sch.months.length > 12 ? btn('pill-btn', all ? 'Show fewer months' : 'Show every month', function () { set({ planAll: !all }); }, [all ? 'Show the first 12 months' : 'Show all ' + sch.months.length + ' months']) : null ]);
  }
  function budgetField(id) {
    var mins = state.debts.reduce(function (t, d) { return t + (debtLeft(d) > 0.005 ? amt(d.min) : 0); }, 0), B = debtBudget();
    return h('div', { class: 'debt-budget' }, [
      h('label', { class: 'cp-field', for: 'f-' + id }, [h('span', { text: 'Total to pay off debt each month' }),
        field(id, state.debtBudget || '', function (v) { var n = amt(v); state.debtBudget = n > 0 ? String(n) : ''; if (!(n > 0)) state.debts.forEach(function (d) { var f = findItem(debtItemId(d)); if (f) d.monthly = f.item.target; }); commit(); }, { cls: 'cp-in', num: true, money: true, ph: 'e.g. ' + money(Math.ceil(mins / 10) * 10 + 100), label: 'Total to pay off debt each month' }) ]),
      h('small', { class: 'cp-sub' }, B > 0 ? (B + 0.005 < mins ? ['That’s less than your minimums (' + money(mins) + '). Raise it so every debt gets at least its minimum.'] : ['Minimums ' + money(mins) + ' · the other ', h('b', { text: money(r2(B - mins)) }), ' goes to the top debt. PayStamp sets each monthly payment, and your planner, for you.']) : ['Your minimums add up to ' + money(mins) + '. Set a total and PayStamp splits it for you, rolling each cleared debt’s payment onto the next.']) ]);
  }
  /* v3.4.2 Debt compass helpers. Long-term debts (a student loan, a mortgage) are shown but left out of
     the debt-free date and the status colour. d.longTerm overrides the name guess. */
  function isLongTerm(d) { return d.longTerm != null ? !!d.longTerm : /student|mortgage/i.test(d.name || ''); }
  function activeDebts() { return (state.debts || []).filter(function (d) { return !isLongTerm(d) && debtLeft(d) > 0.005; }); }
  function orderedFor(mode) {
    var list = activeDebts().slice();
    if (mode === 'snowball') list.sort(function (a, b) { return debtLeft(a) - debtLeft(b) || amt(b.apr) - amt(a.apr); });
    else if (mode === 'avalanche') list.sort(function (a, b) { return amt(b.apr) - amt(a.apr) || debtLeft(a) - debtLeft(b); });
    else if ((state.debtOrder || 'custom') !== 'custom' && state.debtCustomOrder) { var pos = {}; state.debtCustomOrder.forEach(function (id, i) { pos[id] = i; }); list.sort(function (a, b) { return (pos[a.id] == null ? 1e9 : pos[a.id]) - (pos[b.id] == null ? 1e9 : pos[b.id]); }); }
    return list;
  }
  function simDebts(debts, monthly) {
    var list = debts.map(function (d) { var k = entRate(debtItemId(d)); return { bal: debtLeft(d) * k, r: amt(d.apr) / 1200, min: amt(d.min) * k, done: debtLeft(d) > 0.005 ? null : 0 }; });
    var res = { months: 0, interest: 0, ok: true, cleared: list.map(function (x) { return x.done; }) };
    if (!list.some(function (x) { return x.bal > 0.005; })) return res;
    for (var m = 0; m < 600; m++) {
      var lf = list.filter(function (x) { return x.bal > 0.005; }); if (!lf.length) break;
      var b = monthly;
      lf.forEach(function (x) { var i = x.bal * x.r; x.bal += i; res.interest += i; });
      lf.forEach(function (x) { var p = Math.max(0, Math.min(x.bal, x.min, b)); x.bal -= p; b -= p; });
      lf.forEach(function (x) { if (b <= 0.005) return; var p = Math.min(x.bal, b); x.bal -= p; b -= p; });
      lf.forEach(function (x) { if (x.bal <= 0.005 && x.done == null) x.done = m + 1; });
      res.months = m + 1;
    }
    res.cleared = list.map(function (x) { return x.done; });
    if (list.some(function (x) { return x.bal > 0.005; })) res.ok = false;
    return res;
  }
  // What was owed (everyday debts) after each stamped month, oldest first, up to 6 months.
  function freeDateLabel(months) { var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + months - 1); return MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }
  function monthsText(n) { var y = Math.floor(n / 12), m = n % 12; return (y ? y + (y === 1 ? ' year' : ' years') : '') + (y && m ? ' ' : '') + (m || !y ? m + (m === 1 ? ' month' : ' months') : ''); }

  /* v3.7: Your payoff plan in three numbered steps: 1 the order, 2 how much a month, 3 the plan
     (debt-free card, a timeline of when each debt clears, then the details if you want them). */
  function payoffPlan(cur, left) {
    if (!state.debts.length) return null;
    var sim = payoffSim(cur), big, sub, ok = false;
    if (left <= 0.005) { big = 'Debt-free'; sub = 'Nothing left to pay. Well done.'; ok = true; }
    else if (cur <= 0) { big = 'No date yet'; sub = 'Set a monthly total in step 2, or a monthly payment on your debts.'; }
    else if (!sim.ok) { big = 'Not on track yet'; sub = 'At this amount the interest grows faster than you pay. Raise your total in step 2.'; }
    else { big = freeDateLabel(sim.months); ok = true; sub = monthsText(sim.months) + ' · ' + money(left) + ' left at ' + money(cur) + ' a month'; }
    var firstDebt = state.debts.find(function (d) { return debtLeft(d) > 0.005 && amt(debtMonthly(d)) > 0; });
    var sch = left > 0.005 && cur > 0 && sim.ok ? debtSchedule(cur) : null;
    var step = function (n, title, hint, kids) {
      return h('div', { class: 'pp-step' }, [h('span', { class: 'pp-n', text: String(n) }), h('div', { class: 'pp-sb' }, [h('h5', { text: title }), hint ? h('p', { class: 'pp-hint', text: hint }) : null].concat(kids))]);
    };
    var free = h('div', { class: 'pp-free' + (ok ? '' : ' warn') }, [
      h('span', { class: 'pp-ic', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4M16 2v4"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18M9 15l2 2 4-4"/></svg>' }),
      h('span', { class: 'pp-t' }, [h('small', { text: left <= 0.005 ? '' : 'Debt-free by' }), h('b', { text: big }), h('span', { text: sub })]),
      sch ? h('span', { class: 'pp-stat' }, [h('small', { text: 'Interest on the way' }), h('b', { text: money(Math.round(sch.interest)) })]) : null,
      firstDebt && left > 0.005 ? h('span', { class: 'pp-stat' }, [h('small', { text: 'Extra goes to' }), h('b', { text: firstDebt.name || 'Untitled' })]) : null ]);
    var plan = [free];
    if (sch) {
      plan.push(payoffTimeline(sch));
      plan.push(h('details', { class: 'pp-more' }, [h('summary', { text: 'How each payment rolls on' }), planSteps(sch)]));
      plan.push(h('details', { class: 'pp-more' }, [h('summary', { text: 'Month by month' }), planTable(sch)]));
    }
    return h('section', { class: 'dsec pp' }, [
      h('div', { class: 'dsec-head' }, [h('h4', { text: 'Your payoff plan' })]),
      step(1, 'Choose the order to pay them off', null, [orderPicker()]),
      step(2, 'How much can you pay towards debt each month?', null, [budgetField('debt-budget')]),
      step(3, 'Your plan', ok && left > 0.005 ? 'Each debt gets its minimum. Everything else goes to the debt at the top, and when one is cleared its payment rolls onto the next.' : null, plan) ]);
  }
  // A timeline: one bar per debt from now until it's cleared. Light while it gets its minimum, solid once the extra is on it.
  function payoffTimeline(sch) {
    var N = sch.months.length || 1;
    var rows = sch.list.map(function (x, k) { return { x: x, k: k }; }).filter(function (o) { return o.x.cleared != null; })
      .sort(function (a, b) { return a.x.cleared - b.x.cleared || a.k - b.k; });
    var startY = new Date().getFullYear(), m0 = new Date().getMonth(), ticks = [];
    for (var i = 0; i < N; i++) { var mm = (m0 + i) % 12; if (mm === 0) ticks.push({ i: i, y: startY + Math.floor((m0 + i) / 12) }); }
    return h('div', { class: 'pp-tl', role: 'list', 'aria-label': 'When each debt is paid off' }, rows.map(function (o, n) {
      var x = o.x, end = x.cleared + 1, focus = -1;
      for (var m = 0; m <= x.cleared; m++) { if (sch.months[m].pays[o.k] > x.min + 0.5) { focus = m; break; } }
      var pct = function (v) { return (v / N * 100).toFixed(2) + '%'; };
      return h('div', { class: 'pp-row', role: 'listitem' }, [
        h('span', { class: 'pp-rn' }, [h('i', { text: String(n + 1) }), h('span', {}, [h('b', { text: x.d.name || 'Debt' }), h('small', { text: money(Math.round(x.bal0 != null ? x.bal0 : debtLeft(x.d) * x.k)) + ' to clear' })])]),
        h('span', { class: 'pp-track' }, [
          h('span', { class: 'pp-bar min', style: 'width:' + pct(end) }),
          focus > -1 ? h('span', { class: 'pp-bar on', style: 'left:' + pct(focus) + ';width:' + pct(end - focus), title: 'Extra on ' + (x.d.name || 'this debt') + ' from ' + freeDateLabel(focus + 1) }) : null,
          h('span', { class: 'pp-end', style: 'left:' + pct(end) }, ['✓']) ]),
        h('span', { class: 'pp-when' }, [h('b', { text: (function (l) { var p = l.split(' '); return p[0].slice(0, 3) + ' ' + p[1]; })(freeDateLabel(end)) }), h('small', { text: monthsText(end) })]) ]);
    }).concat([h('div', { class: 'pp-axis' }, [h('span'), h('span', { class: 'pp-ticks' }, [h('span', { class: 'pp-tick', style: 'left:0', text: 'Now' })].concat(ticks.filter(function (t) { return t.i / N > (innerWidth <= 640 ? 0.2 : 0.08); }).map(function (t) { return h('span', { class: 'pp-tick', style: 'left:' + (t.i / N * 100).toFixed(2) + '%', text: 'Jan ' + t.y }); }))), h('span')]),
      h('div', { class: 'pp-key' }, [h('span', {}, [h('i', { class: 'min' }), 'Minimum only']), h('span', {}, [h('i', { class: 'on' }), 'Getting the extra'])]) ]));
  }

  /* What if Calculator (debt). Folded away until opened. Each line asks "if I paid £X a month to
     <all my debts | one debt>" and answers with how long it takes and the date. Several lines can be
     open at once to compare. Nothing here changes the plan. */
  function singleDebtSim(d, pay) {
    var bal = debtLeft(d), r = amt(d.apr) / 1200, res = { months: 0, interest: 0, ok: true };
    if (bal <= 0.005) return res;
    for (var m = 0; m < 600 && bal > 0.005; m++) {
      var i = bal * r; bal += i; res.interest += i;
      bal -= Math.min(bal, pay); res.months = m + 1;
    }
    if (bal > 0.005) res.ok = false;
    return res;
  }
  function debtPayNow(d) { return debtLeft(d) > 0.005 ? Math.max(amt(debtMonthly(d)), amt(d.min)) : 0; }
  function whatIfSection(cur, left) {
    var open = !!state.debtWifOpen;
    var head = h('button', { type: 'button', class: 'prev-toggle', 'aria-expanded': String(open), onclick: function () { set({ debtWifOpen: !open }); } }, [
      h('span', { class: 'pt-text' }, [h('h4', { text: 'What if Calculator' }), h('small', { text: 'See when you’d be debt-free if you paid a different amount, to one debt or all of them.' })]),
      h('span', { class: 'pt-arrow', 'aria-hidden': 'true', text: open ? '▾' : '▸' }) ]);
    if (!open) return h('section', { class: 'dsec prev' }, [head]);
    var owing = state.debts.filter(function (d) { return debtLeft(d) > 0.005; });
    if (!state.debtWifs || !state.debtWifs.length) state.debtWifs = [{ id: uid('dw'), debtId: 'all', amount: cur ? String(r2(cur)) : '' }];
    var body = h('div', { class: 'prev-body dwif-body' });
    if (left <= 0.005) {
      body.append(h('p', { class: 'prev-note', text: (state.debts || []).length ? 'You’re debt-free, so there’s nothing to work out. Well done.' : 'Add a debt above and this shows how paying a bit more gets you debt-free sooner.' }));
      return h('section', { class: 'dsec prev open' }, [head, body]);
    }
    state.debtWifs.forEach(function (W, idx) {
      if (W.debtId !== 'all' && !owing.some(function (d) { return d.id === W.debtId; })) W.debtId = 'all';
      var d = W.debtId === 'all' ? null : findDebt(W.debtId);
      var now = d ? debtPayNow(d) : cur;
      var sel = h('select', { class: 'dwif-sel', 'data-k': 'dwifsel-' + W.id, 'aria-label': 'Which debt', onchange: function (e) {
        W.debtId = e.target.value;
        var nd = W.debtId === 'all' ? null : findDebt(W.debtId);
        W.amount = String(r2(nd ? debtPayNow(nd) : cur)) ;
        commit();
      } }, [h('option', { value: 'all', text: 'all my debts' })].concat(owing.map(function (x) { return h('option', { value: x.id, text: x.name || 'Untitled debt' }); })));
      sel.value = W.debtId;
      var num = h('input', { type: 'text', inputmode: 'decimal', 'data-k': 'dwifamt-' + W.id, id: 'f-dwifamt-' + W.id, 'aria-label': 'Monthly amount in pounds' });
      num.value = W.amount || '';
      var vLead = h('span', { class: 'k' }), vDate = h('span', { class: 'date' }), vIn = h('span', { class: 'dwif-in' }), vCmp = h('span', { class: 'wif-cmp' });
      var show = function () {
        var v = amt(W.amount), sim = d ? singleDebtSim(d, v) : payoffSim(v), base = d ? singleDebtSim(d, now) : payoffSim(now);
        vLead.textContent = d ? (d.name || 'This debt') + ' would be paid off by' : 'You’d be debt-free by';
        vCmp.hidden = false; vIn.hidden = false;
        if (v <= 0 || !sim.ok) {
          vDate.textContent = 'Never'; vIn.hidden = true;
          vCmp.className = 'wif-cmp worse'; vCmp.textContent = v <= 0 ? 'Type an amount above' : 'That doesn’t cover the interest';
          return;
        }
        vDate.textContent = freeDateLabel(sim.months);
        vIn.textContent = 'in ' + monthsText(sim.months) + ' · ' + money(Math.round(sim.interest)) + ' interest';
        if (!base.ok || now <= 0) { vCmp.className = 'wif-cmp better'; vCmp.textContent = 'You’re not on track at the moment'; return; }
        var dm = base.months - sim.months, di = Math.round(base.interest - sim.interest);
        if (dm === 0) { vCmp.className = 'wif-cmp'; vCmp.textContent = 'Same as now'; return; }
        vCmp.className = 'wif-cmp ' + (dm > 0 ? 'better' : 'worse');
        vCmp.textContent = monthsText(Math.abs(dm)) + (dm > 0 ? ' sooner than now · saves ' + money(Math.max(0, di)) + ' interest' : ' later than now · ' + money(Math.max(0, -di)) + ' more interest');
      };
      num.addEventListener('input', function () { W.amount = num.value; show(); });
      num.addEventListener('keydown', function (e) { if (e.key === 'Enter') num.blur(); });
      show();
      var rm = state.debtWifs.length > 1 ? btn('rm dwif-rm', 'Remove this what if', function () { state.debtWifs = state.debtWifs.filter(function (x) { return x !== W; }); commit(); }, ['✕']) : null;
      body.append(h('div', { class: 'wif dwif' }, [
        h('div', { class: 'wif-ask' }, ['If I paid', h('label', { class: 'wif-in', for: 'f-dwifamt-' + W.id }, [h('span', { text: '£' }), num]), 'a month to', sel,
          h('span', { class: 'wif-now', text: 'Now ' + money(now) }), rm]),
        h('div', { class: 'wif-out' }, [vLead, vDate, vIn, vCmp]) ]));
    });
    body.append(h('div', { class: 'dwif-add' }, [btn('add-btn', 'Add another what if', function () {
      state.debtWifs.push({ id: uid('dw'), debtId: owing.length ? owing[0].id : 'all', amount: owing.length ? String(r2(debtPayNow(owing[0]))) : String(r2(cur)) });
      commit();
    }, ['+ Add another what if'])]));
    body.append(h('p', { class: 'wif-note', text: 'One debt on its own: only that debt and the amount you type, with its interest. All my debts: minimums first, then the rest down your list in your chosen order. Your plan won’t change.' }));
    return h('section', { class: 'dsec prev open' }, [head, body]);
  }

  /* =====================================================================
     SAVINGS (overlay) — same idea as Debt.
     "In planner" = a planner item 'sav_<id>' (Investments & Savings › Savings).
     Saved now = starting amount + what that item had budgeted in each stamped Record.
     savingExtras: one-off deposits, in Extras › Extra savings for their month only.
     ===================================================================== */
  var SAVE_COLOR = '#7E2A55';
  function findSaving(id) { return (state.savings || []).find(function (x) { return x.id === id; }); }
  function findSavingExtra(id) { return (state.savingExtras || []).find(function (x) { return x.id === id; }); }
  function savingItemId(sv) { return 'sav_' + sv.id; }
  function savedNow(sv) {
    if (sv.asOf) return amt(sv.saved) + sinceAsOf(sv.asOf, function (it) { return it.id === savingItemId(sv) || it.savingId === sv.id; }, sv.monthly, !!findItem(savingItemId(sv))).amount;
    var id = savingItemId(sv), total = amt(sv.saved);
    state.records.forEach(function (r) { (r.items || []).forEach(function (it) { if (it.id === id || it.savingId === sv.id) total += recAmt(it); }); });
    (state.savingUsed || []).forEach(function (u) { if (u.savingId === sv.id) total -= amt(u.amount); });
    return total;
  }
  function potLeft(sv) { return Math.max(0, amt(sv.goal) - savedNow(sv)); }
  function savingMonthly(sv) { return sv.monthly; }
  // Emergency fund and safety net pots live in their own planner group, "Safety funds".
  function syncSavingsLinks() {
    if (!state.groups || !state.savings) return;
    spendItems().forEach(function (x) {
      var it = x.it;
      if (it.savingId) {
        var sv = findSaving(it.savingId);
        if (!sv) state.savings.push({ id: it.savingId, name: it.label || 'Savings', goal: '', saved: '0', aer: '', monthly: it.budgeted || '' });
        else if (it.label && sv.name !== it.label) sv.name = it.label;
      } else if (/^cat_(savings|safety)$/.test(((findItem(it.id) || {}).c || {}).id || '') && !it.extraId && !it.saveExtraId) {
        var nsv = { id: uid('sv'), name: it.label || 'Savings', goal: '', saved: '0', aer: '', monthly: it.budgeted || '' };
        state.savings.push(nsv); it.savingId = nsv.id; it.id = savingItemId(nsv);
      }
    });
  }
  function isSafetyPot(sv) { return !!sv && (sv.id === state.efundStarter || sv.id === state.efundMain); }
  function syncSafetyCats() {
    if (!state.groups || !state.savings) return;
    var gs = findGroup('investSavings'); if (!gs) return;
    var goals = gs.categories.find(function (x) { return x.id === 'cat_savings'; });
    if (goals && goals.name === 'Savings') goals.name = 'Savings goals';
    state.savings.forEach(function (sv) {
      var f = findItem(savingItemId(sv)); if (!f || (f.c.id !== 'cat_savings' && f.c.id !== 'cat_safety')) return;
      var want = savingCategory(sv);
      if (want !== f.c) { f.c.items.splice(f.idx, 1); want.items.push(f.item); }
    });
    gs.categories = gs.categories.filter(function (c) { return !(c.id === 'cat_safety' && !c.items.length); });
  }
  function savingCategory(sv) {
    var g = findGroup('investSavings') || state.groups.filter(function (x) { return x.key !== 'income'; })[0];
    if (sv && isSafetyPot(sv)) {
      var sc = g.categories.find(function (x) { return x.id === 'cat_safety'; });
      if (!sc) { sc = { id: 'cat_safety', name: 'Safety funds', items: [] }; var at = g.categories.findIndex(function (x) { return x.id === 'cat_savings'; }); if (at < 0) g.categories.push(sc); else g.categories.splice(at, 0, sc); }
      return sc;
    }
    var c = g.categories.find(function (x) { return x.id === 'cat_savings'; });
    if (!c) { c = { id: 'cat_savings', name: 'Savings goals', items: [] }; g.categories.push(c); }
    return c;
  }
  function addSavingToPlanner(sv) {
    if (findItem(savingItemId(sv))) return;
    savingCategory(sv).items.push({ id: savingItemId(sv), label: sv.name || 'Savings', target: sv.monthly || '', budgeted: sv.monthly || '', account: '', runs: '', due: '', automated: false, savingId: sv.id });
  }
  function removeSavingFromPlanner(sv) {
    var f = findItem(savingItemId(sv)); if (!f) return;
    sv.monthly = f.item.budgeted;
    f.c.items.splice(f.idx, 1);
  }

  function savingMovedByHand() {}

  function savingsBody() {
    var c = SAVE_COLOR;
    var card = h('section', { class: 'group debt-group save-group flip-group', style: '--g:' + c + ';--gm:' + c + ';--gl:' + lighten(c, .86) + ';--gl2:' + lighten(c, .6) + ';--gb:' + lighten(c, .93) });
    var goalAll = 0, savedAll = 0;
    state.savings.forEach(function (sv) { var g = amt(sv.goal); goalAll += g; savedAll += g ? Math.min(savedNow(sv), g) : 0; });
    var pAll = goalAll ? savedAll / goalAll * 100 : 0;
    card.append(h('div', { class: 'group-head' }, [h('h2', { text: 'Savings' }), h('span', { class: 'share', text: money(Math.max(0, goalAll - savedAll)) + ' to go' })]));
    card.append(h('div', { class: 'debt-overall' }, [h('span', { text: 'Saved' }), bar(pAll), h('span', { class: 'num', text: Math.round(pAll) + '% · ' + money(savedAll) + ' of ' + money(goalAll) })]));
    card.append(h('div', { class: 'drow colhead' }, [
      h('span', { class: 'd-name', text: 'Savings' }), h('span', { class: 'd-bal', text: 'Goal' }), h('span', { class: 'd-apr', text: 'Saved' }),
      h('span', { class: 'd-min', text: 'Interest' }), h('span', { class: 'd-pay', text: 'Monthly saving' }) ]));
    var list = h('div', { class: 'item-list', 'data-drop-kind': 'saving', 'data-list-id': 'savings' }, [h('div', { class: 'empty-hint', text: 'No savings yet. Add one below.' })]);
    state.savings.forEach(function (sv) { list.append(savingRow(sv)); });
    card.append(list);
    card.append(h('div', { class: 'add-row' }, [btn('add-btn', 'Add savings', function () {
      var id = uid('sv');
      state.savings.push({ id: id, name: '', goal: '', saved: '', aer: '', monthly: '' });
      commit();
      var n = document.querySelector('[data-k="sname-' + id + '"]'); if (n) n.focus();
    }, ['+ Add savings'])]));
    card.append(h('div', { class: 'drow foot' }, [
      h('span', { class: 'd-name', text: 'Total' }),
      h('span', { class: 'd-bal', text: '£' + fmt(goalAll) }),
      h('span', { class: 'd-apr', text: '£' + fmt(state.savings.reduce(function (s2, sv) { return s2 + savedNow(sv); }, 0)) }),
      h('span', { class: 'd-pay', text: '£' + fmt(state.savings.reduce(function (s2, sv) { return s2 + amt(savingMonthly(sv)); }, 0)) }) ]));
    var cur = state.savings.reduce(function (s2, sv) { return s2 + (potLeft(sv) > 0.005 ? amt(savingMonthly(sv)) : 0); }, 0);
    var toGo = state.savings.reduce(function (s2, sv) { return s2 + potLeft(sv); }, 0);
    return h('div', {}, [card, h('div', { class: 'debt-hint' }, [
      'Anything with a ', h('b', { text: 'Monthly saving' }), ' shows in your Monthly Planner under Investments & Savings › Savings. ', h('b', { text: 'Saved' }), ' is what your stamped months in Records show, plus anything you saved before PayStamp, minus anything you’ve used. Restamping a month replaces it, so it’s never counted twice.' ]),
      efundSection(), saveWhatIf(cur), fbCard('savings') ]); // v4.1: type Saved in the table instead
  }

  function savingRow(sv) {
    var row = h('div', { class: 'drow item-row', 'data-row-id': sv.id });
    var grip = h('button', { type: 'button', class: 'handle d-h', 'data-grip': sv.id, 'aria-label': 'Move ' + (sv.name || 'savings') + ' (drag, or use arrow keys)', html: GRIP });
    grip.addEventListener('pointerdown', function (e) { startDrag(e, 'saving'); });
    grip.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return; e.preventDefault();
      var i = state.savings.indexOf(sv), ni = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (ni < 0 || ni >= state.savings.length) return;
      moveInList(state.savings, sv.id, ni); savingMovedByHand(); commit();
      var n = document.querySelector('[data-grip="' + sv.id + '"]'); if (n) n.focus();
    });
    var nm = sv.name || 'savings', linked = findItem(savingItemId(sv));
    var num = function (key, prop, label, onSet, value) {
      return field(key + '-' + sv.id, value !== undefined ? value : sv[prop], function (v) { var old = sv[prop]; sv[prop] = v; if (onSet) onSet(old, v); commit(); }, { cls: 'cell num', ph: '0', num: true, money: !/APR|Interest/.test(label), label: label + ' for ' + nm });
    };
    var sw = h('button', { type: 'button', class: 'sw d-sw', role: 'switch', 'aria-checked': String(!!linked), 'aria-label': 'Show ' + nm + ' in the Monthly Planner',
      title: linked ? 'In your Monthly Planner (Investments & Savings › Savings)' : 'Add to your Monthly Planner',
      onclick: function () { if (findItem(savingItemId(sv))) removeSavingFromPlanner(sv); else addSavingToPlanner(sv); commit(); } }, [h('i')]);
    row.append(grip,
      h('div', { class: 'd-name sf-wrap' }, [field('sname-' + sv.id, sv.name, function (v) { sv.name = v; var f = findItem(savingItemId(sv)); if (f) f.item.label = v || 'Savings'; commit(); }, { cls: 'cell', ph: 'e.g. Emergency fund', label: 'Savings name' }),
        isSafetyPot(sv) ? h('span', { class: 'sf-tag', title: 'Your emergency fund or safety net', text: 'Safety fund' }) : null]),
      h('div', { class: 'd-bal' }, [num('sgoal', 'goal', 'Goal')]),
      h('div', { class: 'd-apr has-asof' }, [field('ssaved-' + sv.id, savedNow(sv) ? String(r2(savedNow(sv))) : '', function (v) {
        // v4.1: type what's saved now; stamped months still add to it
        sv.saved = String(r2(amt(v))); sv.asOf = new Date().toISOString(); commit();   // v4.3: what's saved now, as of today
      }, { cls: 'cell num', ph: '0', num: true, money: true, label: 'Saved for ' + nm }), savedNow(sv) ? asOfChip('s' + sv.id, sv.asOf, function (iso) { sv.asOf = iso; commit(); }, 'what’s saved') : null]),
      h('div', { class: 'd-min pct-wrap' }, [num('saer', 'aer', 'Interest rate'), '%']),
      h('div', { class: 'd-pay' }, [num('spay', 'monthly', 'Monthly saving', function (old, v) {
        var f = findItem(savingItemId(sv)); if (!f) return;
        if (!f.item.target || f.item.target === f.item.budgeted) f.item.target = v;
        f.item.budgeted = v;
      }, savingMonthly(sv))]),
      btn('rm d-rm', 'Remove ' + nm, function () { removeSavingFromPlanner(sv); state.savings = state.savings.filter(function (x) { return x !== sv; }); state.savingExtras = state.savingExtras.filter(function (x) { return x.savingId !== sv.id; }); state.savingUsed = state.savingUsed.filter(function (x) { return x.savingId !== sv.id; }); commit(); }, ['✕']));
    return fxRow(row, entCur(savingItemId(sv)));
  }

  /* ---------- savings maths (used by the What if Calculator) ----------
     Interest is added monthly from the yearly rate (AER). Monthly amount needed for a goal:
       goal = S(1+r)^n + M((1+r)^n − 1)/r   →   M = (goal − S(1+r)^n) · r / ((1+r)^n − 1)
     and, the other way round, how many months a monthly amount takes to reach it. */
  function monthIndexNow() { var d = new Date(); return d.getFullYear() * 12 + d.getMonth(); }
  function byLabel(i) { return MONTHS[i % 12] + ' ' + Math.floor(i / 12); }
  function monthlyRate(sv) { var a = amt(sv.aer != null ? sv.aer : sv); return a > 0 ? Math.pow(1 + a / 100, 1 / 12) - 1 : 0; }
  function neededMonthly(goal, saved, r, n) {
    if (n <= 0) return null;
    if (!r) return (goal - saved) / n;
    var g = Math.pow(1 + r, n);
    return (goal - saved * g) * r / (g - 1);
  }
  function monthsToGoal(goal, saved, r, pay) {
    var bal = saved;
    for (var m = 0; m < 1200; m++) { if (bal >= goal - 0.005) return m; bal = bal * (1 + r) + pay; }
    return null;
  }
  function useMonthly(sv, v) {
    v = String(v); sv.monthly = v;
    var f = findItem(savingItemId(sv));
    if (f) { if (!f.item.target || f.item.target === f.item.budgeted) f.item.target = v; f.item.budgeted = v; }
  }

  /* one-off deposits → Extras › Extra savings (for that month only) */
  function savingExtraCategory() {
    var g = findGroup('extras') || state.groups.filter(function (x) { return x.key !== 'income'; }).slice(-1)[0];
    var c = g.categories.find(function (x) { return x.id === 'cat_save_extras'; });
    if (!c) { c = { id: 'cat_save_extras', name: 'Extra savings', items: [] }; g.categories.push(c); }
    return c;
  }
  function syncSavingExtras() {
    if (!state.savingExtras || !state.groups || !state.savings) return;
    var key = plannerMonthKey();
    var wanted = function (x) { return x && x.monthKey === key && findSaving(x.savingId); };
    state.groups.forEach(function (g) { g.categories.forEach(function (c) {
      c.items = c.items.filter(function (it) { return !it.saveExtraId || wanted(findSavingExtra(it.saveExtraId)); });
    }); });
    state.savingExtras.forEach(function (x) {
      if (!wanted(x)) return;
      var sv = findSaving(x.savingId), id = 'svx_' + x.id, f = findItem(id), label = 'Extra · ' + (sv.name || 'Savings');
      if (f) { f.item.label = label; f.item.budgeted = x.amount; f.item.target = x.amount; }
      else savingExtraCategory().items.push({ id: id, label: label, target: x.amount, budgeted: x.amount, account: '', runs: '', due: '', automated: false, savingId: sv.id, saveExtraId: x.id });
    });
    state.groups.forEach(function (g) { g.categories = g.categories.filter(function (c) { return !(c.id === 'cat_save_extras' && !c.items.length); }); });
  }

  /* Money taken out of savings (minimisable). Each entry comes off that savings' Saved amount. */

  /* Savings made before using PayStamp (minimisable). sv.saved holds this amount. */

  /* =====================================================================
     INVESTMENTS (overlay) — same idea as Savings.
     Invested = before PayStamp + stamped months (planner item 'inv_<id>') − sold/withdrawn.
     Current value = last value typed in + anything invested since it was typed in.
     ===================================================================== */
  var INV_COLOR = '#7E2A55';
  function findInvestment(id) { return (state.investments || []).find(function (x) { return x.id === id; }); }
  function findInvestExtra(id) { return (state.investExtras || []).find(function (x) { return x.id === id; }); }
  function invItemId(iv) { return 'inv_' + iv.id; }
  function invStamped(iv) {
    var id = invItemId(iv), t = 0;
    state.records.forEach(function (r) { (r.items || []).forEach(function (it) { if (it.id === id || it.investmentId === iv.id) t += recAmt(it); }); });
    return t;
  }
  function invOut(iv) { return (state.investUsed || []).reduce(function (t, u) { return t + (u.investmentId === iv.id ? amt(u.amount) : 0); }, 0); }
  function invested(iv) {
    if (iv.inAsOf) return amt(iv.before) + sinceAsOf(iv.inAsOf, function (it) { return it.id === invItemId(iv) || it.investmentId === iv.id; }, iv.monthly, !!findItem(invItemId(iv))).amount;   // v4.3: put in, as of a date
    return amt(iv.before) + invStamped(iv) - invOut(iv);
  }
  function invValue(iv) {
    if (iv.value === '' || iv.value == null) return invested(iv);
    if (iv.asOf) return amt(iv.value) + sinceAsOf(iv.asOf, function (it) { return it.id === invItemId(iv) || it.investmentId === iv.id; }, iv.monthly, !!findItem(invItemId(iv))).amount;
    return amt(iv.value) + (invested(iv) - amt(iv.valueBase));
  }
  function invMonthly(iv) { return iv.monthly; }
  function invCategory() {
    var g = findGroup('investSavings') || state.groups.filter(function (x) { return x.key !== 'income'; })[0];
    var c = g.categories.find(function (x) { return x.id === 'cat_invest'; });
    if (!c) { c = { id: 'cat_invest', name: 'Investments', items: [] }; g.categories.unshift(c); }
    return c;
  }
  function addInvToPlanner(iv) {
    if (findItem(invItemId(iv))) return;
    invCategory().items.push({ id: invItemId(iv), label: iv.name || 'Investment', target: iv.monthly || '', budgeted: iv.monthly || '', account: '', runs: '', due: '', automated: false, investmentId: iv.id });
  }
  function removeInvFromPlanner(iv) {
    var f = findItem(invItemId(iv)); if (!f) return;
    iv.monthly = f.item.budgeted;
    f.c.items.splice(f.idx, 1);
  }
  function gainEl(cls, gain, base) {
    var p = base > 0 ? gain / base * 100 : 0, up = gain >= 0;
    return h('span', { class: cls + ' gain ' + (Math.abs(gain) < 0.5 ? '' : up ? 'up' : 'down') }, [(up ? '+' : '−') + money(Math.abs(gain)), h('small', { text: (up ? '+' : '−') + Math.abs(p).toFixed(1) + '%' })]);
  }

  // When Worth now was last typed in, and the cash added since (no growth is estimated).
  function worthTip(iv) {
    if (!iv.checkedAt) return 'Not checked yet. Type in what your provider shows.';
    var d = new Date(iv.checkedAt), added = invested(iv) - amt(iv.valueBase);
    var stale = Date.now() - iv.checkedAt > 45 * 864e5;
    return (stale ? 'Time to update · ' : '') + 'Checked ' + d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getFullYear() + (Math.abs(added) >= 0.5 ? ' · ' + money(Math.round(added)) + ' added since' : '');
  }
  function staleDot(iv) {
    return iv.checkedAt && Date.now() - iv.checkedAt > 45 * 864e5 ? h('span', { class: 'stale-dot', 'aria-label': 'Worth now needs updating' }) : null;
  }
  function investmentsBody() {
    var c = INV_COLOR;
    var card = h('section', { class: 'group debt-group inv-group flip-group', style: '--g:' + c + ';--gm:' + c + ';--gl:' + lighten(c, .86) + ';--gl2:' + lighten(c, .6) + ';--gb:' + lighten(c, .93) });
    var inAll = 0, valAll = 0;
    state.investments.forEach(function (iv) { inAll += invested(iv); valAll += invValue(iv); });
    var gAll = valAll - inAll, up = gAll >= 0;
    card.append(h('div', { class: 'group-head' }, [h('h2', { text: 'Investments' }), h('span', { class: 'share', text: money(valAll) + ' worth' })]));
    card.append(h('div', { class: 'inv-sum' }, [
      h('span', {}, ['Put in ', h('b', { text: money(inAll) })]),
      h('span', {}, ['Worth now ', h('b', { text: money(valAll) })]),
      h('span', {}, ['Growth ', h('b', { class: Math.abs(gAll) < 0.5 ? '' : up ? 'up' : 'down', text: (up ? '+' : '−') + money(Math.abs(gAll)) + (inAll > 0 ? ' (' + (up ? '+' : '−') + Math.abs(gAll / inAll * 100).toFixed(1) + '%)' : '') })]) ]));
    card.append(h('div', { class: 'drow colhead' }, [
      h('span', { class: 'd-name', text: 'Investment' }), h('span', { class: 'd-bal', text: 'Put in' }), h('span', { class: 'd-apr', text: 'Worth now' }),
      h('span', { class: 'd-min', text: 'Growth' }), h('span', { class: 'd-pay', text: 'Monthly' }) ]));
    var list = h('div', { class: 'item-list', 'data-drop-kind': 'investment', 'data-list-id': 'investments' }, [h('div', { class: 'empty-hint', text: 'No investments yet. Add one below.' })]);
    state.investments.forEach(function (iv) { list.append(invRow(iv)); });
    card.append(list);
    card.append(h('div', { class: 'add-row' }, [btn('add-btn', 'Add an investment', function () {
      var id = uid('iv');
      state.investments.push({ id: id, name: '', before: '', value: '', valueBase: '0', monthly: '' });
      commit();
      var n = document.querySelector('[data-k="iname-' + id + '"]'); if (n) n.focus();
    }, ['+ Add investment'])]));
    card.append(h('div', { class: 'drow foot' }, [
      h('span', { class: 'd-name', text: 'Total' }),
      h('span', { class: 'd-bal', text: '£' + fmt(inAll) }),
      h('span', { class: 'd-apr', text: '£' + fmt(valAll) }),
      h('span', { class: 'd-min', text: (up ? '+£' : '−£') + fmt(Math.abs(gAll)) }),
      h('span', { class: 'd-pay', text: '£' + fmt(state.investments.reduce(function (t, iv) { return t + amt(invMonthly(iv)); }, 0)) }) ]));
    return h('div', {}, [card, h('div', { class: 'debt-hint' }, [
      h('b', { text: 'Put in' }), ' is what your stamped months in Records show, plus anything invested before PayStamp, minus anything sold or withdrawn. Type ', h('b', { text: 'Worth now' }), ' from your provider’s app whenever you check it; money you put in afterwards is added on top. Anything with a ', h('b', { text: 'Monthly' }), ' amount shows in your Monthly Planner under Investments & Savings › Investments.' ]),
      invWhatIf(), fbCard('investments') ]); // v4.1: before PayStamp and sold/withdrawn removed; type Put in in the table
  }

  function invRow(iv) {
    var row = h('div', { class: 'drow item-row', 'data-row-id': iv.id });
    var grip = h('button', { type: 'button', class: 'handle d-h', 'data-grip': iv.id, 'aria-label': 'Move ' + (iv.name || 'investment') + ' (drag, or use arrow keys)', html: GRIP });
    grip.addEventListener('pointerdown', function (e) { startDrag(e, 'investment'); });
    grip.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return; e.preventDefault();
      var i = state.investments.indexOf(iv), ni = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (ni < 0 || ni >= state.investments.length) return;
      moveInList(state.investments, iv.id, ni); commit();
      var n = document.querySelector('[data-grip="' + iv.id + '"]'); if (n) n.focus();
    });
    var nm = iv.name || 'investment', linked = findItem(invItemId(iv)), inv = invested(iv), val = invValue(iv);
    var sw = h('button', { type: 'button', class: 'sw d-sw', role: 'switch', 'aria-checked': String(!!linked), 'aria-label': 'Show ' + nm + ' in the Monthly Planner',
      title: linked ? 'In your Monthly Planner (Investments & Savings › Investments)' : 'Add to your Monthly Planner',
      onclick: function () { if (findItem(invItemId(iv))) removeInvFromPlanner(iv); else addInvToPlanner(iv); commit(); } }, [h('i')]);
    var out = invOut(iv);
    row.append(grip,
      h('div', { class: 'd-name name-wrap' }, [
        field('iname-' + iv.id, iv.name, function (v) { iv.name = v; var f = findItem(invItemId(iv)); if (f) f.item.label = v || 'Investment'; commit(); }, { cls: 'cell', ph: 'e.g. Stocks & Shares ISA', label: 'Investment name' }),
        h('button', { type: 'button', class: 'isa-mark', 'aria-pressed': String(!!iv.isa), title: iv.isa ? 'Marked as a Stocks & Shares ISA' : 'Mark as a Stocks & Shares ISA',
          onclick: function () { iv.isa = !iv.isa; commit(); } }, [iv.isa ? '✓ S&S ISA' : '+ S&S ISA']) ]),
      h('div', { class: 'd-bal has-asof' }, [field('iin-' + iv.id, inv ? String(r2(inv)) : '', function (v) {
        // v4.1: type what you've put in; stamped months still add to it. Worth now doesn't move.
        var was = invested(iv);
        iv.before = String(r2(amt(v))); iv.inAsOf = new Date().toISOString();   // v4.3: what you've put in, as of today
        iv.valueBase = String(amt(iv.valueBase) + invested(iv) - was); commit();
      }, { cls: 'cell num', ph: '0', num: true, money: true, label: 'Put in for ' + nm }), inv ? asOfChip('ii' + iv.id, iv.inAsOf, function (iso) { var was = invested(iv); iv.inAsOf = iso; iv.valueBase = String(amt(iv.valueBase) + invested(iv) - was); commit(); }, 'what you’d put in') : null]),
      h('div', { class: 'd-apr worth-cell has-asof', 'data-tip': worthTip(iv) }, [field('ival-' + iv.id, iv.value === '' ? '' : String(r2(val)), function (v) { iv.value = v; iv.valueBase = String(invested(iv)); iv.checkedAt = Date.now(); iv.asOf = new Date().toISOString(); commit(); }, { cls: 'cell num', ph: moneyShow(inv), num: true, money: true, label: 'Worth now for ' + nm }), staleDot(iv), iv.value !== '' && iv.value != null ? asOfChip('i' + iv.id, iv.asOf || (iv.checkedAt ? new Date(iv.checkedAt).toISOString() : ''), function (iso) { iv.asOf = iso; iv.checkedAt = new Date(iso).getTime(); commit(); }, 'its worth') : null]),
      gainEl('d-min', val - inv, inv),
      h('div', { class: 'd-pay' }, [field('ipay-' + iv.id, invMonthly(iv), function (v) {
        iv.monthly = v; var f = findItem(invItemId(iv));
        if (f) { if (!f.item.target || f.item.target === f.item.budgeted) f.item.target = v; f.item.budgeted = v; }
        commit();
      }, { cls: 'cell num', ph: '0', num: true, money: true, label: 'Monthly for ' + nm })]),
      btn('rm d-rm', 'Remove ' + nm, function () {
        removeInvFromPlanner(iv);
        state.investments = state.investments.filter(function (x) { return x !== iv; });
        state.investExtras = state.investExtras.filter(function (x) { return x.investmentId !== iv.id; });
        state.investUsed = state.investUsed.filter(function (x) { return x.investmentId !== iv.id; });
        commit();
      }, ['✕']));
    return fxRow(row, entCur(invItemId(iv)));
  }

  /* one-off investments → Extras › Extra investments (for that month only) */
  function invExtraCategory() {
    var g = findGroup('extras') || state.groups.filter(function (x) { return x.key !== 'income'; }).slice(-1)[0];
    var c = g.categories.find(function (x) { return x.id === 'cat_inv_extras'; });
    if (!c) { c = { id: 'cat_inv_extras', name: 'Extra investments', items: [] }; g.categories.push(c); }
    return c;
  }
  function syncInvestExtras() {
    if (!state.investExtras || !state.groups || !state.investments) return;
    var key = plannerMonthKey();
    var wanted = function (x) { return x && x.monthKey === key && findInvestment(x.investmentId); };
    state.groups.forEach(function (g) { g.categories.forEach(function (c) {
      c.items = c.items.filter(function (it) { return !it.investExtraId || wanted(findInvestExtra(it.investExtraId)); });
    }); });
    state.investExtras.forEach(function (x) {
      if (!wanted(x)) return;
      var iv = findInvestment(x.investmentId), id = 'ivx_' + x.id, f = findItem(id), label = 'Extra · ' + (iv.name || 'Investment');
      if (f) { f.item.label = label; f.item.budgeted = x.amount; f.item.target = x.amount; }
      else invExtraCategory().items.push({ id: id, label: label, target: x.amount, budgeted: x.amount, account: '', runs: '', due: '', automated: false, investmentId: iv.id, investExtraId: x.id });
    });
    state.groups.forEach(function (g) { g.categories = g.categories.filter(function (c) { return !(c.id === 'cat_inv_extras' && !c.items.length); }); });
  }

  /* ---------- planner links ----------
     Giving a debt, savings or investment a Monthly amount adds a line to the planner. The line stays
     (even at £0) until its ✕ is pressed in the planner, which clears the Monthly amount. */
  function linkedEntity(it) {
    if (it.extraId || it.saveExtraId || it.investExtraId) return null;
    return it.debtId ? findDebt(it.debtId) : it.savingId ? findSaving(it.savingId) : it.investmentId ? findInvestment(it.investmentId) : null;
  }
  function syncLinkedItems() {
    if (!state.groups) return;
    [[state.debts, debtItemId, addDebtToPlanner], [state.savings, savingItemId, addSavingToPlanner], [state.investments, invItemId, addInvToPlanner]].forEach(function (k) {
      (k[0] || []).forEach(function (e) {
        var f = findItem(k[1](e)), m = e.monthly || '';
        if (f) { var it = f.item; if (it.syncM === undefined) it.syncM = m; if (it.syncM !== m) { autoOff(it, it.target, m); if (amt(it.budgeted) === amt(it.target)) it.budgeted = m; it.target = m; it.syncM = m; } }
        else if (amt(m) > 0) k[2](e);
      });
    });
  }

  /* ---------- v3.7: the Couples planner ----------
     state.couple = { code, status: 'none'|'connected', partner: { name, pay }, split: 'equal'|'income'|'custom', customPct, lines: [{ id, name, cat, total, mode }] }
     mode: 'usual' (the usual split), 'equal', 'income', 'me', 'them'. Your share of every line goes into your own planner
     (Costs › Shared with …, or Investments & Savings for a saving category). Either of you can change any line.
     Live: the shared lines sit in one shared record both accounts can edit (needs the database part, see the release notes).
     The preview connects to an example partner. */
  function C() { return state.couple || (state.couple = { code: '', status: 'none', partner: null, split: 'equal', customPct: 50, lines: [] }); }
  function coupleOn() { return !!(state.couple && state.couple.status === 'connected'); }
  function coupleName() { return (state.couple && state.couple.partner && state.couple.partner.name) || 'your partner'; }
  function cpMyPay() { var g = findGroup('income'); return g ? (groupSum(g, 'target') || groupSum(g, 'budgeted')) : 0; }
  function cpIncomePct() { var a = cpMyPay(), b = amt((C().partner || {}).pay); return a + b > 0 ? a / (a + b) : 0.5; }
  function cpUsualPct() { var c = C(); return c.split === 'equal' ? 0.5 : c.split === 'custom' ? Math.max(0, Math.min(100, amt(c.customPct))) / 100 : cpIncomePct(); }
  function cpMyPct(l) { return l.mode === 'me' ? 1 : l.mode === 'them' ? 0 : l.mode === 'equal' ? 0.5 : l.mode === 'income' ? cpIncomePct() : cpUsualPct(); }
  // v4.1: no split settings. Each line has a total and what you put in; your partner puts in the rest.
  //   l.mode 'amt' + l.me = your amount. Lines without it still use their old split until someone changes them.
  var CP_GROUPS = [['investSavings', 'Savings & Investments', '#1E6B47'], ['costs', 'Costs', '#9A3A30'], ['guiltFree', 'Fun', '#245F8C']];
  function cpGroupOf(cat) { var m = (C().catGroups || {})[cat]; return m || (cpIsSaving(cat) ? 'investSavings' : 'costs'); }
  // v4.2: lines keep what each of you puts in (l.me, l.them); the total is the two added up.
  function cpR2(v) { return Math.round(v * 100) / 100; }
  function cpMine(l) { if (l.mode === 'amt') return cpR2(l.them == null ? Math.min(amt(l.me), amt(l.total)) : amt(l.me)); var t = amt(l.total), m = t * cpMyPct(l); return Math.abs(t - Math.round(t)) < 0.005 ? Math.round(m) : Math.round(m * 100) / 100; } // whole pounds for whole-pound totals
  function cpTheirs(l) { return l.mode === 'amt' && l.them != null ? cpR2(amt(l.them)) : cpR2(amt(l.total) - cpMine(l)); }
  function cpSetAmts(l, me, them) { l.mode = 'amt'; me = Math.max(0, cpR2(me)); them = Math.max(0, cpR2(them)); l.me = me ? String(me) : ''; l.them = them ? String(them) : ''; l.total = me + them ? String(cpR2(me + them)) : ''; }
  function cpIsSaving(cat) { return /sav|invest|holiday fund/i.test(cat || ''); }
  function newCoupleCode() { var a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', o = ''; for (var i = 0; i < 6; i++) o += a[Math.floor(Math.random() * a.length)]; return o.slice(0, 3) + '-' + o.slice(3); }
  // Keep your planner's shared lines in step with the Couples planner.
  function syncCouple() {
    if (!state.groups) return;
    var on = coupleOn(), lines = on ? C().lines : [], want = {};
    // v4.2: reminder dates on shared lines go into both partners' reminders (and payday emails, if ticked)
    var REM = state.costRemind || (state.costRemind = {}), keepR = {};
    lines.forEach(function (l) { if (!l.remind) return; var p = l.remind.split('-'); keepR['cp:' + l.id] = 1;
      var r = { m: Number(p[0]) * 12 + Number(p[1]) - 1, d: l.remind, name: (l.name || 'Shared cost') + ' (shared)' }; if (JSON.stringify(REM['cp:' + l.id]) !== JSON.stringify(r)) REM['cp:' + l.id] = r; });
    Object.keys(REM).forEach(function (k) { if (/^cp:/.test(k) && !keepR[k]) delete REM[k]; });
    lines.forEach(function (l) { if (cpMine(l) > 0.004 && (l.name || amt(l.total))) want[l.id] = l; });
    state.groups.forEach(function (g) { g.categories.forEach(function (c) { c.items = c.items.filter(function (it) { return !it.coupleId || want[it.coupleId]; }); }); });
    Object.keys(want).forEach(function (id) {
      var l = want[id], gk = cpGroupOf(l.cat), sav = gk === 'investSavings', g = findGroup(gk) || findGroup('costs'); if (!g) return;
      var cid = sav ? 'cat_shared_sav' : gk === 'guiltFree' ? 'cat_shared_gf' : 'cat_shared', cname = 'Shared with ' + coupleName();
      var found = findItemBy(function (it) { return it.coupleId === id; });
      if (found && found.g !== g) { found.c.items.splice(found.c.items.indexOf(found.item), 1); found = null; }
      var cat = g.categories.find(function (c) { return c.id === cid; });
      if (!cat) { cat = { id: cid, name: cname, items: [] }; g.categories.unshift(cat); }
      cat.name = cname;
      var mine = String(cpMine(l));
      if (!found) cat.items.push({ id: uid('it'), label: l.name || 'Shared', target: mine, budgeted: mine, account: '', runs: '', due: '', automated: false, coupleId: id, coupleShare: mine });
      else { var it = found.item; it.label = l.name || 'Shared'; if (it.coupleShare !== mine) { autoOff(it, it.target, mine); it.target = mine; it.budgeted = mine; it.coupleShare = mine; } }
    });
    // v4.2: money one of you sends the other. Coming to you: Income › From <partner>. Going to them: Costs › Shared with <partner>.
    var trs = {}; (on ? C().transfers || [] : []).forEach(function (t) { if (amt(t.amount) > 0) trs[t.id] = t; });
    state.groups.forEach(function (g) { g.categories.forEach(function (c) { c.items = c.items.filter(function (it) { return !it.coupleTr || trs[it.coupleTr]; }); }); });
    Object.keys(trs).forEach(function (id) {
      var t = trs[id], toMe = t.from === 'them', g = findGroup(toMe ? 'income' : 'costs'); if (!g) return;
      var cid = toMe ? 'cat_shared_in' : 'cat_shared', cname = toMe ? 'From ' + coupleName() : 'Shared with ' + coupleName();
      var found = findItemBy(function (it) { return it.coupleTr === id; });
      if (found && found.g !== g) { found.c.items.splice(found.c.items.indexOf(found.item), 1); found = null; }
      var cat = g.categories.find(function (c) { return c.id === cid; });
      if (!cat) { cat = { id: cid, name: cname, items: [] }; if (toMe) g.categories.push(cat); else g.categories.unshift(cat); }
      cat.name = cname;
      var v = String(cpR2(amt(t.amount))), label = (toMe ? 'From ' : 'To ') + coupleName() + (t.note ? ': ' + t.note : '');
      if (!found) cat.items.push({ id: uid('it'), label: label, target: v, budgeted: v, account: '', runs: '', due: '', automated: false, coupleTr: id, coupleShare: v });
      else { var it = found.item; it.label = label; if (it.coupleShare !== v) { autoOff(it, it.target, v); it.target = v; it.budgeted = v; it.coupleShare = v; } }
    });
    state.groups.forEach(function (g) { g.categories = g.categories.filter(function (c) { return !(/^cat_shared/.test(c.id) && !c.items.length); }); });
  }
  function findItemBy(fn) { for (var i = 0; i < state.groups.length; i++) { var g = state.groups[i]; for (var j = 0; j < g.categories.length; j++) { var c = g.categories[j]; for (var k = 0; k < c.items.length; k++) if (fn(c.items[k])) return { g: g, c: c, item: c.items[k] }; } } return null; }
  function coupleConnect(partner, lines) {
    var c = C(); c.status = 'connected'; c.partner = partner; if (lines) c.lines = lines; commit();
    showUndo('You’re connected with ' + partner.name, null);
  }
  function coupleExample() {
    var L = function (name, cat, total, mode) { return { id: uid('cl'), name: name, cat: cat, total: String(total), mode: mode || 'usual' }; };
    C().catGroups = { 'Saving together': 'investSavings', 'Home': 'costs', 'Food': 'costs', 'Fun together': 'guiltFree' };
    coupleConnect({ name: 'Alex', pay: '1700' }, [L('Holiday fund', 'Saving together', 200, 'equal'), L('House deposit', 'Saving together', 300, 'equal'),
      L('Rent', 'Home', 1200, 'equal'), L('Council tax', 'Home', 160, 'equal'), L('Energy', 'Home', 120, 'equal'), L('Wifi', 'Home', 35, 'me'),
      L('Groceries', 'Food', 400, 'equal'), L('Date night', 'Fun together', 80, 'equal'), L('Netflix', 'Fun together', 11, 'them')]);
    if (!cpRecs().length) { cpRecExample(); commit(); }
  }
  function coupleStop() {
    if (cpLeaveLive(function () { var o = JSON.parse(JSON.stringify(C())); state.couple = { code: '', status: 'none', partner: null, split: o.split, customPct: o.customPct, lines: [], records: o.records || [], pastPartner: o.partner ? o.partner.name : o.pastPartner }; commit(); showUndo('You’ve stopped sharing. Your shared lines have left your planner; your shared records are kept.'); })) return;
    var old = JSON.parse(JSON.stringify(C())); state.couple = { code: old.code, status: 'none', partner: null, split: old.split, customPct: old.customPct, lines: [], records: old.records || [], pastPartner: old.partner ? old.partner.name : old.pastPartner }; commit();
    showUndo('You’ve stopped sharing with ' + (old.partner ? old.partner.name : 'your partner') + '. Their shared lines have left your planner.', function () { state.couple = old; commit(); });
  }
  // Drop a line into a category at a place in it.
  function cpMoveLine(id, cat, index) {
    var c = C(), i = c.lines.findIndex(function (l) { return l.id === id; }); if (i < 0) return;
    var l = c.lines.splice(i, 1)[0]; l.cat = cat;
    var inCat = c.lines.filter(function (x) { return x.cat === cat; });
    var at = index < inCat.length ? c.lines.indexOf(inCat[index]) : (inCat.length ? c.lines.indexOf(inCat[inCat.length - 1]) + 1 : c.lines.length);
    c.lines.splice(at, 0, l);
  }
  function cpCats() { var o = []; C().lines.forEach(function (l) { if (o.indexOf(l.cat) < 0) o.push(l.cat); }); return o; }
  function cpMoveCat(cat, index, gk) {
    var c = C(), order = cpCats(), i = order.indexOf(cat); if (i < 0) return;
    if (gk && /^(investSavings|costs|guiltFree)$/.test(gk)) { c.catGroups = Object.assign({}, c.catGroups); c.catGroups[cat] = gk; }
    order.splice(i, 1);
    var inG = order.filter(function (k) { return cpGroupOf(k) === cpGroupOf(cat); });
    var at = index < inG.length ? order.indexOf(inG[index]) : (inG.length ? order.indexOf(inG[inG.length - 1]) + 1 : order.length);
    order.splice(at, 0, cat);
    c.lines = order.reduce(function (a, k) { return a.concat(c.lines.filter(function (l) { return l.cat === k; })); }, []);
  }
  function cpKeyMoveLine(e, l) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return; e.preventDefault();
    var inCat = C().lines.filter(function (x) { return x.cat === l.cat; }), i = inCat.indexOf(l), ni = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (ni < 0 || ni >= inCat.length) return;
    cpMoveLine(l.id, l.cat, ni); commit();
    var n = document.querySelector('[data-cpgrip="' + l.id + '"]'); if (n) n.focus();
  }
  function cpKeyMoveCat(e, cat) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return; e.preventDefault();
    var order = cpCats().filter(function (k) { return cpGroupOf(k) === cpGroupOf(cat); }), i = order.indexOf(cat), ni = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (ni < 0 || ni >= order.length) return;
    cpMoveCat(cat, ni); commit();
    var n = document.querySelector('[data-cpgrip="cat:' + cat + '"]'); if (n) n.focus();
  }
  function cpAddLine(after, cat) {
    var c = C(), id = uid('cl'), i = after ? c.lines.indexOf(after) + 1 : c.lines.length;
    c.lines.splice(i, 0, { id: id, name: '', cat: cat || (after ? after.cat : 'Home'), total: '', mode: 'amt', me: '', them: '' }); commit();
    setTimeout(function () { var e = document.getElementById('f-cpn-' + id); if (e) e.focus(); }, 0);
  }
  function cpRemoveLine(l) {
    var c = C(), i = c.lines.indexOf(l); c.lines.splice(i, 1); commit();
    showUndo('Removed ' + (l.name || 'the line'), function () { c.lines.splice(i, 0, l); commit(); });
  }
  function couplesBody() {
    var c = C();
    if (cpLive()) { if (!coupleOn() && (!c.code || c.status !== 'none' || !cpS.asked)) cpEnsureCode(); } else if (!c.code) c.code = newCoupleCode();
    if (!coupleOn()) {
      var join = field('cp-join', state.cpJoin || '', function (v) { state.cpJoin = v; }, { cls: 'cp-in', ph: 'e.g. K7P-4QX', label: 'Your partner’s code' });
      return h('div', { class: 'cpl' }, [
        h('section', { class: 'cpl-hero' }, [h('span', { class: 'cpl-hic', html: IC.heart }), h('div', {}, [h('h4', { text: 'Plan the costs you share' }),
          h('p', { text: 'Connect with your partner and keep one table of everything you share: saving together, bills, food and fun. Type what each of you puts in, and your part goes straight into your own Monthly Planner.' })])]),
        h('div', { class: 'cpl-two' }, [
          h('section', { class: 'cpl-card' }, [h('small', { text: 'Your code' }), h('div', { class: 'cpl-code', text: c.code || (isOffline() ? 'Connect to get your code' : 'Getting your code…') }),
            h('p', { text: 'Give this to your partner. They open Couples planner in their PayStamp and type it in.' }),
            btn('pill-btn', 'Copy your code', function () { copyText(c.code, 'cp-code'); }, [state.cpCopied === 'cp-code' ? 'Copied' : 'Copy code'])]),
          h('section', { class: 'cpl-card' }, [h('small', { text: 'Got a code from your partner?' }), join,
            btn('pill-btn primary', 'Connect', function () {
              var v = String(state.cpJoin || '').trim().toUpperCase();
              if (needsSignal('Connecting with your partner')) return;
              if (v.replace(/[^A-Z0-9]/g, '').length < 6) { set({ cpMsg: 'Type the 6 letters and numbers from your partner’s code.' }); return; }
              if (cpJoinLive(v)) return;
              set({ cpMsg: null }); coupleExample();
            }, ['Connect']),
            state.cpMsg ? h('p', { class: 'fb-err', text: state.cpMsg }) : h('p', { text: 'You’ll both see the same shared table, and either of you can change it.' })]) ]),
        window.PayStamp && window.PayStamp.preview ? h('p', { class: 'cpl-pv' }, ['Preview: any code connects you to an example partner. ', btn('cp-inline', 'See an example', coupleExample, ['See an example ›'])]) : null,
        (c.records || []).length ? couplesRecords(true) : null ]);
    }
    var pn = coupleName(), lines = c.lines, tot = 0, mineT = 0, theirsT = 0;
    lines.forEach(function (l) { tot += amt(l.total); mineT += cpMine(l); theirsT += cpTheirs(l); });
    var pctMe = tot ? mineT / tot * 100 : 50;
    var me0 = (userName() || 'You').slice(0, 1).toUpperCase(), pn0 = pn.slice(0, 1).toUpperCase();
    var head = h('div', { class: 'cpl-head' }, [h('span', { class: 'cpl-pair' }, [h('i', { class: 'a', text: me0 }), h('i', { class: 'b', text: pn0 })]),
      h('span', {}, ['You and ', h('b', { text: pn })]), h('span', { class: 'cpl-ok', text: '✓ Connected' }), h('span', { class: 'cpl-mut', text: 'Either of you can add or change a line' }),
      !userName() && cpLive() ? btn('cp-inline', 'Add your first name', function () { go('account'); }, ['Add your first name so ' + pn + ' sees who you are ›']) : null]);
    // v4.1: no totals tiles and no split settings; the page starts with the shared table, in the planner's three boxes
    var cats = cpCats();
    var cpGrip = function (kind, id, label, onKey) {
      var g = h('button', { type: 'button', class: 'handle cpl-grip', 'aria-label': label, title: 'Drag to move', html: GRIP, 'data-cpgrip': id });
      g.addEventListener('pointerdown', function (e) { startDrag(e, kind); }); g.addEventListener('keydown', onKey); return g;
    };
    var setMe = function (l, v) { track('couple_amount', 'me', true); cpSetAmts(l, amt(v), cpTheirs(l)); commit(); };
    var setThem = function (l, v) { track('couple_amount', 'them', true); cpSetAmts(l, cpMine(l), amt(v)); commit(); };
    // Typing a total shares it out the way the line is already shared (half each for a new line).
    var setTotal = function (l, v) { var t = amt(v), m = cpMine(l), th = cpTheirs(l), sum = m + th, me = sum > 0 ? cpR2(t * m / sum) : cpR2(t / 2); cpSetAmts(l, me, t - me); commit(); };
    var uniqueCat = function (base) { var n = base, k = 2; while (cats.indexOf(n) > -1) n = base + ' ' + (k++); return n; };
    var boxes = CP_GROUPS.map(function (G) {
      var gk = G[0], gcats = cats.filter(function (k) { return cpGroupOf(k) === gk; }), gt = 0, gm = 0, gth = 0;
      var box = h('section', { class: 'cplg', style: '--g:' + G[2] });
      var newCat = function () { var n = uniqueCat(gk === 'investSavings' ? 'Saving together' : gk === 'guiltFree' ? 'Fun together' : 'New category'); c.catGroups = Object.assign({}, c.catGroups); c.catGroups[n] = gk; cpAddLine(null, n); setTimeout(function () { var e = document.querySelector('[data-k="cpc-' + n + '"]'); if (e) { e.focus(); e.select(); } }, 30); };
      box.append(h('div', { class: 'cplg-h' }, [h('h3', { text: G[1] }), btn('g-add cplg-add', 'Add a category to ' + G[1], newCat, ['+ Category'])]));
      var wrap = h('div', { class: 'cpl-cats', 'data-drop-kind': 'cplcat', 'data-list-id': gk }); box.append(wrap);
      gcats.forEach(function (cat) {
        var cl = c.lines.filter(function (l) { return l.cat === cat; }), ct = 0, cm = 0, cth = 0;
        var blk = h('div', { class: 'cpl-blk', 'data-drop-block': 'cpl', 'data-row-id': 'cat:' + cat });
        var lst = h('div', { class: 'cpl-lines', 'data-drop-kind': 'cpl', 'data-list-id': cat });
        blk.append(h('div', { class: 'cpl-r ch' }, [
          h('span', { class: 'cpl-cn' }, [cpGrip('cplcat', 'cat:' + cat, 'Move the ' + cat + ' category (drag, or use arrow keys)', function (e) { cpKeyMoveCat(e, cat); }),
            field('cpc-' + cat, cat, function (v) { v = String(v || '').trim() || cat; if (v !== cat) { c.catGroups = Object.assign({}, c.catGroups); c.catGroups[v] = gk; } cl.forEach(function (l) { l.cat = v; }); commit(); }, { cls: 'cpl-in cat', label: 'Category name' }),
            btn('rx-plus l top', 'Add a line to ' + cat, function () { cpAddLine(cl[cl.length - 1] || null, cat); }, ['+'], { title: 'Add a line' }) ]),
          h('span', { text: 'Total' }), h('span', {}, [h('i', { class: 'cpl-dot a' }), 'You']), h('span', {}, [h('i', { class: 'cpl-dot b' }), pn]) ]), lst);
        wrap.append(blk);
        cl.forEach(function (l) {
          var mine = cpMine(l), theirs = cpTheirs(l); ct += amt(l.total); cm += mine; cth += theirs;
          lst.append(h('div', { class: 'cpl-r it', 'data-row-id': l.id }, [
            h('span', { class: 'cpl-nm' }, [cpGrip('cpl', l.id, 'Move ' + (l.name || 'this line') + ' (drag, or use arrow keys)', function (e) { cpKeyMoveLine(e, l); }), field('cpn-' + l.id, l.name, function (v) { l.name = String(v || '').trim(); commit(); }, { cls: 'cpl-in', ph: 'What is it?', label: 'Shared line name' }),
              btn('rx-plus l', 'Add a line under ' + (l.name || 'this one'), function () { cpAddLine(l); }, ['+'], { title: 'Add a line here' }),
              btn('rx-lx', 'Remove ' + (l.name || 'this line'), function () { cpRemoveLine(l); }, ['✕'], { title: 'Remove' }) ]),
            field('cpt-' + l.id, l.total, function (v) { setTotal(l, v); }, { cls: 'cpl-in num', ph: '0', num: true, money: true, label: 'Total for ' + (l.name || 'this line') }),
            field('cpm-' + l.id, mine ? String(mine) : '', function (v) { setMe(l, v); }, { cls: 'cpl-in num me', ph: '£0', num: true, money: true, label: 'What you put in for ' + (l.name || 'this line') }),
            field('cpp-' + l.id, theirs ? String(theirs) : '', function (v) { setThem(l, v); }, { cls: 'cpl-in num them', ph: '£0', num: true, money: true, label: 'What ' + pn + ' puts in for ' + (l.name || 'this line') }) ]));
        });
        gt += ct; gm += cm; gth += cth;
        if (cl.length > 1 && gcats.length > 1) blk.append(h('div', { class: 'cpl-r ct' }, [h('span', { text: 'Total' }), h('span', { text: money(ct) }), h('span', { text: money(cm) }), h('span', { text: money(cth) })]));
      });
      if (!gcats.length) box.append(h('div', { class: 'cpl-empty' }, ['Nothing here yet. ', btn('cp-inline', 'Add a category to ' + G[1], newCat, ['+ Add a category'])]));
      else box.append(h('div', { class: 'cpl-r tot' }, [h('span', { text: 'Total' }), h('span', { text: money(gt) }), h('span', { text: money(gm) }), h('span', { text: money(gth) })]));
      return box;
    });
    var allT = 0, allM = 0, allTh = 0; c.lines.forEach(function (l) { allT += amt(l.total); allM += cpMine(l); allTh += cpTheirs(l); });
    var gv = function (k, v) { return h('span', { class: 'cpl-gv' }, [h('small', { text: k }), h('b', { text: money(v) })]); };
    var grand = h('div', { class: 'cpl-grand' }, [h('span', { class: 'cpl-r' }, [h('span', { text: 'Shared each month' }), gv('Total', allT), gv('You put in', allM), gv(pn + ' puts in', allTh)])]);
    var ideas = [['Rent', 'Home'], ['Council tax', 'Home'], ['Energy', 'Home'], ['Water', 'Home'], ['Wifi', 'Home'], ['Groceries', 'Food'], ['Holiday fund', 'Saving together'], ['Date night', 'Fun together']].filter(function (n) { return !c.lines.some(function (l) { return (l.name || '').toLowerCase() === n[0].toLowerCase(); }); });
    var quick = ideas.length ? h('div', { class: 'cpl-quick' }, [h('small', { text: 'Quick add' })].concat(ideas.map(function (n) {
      return btn('qs-chip-mini', 'Add ' + n[0], function () { if (!c.catGroups || !c.catGroups[n[1]]) { c.catGroups = Object.assign({}, c.catGroups); c.catGroups[n[1]] = n[1] === 'Saving together' ? 'investSavings' : n[1] === 'Fun together' ? 'guiltFree' : 'costs'; } c.lines.push({ id: uid('cl'), name: n[0], cat: n[1], total: '', mode: 'equal' }); commit(); }, ['+ ' + n[0]]);
    }))) : null;
    var t = h('div', { class: 'cpl-boxes' }, boxes.concat([grand]));
    var tiles = null, split = null, addRow = null;
    return h('div', { class: 'cpl' }, [head, t, quick, cpSettleCard(c, pn), couplesRecords(),
      h('p', { class: 'cpl-note' }, [h('span', { class: 'cpl-hic sm', html: IC.heart }), 'What you put in for each line goes into your Monthly Planner under ', h('b', { text: 'Shared with ' + pn }), ', in the matching box: Savings & Investments, Costs or Guilt-free spending. ' + pn + ' sees their part in theirs.']),
      h('div', { class: 'cpl-foot' }, [btn('cp-inline', 'Go to my planner', function () { go('plan'); }, ['See it in my planner ›']), btn('cpl-stop', 'Stop sharing with ' + pn, coupleStop, ['Stop sharing'])]) ]);
  }

  /* ---------- v4.2: Money between you ----------
     c.transfers = [{ id, from: 'me'|'them', amount, note }]. Not part of the shared table's totals.
     Money coming to you shows in your Income; money you send shows in your Costs. */
  function cpSettleCard(c, pn) {
    var T = c.transfers || (c.transfers = []);
    var add = function () { T.push({ id: uid('ct'), from: 'them', amount: '', note: '' }); track('couple_transfer', 'add', true); commit();
      setTimeout(function () { var e = document.getElementById('f-cpta-' + T[T.length - 1].id); if (e) e.focus(); }, 0); };
    var rows = T.map(function (t) {
      var sel = h('select', { class: 'cpb-pick', 'aria-label': 'Who sends this money', onchange: function (e) { t.from = e.target.value; commit(); } },
        [h('option', { value: 'them', text: pn + ' sends me' }), h('option', { value: 'me', text: 'I send ' + pn })]);
      sel.value = t.from === 'me' ? 'me' : 'them';
      return h('div', { class: 'cpb-r' }, [sel,
        field('cpta-' + t.id, t.amount, function (v) { t.amount = String(amt(v) || ''); commit(); }, { cls: 'cpb-amt', ph: '0', num: true, money: true, label: 'How much each month' }),
        field('cptn-' + t.id, t.note, function (v) { t.note = String(v || '').trim().slice(0, 60); commit(); }, { cls: 'cpb-note', ph: 'What for? e.g. half the bills', label: 'What it’s for' }),
        btn('rx-lx', 'Remove this', function () { var i = T.indexOf(t); T.splice(i, 1); commit(); showUndo('Removed', function () { T.splice(i, 0, t); commit(); }); }, ['✕'], { title: 'Remove' }) ]);
    });
    var inn = 0, out = 0; T.forEach(function (t) { if (t.from === 'me') out += amt(t.amount); else inn += amt(t.amount); });
    var net = cpR2(inn - out);
    return h('section', { class: 'cpb' }, [
      h('div', { class: 'cpb-h' }, [h('h3', { text: 'Money between you' }), h('small', { text: 'What one of you sends the other each month, like your partner paying you back for bills' })]),
      rows.length ? h('div', { class: 'cpb-list' }, rows) : null,
      btn('cp-inline', 'Add money one of you sends the other', add, [rows.length ? '+ Add another' : '+ Add money one of you sends the other']),
      rows.length && (inn || out) ? h('p', { class: 'cpb-res' }, [h('b', { text: Math.abs(net) < 0.005 ? 'You’re even each month.' : net > 0 ? 'Each month ' + pn + ' sends you ' + money(net) + '.' : 'Each month you send ' + pn + ' ' + money(-net) + '.' }),
        ' It isn’t added to the shared table. In your planner, money coming to you is under Income (From ' + pn + ') and money you send is under Costs (Shared with ' + pn + '). ' + pn + ' sees it the other way round.']) : null ]);
  }
  

  /* ---------- v3.7: PayStamp Hustle ----------
     state.hustles = { taxPct, pay: { on, mode: 'last'|'set', amount }, pot: true|false,
       list: [{ id, name, color, mode: 'monthly'|'every', months: { 'YYYY-MM': { in, out, note } }, entries: [{ id, date, what, type, in, out }] }] }
     The tax year runs 6 April to 5 April. Monthly totals are kept by month; every-sale lines by date. */
  var HU_COLS = ['#C8642A', '#1F7A7A', '#5B4B8A', '#B8860B', '#2A5C8A', '#C2417A'];
  var HU_TYPES = ['Sale', 'Materials', 'Fees', 'Postage', 'Travel', 'Equipment', 'Other'];
  function HU() { return state.hustles || (state.hustles = { taxPct: '20', pay: { on: false, mode: 'last', amount: '' }, pot: false, list: [] }); }
  function huTaxYearNow() { var d = new Date(); return d.getMonth() > 3 || (d.getMonth() === 3 && d.getDate() >= 6) ? d.getFullYear() : d.getFullYear() - 1; }
  function huTY() { return state.huYear != null ? Number(state.huYear) : huTaxYearNow(); }
  function huTYLabel(y) { return y + '/' + String(y + 1).slice(2); }
  function huMonthKeys(y) { var o = []; for (var i = 0; i < 12; i++) { var m = (3 + i) % 12, yy = y + (3 + i >= 12 ? 1 : 0); o.push(yy + '-' + String(m + 1).padStart(2, '0')); } return o; }
  function huKeyLabel(k) { return MONTHS[Number(k.slice(5)) - 1]; }
  function huInTY(dateStr, y) { if (!dateStr) return false; var d = new Date(dateStr + 'T12:00:00'); var a = new Date(y, 3, 6), b = new Date(y + 1, 3, 6); return d >= a && d < b; }
  function huSums(x, y) {
    var inn = 0, out = 0, byType = {};
    if (x.mode === 'every') (x.entries || []).forEach(function (e) { if (!huInTY(e.date, y)) return; inn += amt(e.in); out += amt(e.out); var t = e.type || 'Other'; byType[t] = (byType[t] || 0) + amt(e.in) + amt(e.out); });
    else huMonthKeys(y).forEach(function (k) { var m = (x.months || {})[k]; if (m) { inn += amt(m.in); out += amt(m.out); } });
    return { inn: inn, out: out, profit: inn - out, byType: byType };
  }
  function huMonthProfit(x, k) {
    if (x.mode === 'every') return (x.entries || []).filter(function (e) { return (e.date || '').slice(0, 7) === k; }).reduce(function (t, e) { return t + amt(e.in) - amt(e.out); }, 0);
    var m = (x.months || {})[k]; return m ? amt(m.in) - amt(m.out) : 0;
  }
  function huAll(y) { var t = { inn: 0, out: 0, profit: 0 }; HU().list.forEach(function (x) { var s2 = huSums(x, y); t.inn += s2.inn; t.out += s2.out; t.profit += s2.profit; }); return t; }
  function hustleSub() { var n = (state.hustles && state.hustles.list.length) || 0; return n ? n + (n === 1 ? ' hustle · ' : ' hustles · ') + money(Math.round(huAll(huTaxYearNow()).profit)) + ' profit this tax year' : 'Manage your side hustle finances'; }
  // What goes into the planner: hustle pay under Income, and a tax pot under Investments & Savings.
  function huLastMonthProfit() { var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); var k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); return HU().list.reduce(function (t, x) { return t + huMonthProfit(x, k); }, 0); }
  function huPayAmount() { var P = HU().pay || {}; return P.mode === 'set' ? amt(P.amount) : Math.max(0, Math.round(huLastMonthProfit())); }
  function huPotAmount() {
    var y = huTaxYearNow(), keys = huMonthKeys(y), now = new Date(), nk = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0'), n = Math.max(1, keys.indexOf(nk) + 1);
    var base = HU().pay && HU().pay.on ? huPayAmount() : Math.max(0, huAll(y).profit / n);
    return Math.round(base * amt(HU().taxPct) / 100);
  }
  function syncHustle() {
    if (!state.groups || !state.hustles) return;
    var H = state.hustles, has = H.list.length > 0;
    var place = function (gkey, cid, cname, flag, label, val, on) {
      var g = findGroup(gkey); if (!g) return;
      var f = findItemBy(function (it) { return it[flag]; });
      if (!on) { if (f) f.c.items.splice(f.c.items.indexOf(f.item), 1); g.categories = g.categories.filter(function (c) { return !(c.id === cid && !c.items.length); }); return; }
      var cat = g.categories.find(function (c) { return c.id === cid; }); if (!cat) { cat = { id: cid, name: cname, items: [] }; g.categories.push(cat); }
      var v = String(val);
      if (!f) { var it = { id: uid('it'), label: label, target: v, budgeted: v, account: '', runs: '', due: '', automated: false, hustleLine: true, huVal: v }; it[flag] = true; cat.items.push(it); }
      else if (f.item.huVal !== v) { f.item.target = v; f.item.budgeted = v; f.item.huVal = v; }
    };
    place('income', 'cat_hustle', 'Side hustle', 'hustlePay', 'Hustle pay', huPayAmount(), has && H.pay && H.pay.on);
    place('investSavings', 'cat_hustle_tax', 'Tax', 'hustleTax', 'Hustle tax pot', huPotAmount(), has && !!H.pot);
  }
  function huAdd(name) {
    var H = HU(), id = uid('hu');
    H.list.push({ id: id, name: name || 'New hustle', color: HU_COLS[H.list.length % HU_COLS.length], mode: 'monthly', months: {}, entries: [] });
    state.huOpen = id; commit();
    if (!name) setTimeout(function () { var e = document.getElementById('f-hun-' + id); if (e) { e.focus(); e.select(); } }, 0);
  }
  function huRemove(x) {
    var H = HU(), i = H.list.indexOf(x); H.list.splice(i, 1); if (state.huOpen === x.id) state.huOpen = null; commit();
    showUndo('Removed ' + x.name, function () { H.list.splice(i, 0, x); commit(); });
  }
  function huExample() {
    var H = HU(), y = huTaxYearNow(), keys = huMonthKeys(y), now = new Date(), nk = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0'), upto = Math.max(1, keys.indexOf(nk) + 1);
    var et = { id: uid('hu'), name: 'Etsy shop · prints', color: HU_COLS[0], mode: 'monthly', months: {}, entries: [] };
    var ins = [220, 260, 240, 310, 280, 300, 420, 310, 520, 180, 200, 240], outs = [80, 55, 60, 70, 75, 85, 120, 65, 140, 40, 50, 60], notes = { 0: 'Bought frames', 3: 'Craft fair', 6: 'Christmas orders start' };
    keys.slice(0, upto).forEach(function (k, i) { et.months[k] = { in: String(ins[i]), out: String(outs[i]), note: notes[i] || '' }; });
    var dw = { id: uid('hu'), name: 'Dog walking', color: HU_COLS[1], mode: 'every', months: {}, entries: [] };
    keys.slice(0, upto).forEach(function (k, i) { [8, 22].forEach(function (d, j) { dw.entries.push({ id: uid('he'), date: k + '-' + String(d).padStart(2, '0'), what: j ? 'Walks for the Browns' : 'Walks for Biscuit', type: 'Sale', in: String([70, 75][j]), out: '' }); }); if (i % 3 === 1) dw.entries.push({ id: uid('he'), date: k + '-15', what: 'Treats and bags', type: 'Materials', in: '', out: '30' }); });
    H.list.push(et, dw); state.huOpen = et.id; commit();
  }
  function hustleBody() {
    if (!isPro()) return proGate('PayStamp Hustle', 'Log what each side hustle brings in and costs, see your profit for the tax year, and know what to put aside for tax.');
    var H = HU(), y = huTY(), T = huAll(y), list = H.list, nowY = huTaxYearNow();
    var nav = h('div', { class: 'mnav hu-nav' }, [btn('mbtn', 'Previous tax year', function () { set({ huYear: y - 1 }); }, [], { html: IC.chevL }),
      h('span', { class: 'mlabel hu-year' }, ['Tax year ' + huTYLabel(y), h('small', { text: '6 Apr ' + y + ' – 5 Apr ' + (y + 1) })]),
      btn('mbtn', 'Next tax year', function () { if (y < nowY) set({ huYear: y + 1 }); }, [], { html: IC.chevR, disabled: y >= nowY })]);
    if (!list.length) return h('div', { class: 'hu' }, [
      h('section', { class: 'cpl-hero hu-hero' }, [h('span', { class: 'cpl-hic', html: IC.bag }), h('div', {}, [h('h4', { text: 'Keep track of your side hustles' }),
        h('p', { text: 'Log what each hustle brings in and costs, see your profit for the tax year, and know how much to put aside for tax. Your hustle pay and tax pot can go straight into your planner.' })])]),
      h('div', { class: 'hu-start' }, [btn('pill-btn primary', 'Add your first hustle', function () { huAdd(); }, ['+ Add your first hustle']),
        window.PayStamp && window.PayStamp.preview ? btn('cp-inline', 'See an example', huExample, ['See an example ›']) : null]) ]);
    var monthsIn = huMonthKeys(y), nk = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0'), nMo = y < nowY ? 12 : Math.max(1, monthsIn.indexOf(nk) + 1);
    var pct = amt(H.taxPct), tax = Math.max(0, Math.round(T.profit * pct / 100));
    var tiles = h('div', { class: 'hu-tiles' }, [
      h('div', { class: 'hu-tile' }, [h('small', { text: 'Money in' }), h('b', { text: money(Math.round(T.inn)) }), h('span', { text: list.length + (list.length === 1 ? ' hustle' : ' hustles') + ' this tax year' })]),
      h('div', { class: 'hu-tile' }, [h('small', { text: 'Costs' }), h('b', { text: money(Math.round(T.out)) }), h('span', { text: 'materials, fees, travel' })]),
      h('div', { class: 'hu-tile' }, [h('small', { text: 'Profit' }), h('b', { text: (T.profit < 0 ? '−' : '') + money(Math.round(Math.abs(T.profit))) }), h('span', { text: 'about ' + money(Math.round(T.profit / nMo)) + ' a month' })]),
      h('div', { class: 'hu-tile tax' }, [h('small', { text: 'Put aside for tax' }), h('b', { text: money(tax) }),
        h('span', { class: 'hu-pct' }, [field('hu-pct', H.taxPct, function (v) { H.taxPct = String(Math.max(0, Math.min(60, Math.round(amt(v))))); commit(); }, { cls: 'hu-in', num: true, label: 'Percent to put aside for tax' }), '% of profit'])]) ]);
    // the lines: £1,000 trading allowance and Making Tax Digital
    var mtd = y <= 2024 ? 50000 : y === 2025 ? 30000 : 20000, mtdFrom = y + 2;
    var bar = function (label, sub, val, line, done, left) {
      return h('div', { class: 'hu-ln' }, [h('span', {}, [h('b', { text: label }), h('small', { text: sub })]),
        h('span', { class: 'hu-track' }, [h('i', { style: 'width:' + Math.min(100, val / line * 100).toFixed(1) + '%' })]),
        h('span', { class: 'hu-st ' + (val > line ? 'warn' : 'ok'), text: val > line ? done : left })]);
    };
    var lines = h('div', { class: 'hu-lines' }, [
      bar('£1,000 trading allowance', 'All hustles together', T.inn, 1000, 'Passed · ' + money(Math.round(T.inn)), money(Math.round(1000 - T.inn)) + ' to go'),
      bar('Making Tax Digital', money(mtd) + ' line from April ' + mtdFrom, T.inn, mtd, 'Over · ' + money(Math.round(T.inn)), money(Math.round(mtd - T.inn)) + ' to go'),
      T.inn > 1000 ? h('div', { class: 'hu-alert' }, [h('i', { text: '!' }), h('span', {}, [h('b', { text: 'You’ve made more than £1,000 this tax year. ' }), 'If you haven’t already, register for Self Assessment and tell HMRC by 5 October ' + (y + 1) + '. Keep your totals here; they’re ready for your tax return.'])]) : null,
      T.inn > mtd ? h('div', { class: 'hu-alert' }, [h('i', { text: '!' }), h('span', {}, [h('b', { text: 'Over the Making Tax Digital line. ' }), 'From April ' + mtdFrom + ' you’ll need to send HMRC quarterly updates using approved software.'])]) : null ]);
    // all hustles
    var tb = h('div', { class: 'hu-t', style: '--g:#C8642A' }, [h('div', { class: 'cpl-gh' }, [h('span', { text: 'Your hustles' }), h('span', { class: 'pill', text: money(Math.round(T.profit)) + ' profit' })]),
      h('div', { class: 'hu-r ch' }, [h('span', { text: 'Hustle' }), h('span', { text: 'Money in' }), h('span', { text: 'Costs' }), h('span', { text: 'Profit' }), h('span', { text: 'Logged as' })])]);
    list.forEach(function (x) {
      var s2 = huSums(x, y), open = state.huOpen === x.id;
      tb.append(h('div', { class: 'hu-r it' + (open ? ' open' : ''), onclick: function (e) { if (!e.target.closest('input,button')) set({ huOpen: open ? null : x.id }); } }, [
        h('span', { class: 'hu-nm' }, [h('i', { class: 'hu-sw', style: 'background:' + x.color }), field('hun-' + x.id, x.name, function (v) { x.name = String(v || '').trim() || 'Hustle'; commit(); }, { cls: 'cpl-in', label: 'Hustle name' }),
          btn('rx-lx', 'Remove ' + x.name, function () { huRemove(x); }, ['✕'], { title: 'Remove this hustle' })]),
        h('span', { text: money(Math.round(s2.inn)) }), h('span', { text: money(Math.round(s2.out)) }), h('span', { class: s2.profit >= 0 ? 'pos' : 'neg', text: (s2.profit < 0 ? '−' : '') + money(Math.round(Math.abs(s2.profit))) }),
        h('span', { class: 'hu-open' }, [x.mode === 'every' ? 'Every sale' : 'Monthly totals', h('b', { text: open ? '▴' : '▾' })]) ]));
    });
    tb.append(h('div', { class: 'hu-add' }, [btn('cp-inline', 'Add a hustle', function () { huAdd(); }, ['+ Add a hustle'])]));
    tb.append(h('div', { class: 'hu-r tot' }, [h('span', { text: 'TOTAL' }), h('span', { text: money(Math.round(T.inn)) }), h('span', { text: money(Math.round(T.out)) }), h('span', { text: money(Math.round(T.profit)) }), h('span')]));
    var kids = [nav, tiles, lines, h('div', { class: 'rx-scroll' }, [tb])];
    var x = list.find(function (q) { return q.id === state.huOpen; });
    if (x) kids.push(huDetail(x, y, nMo));
    // planner settings
    var P = H.pay || (H.pay = { on: false, mode: 'last', amount: '' });
    var tog = function (on, label, flip) { return h('button', { type: 'button', class: 'sw', role: 'switch', 'aria-checked': String(!!on), 'aria-label': label, onclick: function () { flip(); commit(); } }, [h('i')]); };
    kids.push(h('section', { class: 'hu-plan' }, [h('h4', { text: 'In your Monthly Planner' }),
      h('div', { class: 'hu-set' }, [tog(P.on, 'Add hustle pay to my Income', function () { P.on = !P.on; }), h('div', {}, [h('b', { text: 'Add hustle pay to my Income' }),
        h('small', { text: P.on ? 'Goes in as “Hustle pay” under Income › Side hustle.' : 'Off. Your planner only has your job’s pay.' }),
        P.on ? h('div', { class: 'hu-pm' }, [h('div', { class: 'rt-seg' }, [['last', 'What it made last month'], ['set', 'A set amount']].map(function (o) { return btn(P.mode === o[0] ? 'on' : '', o[1], function () { P.mode = o[0]; commit(); }, [o[1]]); })),
          P.mode === 'set' ? field('hu-payamt', P.amount, function (v) { P.amount = String(amt(v) || ''); commit(); }, { cls: 'hu-in w', ph: '£0', num: true, money: true, label: 'Hustle pay each month' }) : h('span', { class: 'cpl-mut', text: money(huPayAmount()) + ' last month' })]) : null ])]),
      h('div', { class: 'hu-set' }, [tog(H.pot, 'Put tax aside each month', function () { H.pot = !H.pot; }), h('div', {}, [h('b', { text: 'Put tax aside each month' }),
        h('small', { text: H.pot ? money(huPotAmount()) + ' a month as “Hustle tax pot” under Investments & Savings (' + (H.taxPct || 0) + '% of ' + (P.on ? 'your hustle pay' : 'your average monthly profit') + ').' : 'Off. Turn on to save your tax as you go.' })])]) ]));
    return h('div', { class: 'hu' }, kids);
  }
  function huDetail(x, y, nMo) {
    var s2 = huSums(x, y);
    var head = h('div', { class: 'hu-dh' }, [h('i', { class: 'hu-sw big', style: 'background:' + x.color }), h('h4', { text: x.name }),
      h('div', { class: 'hu-cols' }, HU_COLS.map(function (c) { return h('button', { type: 'button', class: 'hu-c' + (c === x.color ? ' on' : ''), style: 'background:' + c, 'aria-label': 'Colour', onclick: function () { x.color = c; commit(); } }); }))]);
    var ctl = h('div', { class: 'hu-ctl' }, [h('span', { class: 'hu-lbl', text: 'Log as' }),
      h('div', { class: 'rt-seg' }, [['monthly', 'Monthly totals'], ['every', 'Every sale']].map(function (o) { return btn(x.mode === o[0] ? 'on' : '', o[1], function () { x.mode = o[0]; commit(); }, [o[1]]); })),
      h('span', { class: 'cpl-mut', text: x.mode === 'every' ? 'Each sale and cost on its own line, with a date and type.' : 'One line a month is enough. Switch to every sale for more detail.' })]);
    var t = h('div', { class: 'hu-t', style: '--g:' + x.color });
    if (x.mode !== 'every') {
      var keys = huMonthKeys(y).slice(0, nMo);
      t.append(h('div', { class: 'hu-r m ch' }, [h('span', { text: 'Month' }), h('span', { text: 'Money in' }), h('span', { text: 'Costs' }), h('span', { text: 'Profit' }), h('span', { text: 'Note' })]));
      keys.forEach(function (k) {
        var m = (x.months || (x.months = {}))[k] || {}, set1 = function (f, v) { var mm = x.months[k] || (x.months[k] = { in: '', out: '', note: '' }); mm[f] = v; commit(); };
        var pr = amt(m.in) - amt(m.out);
        t.append(h('div', { class: 'hu-r m it' }, [h('span', { text: huKeyLabel(k) + (k.slice(0, 4) !== String(y) ? ' ' + k.slice(0, 4) : '') }),
          field('hmi-' + x.id + k, m.in || '', function (v) { set1('in', String(amt(v) || '')); }, { cls: 'cpl-in num', ph: '–', num: true, money: true, label: 'Money in, ' + huKeyLabel(k) }),
          field('hmo-' + x.id + k, m.out || '', function (v) { set1('out', String(amt(v) || '')); }, { cls: 'cpl-in num', ph: '–', num: true, money: true, label: 'Costs, ' + huKeyLabel(k) }),
          h('span', { class: m.in || m.out ? (pr >= 0 ? 'pos' : 'neg') : 'z', text: m.in || m.out ? (pr < 0 ? '−' : '') + money(Math.abs(pr)) : '–' }),
          field('hmn-' + x.id + k, m.note || '', function (v) { set1('note', String(v || '')); }, { cls: 'cpl-in note', label: 'Note, ' + huKeyLabel(k) }) ]));
      });
    } else {
      var es = (x.entries || (x.entries = [])).filter(function (e) { return !e.date || huInTY(e.date, y); }).sort(function (a, b) { return (a.date || '9').localeCompare(b.date || '9'); });
      t.append(h('div', { class: 'hu-r e ch' }, [h('span', { text: 'Date' }), h('span', { text: 'What' }), h('span', { text: 'Type' }), h('span', { text: 'Money in' }), h('span', { text: 'Money out' })]));
      var addAfter = function (e) { var ne = { id: uid('he'), date: e ? e.date : new Date().toISOString().slice(0, 10), what: '', type: 'Sale', in: '', out: '' }; x.entries.push(ne); commit(); setTimeout(function () { var el = document.getElementById('f-hew-' + ne.id); if (el) el.focus(); }, 0); };
      es.forEach(function (e) {
        var ty = h('select', { class: 'cpl-mode', 'aria-label': 'Type', onchange: function (ev) { e.type = ev.target.value; commit(); } }, HU_TYPES.map(function (q) { return h('option', { value: q, text: q }); })); ty.value = e.type || 'Sale';
        var dt = h('input', { type: 'date', class: 'cpl-in hu-date', value: e.date || '', 'aria-label': 'Date', onchange: function (ev) { e.date = ev.target.value; commit(); } });
        t.append(h('div', { class: 'hu-r e it' }, [h('span', { class: 'hu-dc' }, [dt, btn('rx-plus l', 'Add a line under this one', function () { addAfter(e); }, ['+'], { title: 'Add a line' })]),
          h('span', { class: 'cpl-nm' }, [field('hew-' + e.id, e.what, function (v) { e.what = String(v || ''); commit(); }, { cls: 'cpl-in', ph: 'What was it?', label: 'What' }),
            btn('rx-lx', 'Remove this line', function () { var i = x.entries.indexOf(e); x.entries.splice(i, 1); commit(); showUndo('Line removed', function () { x.entries.splice(i, 0, e); commit(); }); }, ['✕'])]),
          h('span', {}, [ty]),
          field('hei-' + e.id, e.in, function (v) { e.in = String(amt(v) || ''); commit(); }, { cls: 'cpl-in num', ph: '–', num: true, money: true, label: 'Money in' }),
          field('heo-' + e.id, e.out, function (v) { e.out = String(amt(v) || ''); commit(); }, { cls: 'cpl-in num', ph: '–', num: true, money: true, label: 'Money out' }) ]));
      });
      t.append(h('div', { class: 'hu-add' }, [btn('cp-inline', 'Add a line', function () { addAfter(null); }, ['+ Add a sale or cost'])]));
    }
    t.append(h('div', { class: 'hu-r tot ' + (x.mode === 'every' ? 'e' : 'm') }, x.mode === 'every'
      ? [h('span', { text: 'TOTAL' }), h('span'), h('span', { text: 'Profit ' + money(Math.round(s2.profit)) }), h('span', { text: money(Math.round(s2.inn)) }), h('span', { text: money(Math.round(s2.out)) })]
      : [h('span', { text: 'TOTAL' }), h('span', { text: money(Math.round(s2.inn)) }), h('span', { text: money(Math.round(s2.out)) }), h('span', { text: money(Math.round(s2.profit)) }), h('span')]));
    var types = Object.keys(s2.byType);
    var sum = x.mode === 'every' && types.length ? h('div', { class: 'hu-sum' }, HU_TYPES.filter(function (q) { return s2.byType[q]; }).map(function (q) { return h('div', {}, [q, h('b', { text: money(Math.round(s2.byType[q])) })]); })
      .concat([h('div', {}, ['Profit', h('b', { text: money(Math.round(s2.profit)) })])])) : null;
    return h('section', { class: 'hu-detail' }, [head, ctl, h('div', { class: 'rx-scroll' }, [t]), sum]);
  }
  function linkTag(it) {
    if (it.hustleLine) { var ht = h('button', { type: 'button', class: 'link-tag hu-tag', 'data-tip': 'From PayStamp Hustle. Click to open it.', 'aria-label': 'Open PayStamp Hustle', html: IC.bag }); ht.addEventListener('click', function () { go('hustle'); }); return ht; }
    if (it.coupleId) { var ct = h('button', { type: 'button', class: 'link-tag cp-shared', 'data-tip': 'Shared with ' + coupleName() + '. Your share comes from the Couples planner.', 'aria-label': 'Open the Couples planner', html: IC.heart }); ct.addEventListener('click', function () { go('couples'); }); return ct; }
    var page = it.debtId ? 'Debt' : it.savingId ? 'Savings' : it.investmentId ? 'Investments' : null;
    if (!page) return null;
    var tag = h('button', { type: 'button', class: 'link-tag', 'data-tip': 'Linked to your ' + page + ' page. Click to go to it.', 'aria-label': 'Open your ' + page + ' page', html: linkIcon(page) });
    tag.addEventListener('click', function () { openOnPage(page.toLowerCase(), it.debtId || it.savingId || it.investmentId); });
    return tag;
  }

  /* ---------- feedback ----------
     The form hands { kind, message, contactOk, page, userAgent } to window.PayStamp.sendFeedback,
     which the live site provides (saves to the Supabase 'feedback' table). The preview has no
     server, so it only shows what would be sent. */
  var FB_KINDS = [
    { key: 'suggestion', label: 'Suggestion', note: 'An idea or something to improve', ph: 'What would make PayStamp better for you?' },
    { key: 'bug', label: 'Something’s broken', note: 'A bug or something not working', ph: 'What were you doing, and what happened? The more detail the better.' } ];
  var FB_AREAS = [
    { key: 'planner', label: 'Monthly Planner' }, { key: 'debt', label: 'Debt' }, { key: 'savings', label: 'Savings' },
    { key: 'investments', label: 'Investments' }, { key: 'records', label: 'Records' }, { key: 'account', label: 'Signing in / account' }, { key: 'other', label: 'Something else' } ];
  var FB_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 3.5h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M6.5 8h7M6.5 11h4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  function fbCard(area) {
    var a = FB_AREAS.find(function (x) { return x.key === area; });
    return h('button', { type: 'button', class: 'fb-slim', onclick: function () { set({ fbqOpen: true, fbqSent: false, fbqErr: null }); setTimeout(function () { var t = document.getElementById('f-fbq'); if (t) t.focus(); }, 60); } }, [
      h('span', { class: 'fb-card-ic', html: FB_ICON }),
      h('span', { class: 'fb-slim-t', text: 'Something not right, or an idea for ' + a.label + '?' }),
      h('span', { class: 'fb-slim-go', text: 'Tell us ›' }) ]);
  }
  /* v3.4.2: Tell us. A small button in the corner of every page opens a quick message box:
     Bug, Idea or Feedback, a message, and where you were (worked out for you). It saves to the
     same feedback table as Shape PayStamp, so it shows in Admin and in the weekly list. */
  function whereNow() {
    var pg = state.page || 'plan';
    if (pg === 'cp-direct') return 'Shape PayStamp';
    if (PAGE_INFO[pg]) return PAGE_INFO[pg][0];
    return 'Monthly Planner';
  }
  var FBQ_KINDS = [['bug', 'Bug', 'bug', 'Something not working? What did you do, and what happened?'], ['idea', 'Idea', 'suggestion', 'What would make this better?'], ['feedback', 'Feedback', 'feedback', 'Anything you like, don’t like or would change.'], ['review', '★ Review', 'feedback', 'What do you like about PayStamp? What has it helped you with?']];


  function fbQuick() {
    if (state.overlay === 'feedback' || state.introOpen) return null;
    var Q = state.fbq || (state.fbq = { kind: 'bug', msg: '' }), open = !!state.fbqOpen, P = window.PayStamp || {};
    var bubble = h('button', { type: 'button', class: 'fbq-b' + (open ? ' on' : ''), 'aria-expanded': String(open), 'aria-label': open ? 'Close the message box' : 'Tell us: report a bug or share an idea', onclick: function () { set({ fbqOpen: !open, fbqSent: false, pnyOpen: false }); if (!open) setTimeout(function () { var t = document.getElementById('f-fbq'); if (t) t.focus(); }, 60); } },
      [h('span', { class: 'fbq-ic', html: FB_ICON }), h('span', { class: 'fbq-bl', text: open ? 'Close' : 'Tell us' })]);
    if (!open) return h('div', { class: 'fbq' }, [bubble]);
    if (state.fbqSent) return h('div', { class: 'fbq' }, [h('div', { class: 'fbq-p', role: 'dialog', 'aria-label': 'Message sent' }, [
      h('b', { class: 'fbq-t', text: 'Sent. Thank you!' }), h('p', { class: 'fbq-s', text: P.preview ? 'This is the preview, so nothing was sent. On paystamp.co.uk it’s saved for you to read.' : 'Every message is read, and it goes straight onto the list for the next update.' }),
      btn('pill-btn', 'Send another', function () { set({ fbqSent: false }); }, ['Send another']) ]), bubble]);
    var k = FBQ_KINDS.filter(function (x) { return x[0] === Q.kind; })[0] || FBQ_KINDS[0];
    var ta = h('textarea', { class: 'fbq-ta', id: 'f-fbq', 'data-k': 'fbq', placeholder: k[3], maxlength: '4000', 'aria-label': 'Your message' });
    ta.value = Q.msg;
    var isRv = Q.kind === 'review', ready = function () { return isRv ? Q.stars > 0 : Q.msg.trim().length >= 3; };
    var send = h('button', { type: 'button', class: 'pill-btn primary fbq-send', disabled: !ready() || state.fbqSending ? true : null }, [state.fbqSending ? 'Sending…' : 'Send']);
    ta.addEventListener('input', function () { Q.msg = ta.value; send.disabled = !ready(); });
    // v4.3: a review, with stars, straight from the Tell us box
    var rvBits = null;
    if (isRv) {
      if (Q.show == null) Q.show = true;
      var nm = h('input', { type: 'text', class: 'fbq-nm', 'data-k': 'fbq-nm', placeholder: 'Name to show, e.g. Sam, Leeds', 'aria-label': 'Name to show' }); nm.value = Q.name || '';
      nm.addEventListener('input', function () { Q.name = nm.value; });
      var ck = h('input', { type: 'checkbox' }); ck.checked = Q.show !== false; ck.addEventListener('change', function () { Q.show = ck.checked; });
      rvBits = [h('div', { class: 'fbq-stars', role: 'radiogroup', 'aria-label': 'Stars' }, [1, 2, 3, 4, 5].map(function (n) {
        return btn('fbq-star' + (n <= (Q.stars || 0) ? ' on' : ''), n + (n === 1 ? ' star' : ' stars'), function () { Q.stars = n; scheduleRender(); }, ['★'], { role: 'radio', 'aria-checked': String(n === Q.stars) }); })),
        null, nm, h('label', { class: 'fbq-ok' }, [ck, h('span', { text: 'PayStamp can show this on its home page' })])];
    }
    send.addEventListener('click', function () {
      if (!ready()) return;
      var msg = Q.msg.trim();
      if (isRv) msg = '★'.repeat(Q.stars) + '☆'.repeat(5 - Q.stars) + ' (' + Q.stars + '/5)\n\n' + (msg || '(no words)') + '\n\nName to show: ' + ((Q.name || '').trim() || '(none)') + '\nOK to show on the home page: ' + (Q.show !== false ? 'YES' : 'no');
      var payload = { kind: k[2], area: isRv ? 'Review' : whereNow(), message: msg, contactOk: true, month: plannerMonthKey(), founder: state.founder.number || null, userAgent: navigator.userAgent, screen: innerWidth + '×' + innerHeight };
      set({ fbqSending: true, fbqErr: null });
      Promise.resolve(P.sendFeedback ? P.sendFeedback(payload) : null).then(function () { state.fbq = { kind: Q.kind, msg: '' }; if (isRv) state.reviewDone = 'sent'; set({ fbqSending: false, fbqSent: true }); },
        function () { set({ fbqSending: false, fbqErr: 'It didn’t send. Check your connection and try again. Your message is still here.' }); });
    });
    return h('div', { class: 'fbq' }, [h('div', { class: 'fbq-p', role: 'dialog', 'aria-label': 'Tell us' }, [
      h('div', { class: 'fbq-h' }, [h('b', { class: 'fbq-t', text: 'Tell us' }), h('small', { class: 'fbq-where', text: 'About: ' + whereNow() })]),
      h('div', { class: 'fbq-k', role: 'group', 'aria-label': 'Type of message' }, FBQ_KINDS.map(function (x) { return btn('fbq-kb ' + x[0] + (x[0] === Q.kind ? ' on' : ''), x[1], function () { Q.kind = x[0]; scheduleRender(); }, [x[1]], { 'aria-pressed': String(x[0] === Q.kind) }); })),
      rvBits ? rvBits[0] : null, ta, rvBits ? rvBits[2] : null, rvBits ? rvBits[3] : null,
      state.fbqErr ? h('p', { class: 'fb-err', role: 'alert', text: state.fbqErr }) : null,
      h('div', { class: 'fbq-f' }, [h('small', { text: 'Goes to the PayStamp team, with the page you’re on.' }), send]) ]), bubble]);
  }
  // Tap or click anywhere outside the Tell us panel (or press Esc) to close it. What you typed is kept.
  document.addEventListener('pointerdown', function (e) {
    if (!state.fbqOpen || !e.target || !e.target.closest) return;
    if (e.target.closest('.fbq') || e.target.closest('.fb-slim')) return;
    set({ fbqOpen: false });
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.fbqOpen) { e.stopPropagation(); set({ fbqOpen: false }); } }, true);
  function openFeedback(area) {
    state.fbFrom = state.overlay; state.fbSent = false; state.fbErr = null;
    if (!state.fbDraft) state.fbDraft = { kind: 'suggestion', message: '', contactOk: true };
    state.fbDraft.area = area || (['debt', 'savings', 'investments'].indexOf(curPage()) > -1 ? curPage() : curPage() === 'history' ? 'records' : 'planner');
    set({ overlay: 'feedback', openMenu: null });
    setTimeout(function () { var t = document.getElementById('f-fb-text'); if (t) t.focus(); }, 60);
  }
  function feedbackBody() {
    var P = window.PayStamp || {};
    if (state.fbSent) {
      return h('div', { class: 'fb-done' }, [
        h('p', { style: 'margin:0', text: 'Your message has been sent. Every message is read, and it really helps shape what comes next.' }),
        P.preview ? h('div', { class: 'pv', text: 'This is the preview, so nothing was actually sent. On paystamp.co.uk it’s saved for you to read.' }) : null,
        h('button', { type: 'button', class: 'fb-send', onclick: function () { set({ overlay: state.fbFrom || null, fbSent: false }); } }, [state.fbFrom ? 'Back' : 'Done']) ]);
    }
    var D = state.fbDraft, kind = FB_KINDS.find(function (k) { return k.key === D.kind; });
    var text = h('textarea', { class: 'fb-text', id: 'f-fb-text', 'data-k': 'fb-text', placeholder: kind.ph, 'aria-label': 'Your message', maxlength: '4000' });
    text.value = D.message;
    var send = h('button', { type: 'button', class: 'fb-send', disabled: D.message.trim().length < 3 || state.fbSending ? true : null }, [state.fbSending ? 'Sending…' : 'Send']);
    text.addEventListener('input', function () { D.message = text.value; send.disabled = D.message.trim().length < 3; });
    var email = P.getEmail ? P.getEmail() : '';
    var reply = h('input', { type: 'checkbox', id: 'f-fb-reply', onchange: function (e) { D.contactOk = e.target.checked; } });
    reply.checked = !!D.contactOk;
    send.addEventListener('click', function () {
      if (D.message.trim().length < 3) return;
      var area = FB_AREAS.find(function (x) { return x.key === D.area; }) || FB_AREAS[0];
      var payload = { kind: D.kind, area: area.label, message: D.message.trim(), contactOk: !!D.contactOk, month: plannerMonthKey(), founder: state.founder.number || null, userAgent: navigator.userAgent, screen: innerWidth + '×' + innerHeight };
      set({ fbSending: true, fbErr: null });
      var go = P.sendFeedback ? P.sendFeedback(payload) : Promise.resolve();
      Promise.resolve(go).then(function () {
        state.fbDraft = { kind: 'suggestion', message: '', contactOk: true, area: D.area };
        set({ fbSending: false, fbSent: true });
      }, function () {
        set({ fbSending: false, fbErr: 'It didn’t send. Check your internet connection and try again. Your message is still here.' });
      });
    });
    return h('div', { class: 'fb-form' }, [
      h('div', { class: 'fb-kind', role: 'group', 'aria-label': 'Type of feedback' }, FB_KINDS.map(function (k) {
        return h('button', { type: 'button', 'aria-pressed': String(k.key === D.kind), onclick: function () { D.kind = k.key; scheduleRender(); } }, [k.label, h('small', { text: k.note })]);
      })),
      h('div', { class: 'fb-area' }, [h('span', { class: 'fb-lbl', id: 'fb-area-lbl', text: 'Where is it?' }),
        h('div', { class: 'fb-chips', role: 'group', 'aria-labelledby': 'fb-area-lbl' }, FB_AREAS.map(function (a) {
          return h('button', { type: 'button', 'aria-pressed': String(a.key === D.area), onclick: function () { D.area = a.key; scheduleRender(); } }, [a.label]);
        })) ]),
      text,
      h('label', { class: 'fb-reply', for: 'f-fb-reply' }, [reply, h('span', { text: email ? 'You can email me about this at ' + email : 'You can email me about this (we’ll use the email you signed in with)' })]),
      state.founder.number ? h('p', { class: 'fb-founder', text: 'Sent as Founding Member #' + state.founder.number + ', so it’s seen first.' }) : null,
      state.fbErr ? h('p', { class: 'fb-err', role: 'alert', text: state.fbErr }) : null,
      h('div', { class: 'fb-foot' }, [h('span', { class: 'fb-note', text: D.kind === 'bug' ? 'Your browser type and screen size are included to help fix it.' : '' }), send]) ]);
  }

  /* ---------- what's new ----------
     Newest first. Add an entry at the top for each release; the banner shows until it's seen. */
  /* What's new: one simple list of everything added in PayStamp 3, grouped by area.
     WN[0].version is what the "New" banner checks, so bump it with each release. */
  var WN = [
    { version: '4.3', date: 'November 2026', title: 'Tools, last month and dated balances', items: [] },
    { version: '4.2', date: 'November 2026', title: 'Couples planner: amounts and money between you', items: [] },
    { version: '4.1', date: 'November 2026', title: 'PayStamp 4.1', items: [] },
    { version: '4.0', date: 'November 2026', title: 'PayStamp 4', items: [] },
    { version: '3.4.2', date: 'October 2026', title: 'Smarter Compass', items: [] },
    { version: '3.4', date: 'October 2026', title: 'Compass and more', items: [] } ];
  // The latest release, shown at the top of What's new. Older releases fold away underneath.
  var WN_LATEST = [{ title: 'New in PayStamp 4.3', items: [
    'Tools (above the planner): a Budgeted / Last month button swaps the first column to what you stamped last month, so you can compare.',
    'With Automation showing, “Out of each bank” lists what leaves each bank account each month. The Automated ticks are easier to see.',
    'A small pie chart at the foot of the % column opens this month’s split in detail.',
    'Type a debt’s monthly payment in the planner or the Debt table.',
    'Balances, savings and investments now have an “as of” date, so PayStamp keeps them up to date from the day you typed them.',
    'Penny is taking a break while we rebuild her.',
    'PayStamp is now completely free: Insights for every month and PayStamp Hustle are open to everyone.',
    'Couples planner and PayStamp Hustle are marked Beta while we keep improving them.' ] },
  { title: 'New in PayStamp 4.2', items: [
    'Couples planner: type what each of you puts in, and the total adds itself up.',
    'Money between you: note what one of you sends the other each month. It shows as Income for the one receiving it and as a Cost for the one sending it.',
    'Reminders on shared costs: set Remind me on a shared line and you both get it.',
    'Change a Budgeted amount and its Automated tick comes off, so you remember to change the standing order too.',
    'The emergency fund reminder above the planner has gone.' ] },
  { title: 'New in PayStamp 4.1', items: [
    'A cleaner planner: softer boxes, a Zero-based balance under your plan and one big Stamp button.',
    'Columns beside your plan, if you want them: each line’s % of pay, Automation (bank, day, automated) and a costs review (✓ keep, ? better deal, ✕ cut) with Remind me dates.',
    'Email reminders: tick Payday and Review dates above your planner.',
    'Investments, Savings, Debt and everything under More now open on top of your planner.',
    'What if: investments now show a line or bar chart year by year, and a new savings goal can go straight into your plan.',
    'Insights shows where your overall worth is heading. Records lines are coloured by category.',
    'Couples planner: three boxes like the planner, and you type what each of you puts in.',
    'Pick your currency at the top of the planner, including No symbol. Compass has been retired; its tools now live beside your plan.',
    'PayStamp opens much faster with no signal.' ] },
  { title: 'New in PayStamp 4', items: [
    'A new look. Every section is now a full page of its own, and the planner is cleaner and quicker to read.',
    'Your year at a glance: each month you stamp is inked in above your planner. Tap any month to open it.',
    'One bar shows how this month’s pay is split and what’s left. Tap Give it a job for ideas on where it could go.',
    'Stamp a month and you get a short review of how it compared with the one before.',
    'Insights (under More): your stamped months as charts, and a line-by-line table of what’s changing. Your last three months are free.',
    'Sums in any amount box: type 45+12, 1200/12 or 10% (of your pay) and it’s worked out for you.',
    'Search everything: press Ctrl + K, or tap the magnifying glass, to jump to any page or line or run a quick job.',
    'Undo and redo with Ctrl + Z and Ctrl + Shift + Z. Enter moves down a column, like a spreadsheet.',
    'Couples planner, PayStamp Hustle and Penny, your AI helper, with three free questions to try her.',
    'PayStamp Pro: try it free for 14 days with no card, then £1.99 a month or £19.99 a year. Everything that was free stays free.' ] },
  { title: 'New in 3.4.2', items: [
    'Tell us: the small speech bubble in the corner of every page. Pick Bug, Idea or Feedback and type a quick message. It notes which page you’re on for you.',
    'Automation: your month day by day, from payday to payday. It spots a bill that leaves before the money arrives, and gives you the standing orders to set up, ready to copy.',
    'Debt: your debt-free journey, with a bar for each debt showing when it clears, what your debt costs a day, and lots of ways to find extra money for it.',
    'Costs and sinking funds: go through every cost in one list. Mark each as a fixed cost, subscription or sinking fund, decide Need it, Better deal? or Cut it, and ask for an email reminder before a contract ends.',
    'Check-ups: go through one, two or three Compass topics a month, or more spread over the year. Topics due a check-up are marked in the Compass menu. Set it up in your Notebook.',
    'Halfway email: a second short email two weeks before payday, so you can plan next month ahead. Turn it on in your Notebook.',
    'Emergency fund: a reminder to fill it first, and a way to compare easy-access accounts to keep it in.',
    'Credit building: your full report date, your cards with their type and perks, and a checklist to make your score stronger.',
    'Percentages show the pound amounts as well, and your What if numbers are kept for next time.' ] },
  { title: 'New in 3.4', items: [
    'Compass: open it from the plum bar. 9 topics, each with a short lesson, a working part built from your plan, a checklist and a yearly check-up: Percentages, Emergency fund and safety net, Debt, Investing, Saving for goals, Costs and sinking funds, Automation, Credit building and Pensions.',
    'Your Notebook (top of the Compass menu): your checklist, notes and this month’s check-up in one place.',
    'A payday email: a reminder to enter your pay, check your plan and stamp, plus your checklist, notes and this month’s Compass topic if you want them. Turn it on in your Notebook.',
    'Your name and payday: PayStamp says hello and counts down to payday. Paid on a set weekday, every few weeks or at different times? Choose how you’re paid under your badge › Your details.',
    'Accounts in other currencies, and pay into more than one account: PayStamp shows what actually needs moving between your accounts.',
    'Share cards: share a stamped month, a milestone or your year as a picture, with percentages only unless you choose to show amounts.',
    'Tools to compare savings rates, brokers and funds (with their fees), and a review of every cost you pay.',
    'The PayStamp app: put PayStamp on your home screen so it opens like an app. See your badge › Get the app.',
    'Your data: download everything in your plan, or delete your account, from your badge › Your details. Plus a plain-English privacy page.',
    'Shape PayStamp: quick questions, ideas and bug reports, straight to the founder.' ] }];
  var WN_SECTIONS = [
    { icon: 'debt', title: 'Debt', items: [
      'Every debt in one place: balance, interest, minimum and what you pay each month.',
      'Your debt-free date, worked out from your plan and updated each time you stamp.',
      'Pay off in your own order, smallest first (Snowball) or highest interest first (Avalanche).',
      'What if Calculator: see how much sooner you’re debt-free if you pay a bit more.' ] },
    { icon: 'savings', title: 'Savings', items: [
      'Pots for everything you’re saving towards, each with a goal and an interest rate.',
      'A ready-by date for each pot. Tap one to see what’s left and how to get there sooner.',
      'Emergency fund tracking, with a starter £1,000 milestone.',
      'What if Calculator: what to save each month to reach a goal by a date.' ] },
    { icon: 'investments', title: 'Investments', items: [
      'What you’ve put in, what it’s worth now and how much it’s grown.',
      'Mark your ISAs, and get a nudge when a value needs updating.',
      'What if Calculator: see what an investment could grow to.' ] },
    { icon: 'plan', title: 'Monthly Planner', items: [
      'Budgeted and This Month for every line: your plan, and what’s actually happening.',
      'The Extras box works out what to send by hand, with a Sent tick for each.',
      'Totals, what’s left to allocate and how much goes to each bank account.',
      'Debt, Savings and Investments link straight into your plan.',
      'Amounts shown as money, your own currency symbol, payment days and Undo.' ] },
    { icon: 'history', title: 'Stamping and Records', items: [
      'A quick check before you stamp, and stamped months turn green.',
      'Records as one table, month by month, showing what changed.',
      'Save your Records to Excel, one file per year.',
      'Collect milestone stamps, and the first 100 people become numbered founders.' ] },
    { icon: 'help', title: 'Getting started', items: [
      'Set up your own plan in four quick steps, or explore an example month first.',
      'One simple menu: Debt, Savings, Investments and Records along the top, Compass for everything else.',
      'Send ideas or report a problem from Suggestions on any page.' ] } ];

  /* =====================================================================
     THE FOUNDING 100
     state.founder (preview; on the live site this comes from the Supabase profile):
       { number, name, elite, eliteNumber, joined, code, placesLeft, eliteTaken }
     - Stamping a first real month quietly claims the next number (1–100). Rules are hidden.
     - Everyone has one personal invite link, shared as often as they like.
     - Elite: 3 people who joined through your link become founders. Own numbering from #1.
     ===================================================================== */
  var SITE = 'https://paystamp.co.uk';
  function inviteLink() { return SITE + '/?invite=' + state.founder.code; }
  function inviteMessage() {
    var F = state.founder, who = F.name || 'A friend';
    if (F.placesLeft > 0) return who + ' has saved you a founder place on PayStamp, a simple way to give every pound of your pay a job. Only ' + F.placesLeft + ' of the first 100 places are left. Plan your month and stamp it to claim your founder number: ' + inviteLink();
    return who + ' thinks you’d like PayStamp, a simple way to give every pound of your pay a job: ' + inviteLink();
  }
  function realMonthCheck() {
    var t = totals(), defs = defaultGroups(), base = {};
    defs.forEach(function (g) { if (g.key === 'income') return; g.categories.forEach(function (c) { c.items.forEach(function (it) { base[it.id] = (it.label || '') + '|' + amt(it.budgeted); }); }); });
    base['dbt_debt1'] = 'Credit card|150';
    var seen = {}, changes = 0;
    state.groups.forEach(function (g) { if (g.key === 'income') return; g.categories.forEach(function (c) { c.items.forEach(function (it) {
      seen[it.id] = 1;
      if (base[it.id] == null || base[it.id] !== (it.label || '') + '|' + amt(it.budgeted)) changes++;
    }); }); });
    Object.keys(base).forEach(function (id) { if (!seen[id]) changes++; });
    return { ok: t.income > 0 && Math.abs(t.income - 1900) > 0.005 && Math.abs(t.income - 2050) > 0.005 && changes >= 3 && Math.abs(t.zero) < 0.01 };
  }
  function claimFounder(label) {
    var F = state.founder, P = window.PayStamp || {};
    if (P.claimFounder) {
      // Live site: the database hands out the next number, so two people can never share one.
      P.claimFounder(label).then(function (nf) {
        var name = F.name;
        if (nf) Object.assign(F, nf, { name: name });
        if (F.number) { state.stampAnim = true; set({ overlay: 'founderWelcome' }); }
        else afterStamp(label);
      }, function () { afterStamp(label); });
      return;
    }
    F.number = 100 - F.placesLeft + 1; F.placesLeft -= 1; F.since = label;
    state.stampAnim = true; state.overlay = 'founderWelcome';
  }
  // If no founder place came through, carry on as a normal stamp.
  function afterStamp(label) {
    if ((state.pendingStamps || []).length) { set({ overlay: 'newStamps' }); return; }
    set({ stampFlash: true, stampFlashLabel: label });
    clearTimeout(stampMonth.t);
    stampMonth.t = setTimeout(function () { state.stampFlash = false; scheduleRender(); }, 3200);
  }

  /* ---------- stamps ---------- */
  var stampSeq = 0;
  /* One stamp design: a solid coloured ring with white writing, a tinted centre and a symbol. */
  var STAMP = {
    founder:   { ring: '#C9A23A', edge: '#B8902A', tint: '#FFF4D6', ink: '#8A6400', text: 'FOUNDING MEMBER • THE 100 • ' },
    elite:     { ring: '#16131C', edge: '#D4AF37', tint: '#D4AF37', ink: '#16131C', text: 'ELITE FOUNDER ★ PAYSTAMP ★ ', textInk: '#E8C96A', elite: true },
    efund1k:   { ring: '#2F8F5B', tint: '#E4F3EA', ink: '#1D6B43', text: 'EMERGENCY FUND • £1,000 • ', name: '£1,000 emergency fund' },
    automated: { ring: '#7E2A55', tint: '#F5E7EE', ink: '#7E2A55', text: 'AUTOMATED • PAYMENTS • ', name: 'Automated payments' },
    halfway:   { ring: '#C2483D', tint: '#FBE9E7', ink: '#C2483D', text: 'DEBT CRUSHER • HALFWAY • ', name: 'Debt crusher: halfway' },
    debtfree:  { ring: '#A8342B', tint: '#FBE9E7', ink: '#A8342B', text: 'DEBT FREE • DEBT FREE • ', name: 'Debt-free' },
    isa:       { ring: '#1F6F8B', tint: '#E3F0F5', ink: '#1F6F8B', text: 'ISA INVESTOR • GROWING • ', name: 'ISA investor' },
    efund3:    { ring: '#2F8F5B', tint: '#E4F3EA', ink: '#1D6B43', text: 'EMERGENCY FUND • 3 MONTHS • ', name: '3-month emergency fund' },
    efund6:    { ring: '#165A37', tint: '#DCEFE3', ink: '#165A37', text: 'EMERGENCY FUND • 6 MONTHS • ', name: '6-month emergency fund' },
    first:     { ring: '#7E2A55', tint: '#F5E7EE', ink: '#7E2A55', text: 'FIRST STAMP • PAYSTAMP • ', name: 'First stamp' },
    streak3:   { ring: '#5A5FB0', tint: '#ECEDF8', ink: '#5A5FB0', text: '3 MONTHS • IN A ROW • ', name: '3 months in a row' },
    streak6:   { ring: '#43479A', tint: '#E7E8F5', ink: '#43479A', text: '6 MONTHS • IN A ROW • ', name: '6 months in a row' },
    streak12:  { ring: '#2E3180', tint: '#E2E3F2', ink: '#2E3180', text: 'ONE YEAR • 12 MONTHS • ', name: 'A full year in a row' },
    goal:      { ring: '#D9822B', tint: '#FCEFE1', ink: '#D9822B', text: 'SAVINGS GOAL • REACHED • ', name: 'Savings goal reached' } };
  var stampSeq = 0;
  function stampSVG(key, num) {
    var c = STAMP[key], id = 'stp' + (++stampSeq), ink = c.ink, mid = '';
    if (key === 'founder') mid = '<text x="50" y="57" text-anchor="middle" fill="' + ink + '" font-family="Besley,Georgia,serif" font-size="' + (num > 99 ? 16 : 20) + '">#' + num + '</text>';
    if (key === 'elite') mid = '<circle cx="50" cy="50" r="23.5" fill="none" stroke="#8A6400" stroke-width="3" stroke-dasharray="1 2.6" opacity=".55"/><polygon points="50,34 52.3,39 57.6,39.4 53.5,42.8 54.8,48 50,45.2 45.2,48 46.5,42.8 42.4,39.4 47.7,39" fill="#16131C"/><text x="50" y="66" text-anchor="middle" fill="#16131C" font-family="Besley,Georgia,serif" font-size="17">#' + num + '</text>';
    if (key === 'efund1k') mid = '<text x="50" y="57" text-anchor="middle" fill="' + ink + '" font-family="Besley,Georgia,serif" font-size="20">£1k</text>';
    if (key === 'automated') mid = '<circle cx="50" cy="50" r="11" fill="none" stroke="' + ink + '" stroke-width="2.8" stroke-dasharray="26 8.5"/><polygon points="39.4,55 40.4,61 45.4,56" fill="' + ink + '"/><polygon points="60.6,45 59.6,39 54.6,44" fill="' + ink + '"/>';
    if (key === 'halfway') mid = '<circle cx="50" cy="50" r="12" fill="none" stroke="' + ink + '" stroke-width="2.6"/><path d="M50 38 a12 12 0 0 1 0 24 z" fill="' + ink + '"/>';
    if (key === 'debtfree') mid = '<rect x="35.5" y="51.6" width="14" height="3.8" rx="1.9" fill="' + ink + '" transform="rotate(45 42.5 53.5)"/><rect x="41.3" y="48.6" width="26" height="3.8" rx="1.9" fill="' + ink + '" transform="rotate(-48 54.3 50.5)"/>';
    if (key === 'isa') mid = '<rect x="37" y="52" width="6" height="10" rx="1.5" fill="' + ink + '"/><rect x="47" y="45" width="6" height="17" rx="1.5" fill="' + ink + '"/><rect x="57" y="37" width="6" height="25" rx="1.5" fill="' + ink + '"/>';
    if (key === 'efund3' || key === 'efund6') mid = '<text x="50" y="50" text-anchor="middle" fill="' + ink + '" font-family="Besley,Georgia,serif" font-size="22">' + (key === 'efund3' ? '3' : '6') + '</text><text x="50" y="63" text-anchor="middle" fill="' + ink + '" font-family="Hanken Grotesk,system-ui,sans-serif" font-size="9.5" font-weight="700">MONTHS</text>';
    if (key === 'first') mid = '<text x="50" y="57" text-anchor="middle" fill="' + ink + '" font-family="Besley,Georgia,serif" font-size="20">1st</text>';
    if (key === 'streak3' || key === 'streak6' || key === 'streak12') mid = '<rect x="36" y="38" width="28" height="25" rx="3.5" fill="#fff" stroke="' + ink + '" stroke-width="2.4"/><rect x="36" y="38" width="28" height="7" rx="2" fill="' + ink + '"/><rect x="41" y="34" width="3" height="7" rx="1.5" fill="' + ink + '"/><rect x="56" y="34" width="3" height="7" rx="1.5" fill="' + ink + '"/><text x="50" y="60" text-anchor="middle" fill="' + ink + '" font-family="Hanken Grotesk,system-ui,sans-serif" font-size="13" font-weight="700">' + key.slice(6) + '</text>';
    if (key === 'goal') mid = '<circle cx="50" cy="50" r="13" fill="none" stroke="' + ink + '" stroke-width="2.4"/><circle cx="50" cy="50" r="7.5" fill="none" stroke="' + ink + '" stroke-width="2.4"/><circle cx="50" cy="50" r="3" fill="' + ink + '"/>';
    return '<svg viewBox="0 0 100 100" aria-hidden="true"><defs><path id="' + id + '" d="M19 50 a31 31 0 1 1 62 0 a31 31 0 1 1 -62 0"/></defs>' +
      '<circle cx="50" cy="50" r="48" fill="none" stroke="' + (c.edge || c.ring) + '" stroke-width="' + (c.elite ? 2.5 : 1.5) + '"/><circle cx="50" cy="50" r="45" fill="' + c.ring + '"/>' +
      '<circle cx="50" cy="50" r="27" fill="' + c.tint + '" stroke="' + (c.elite ? '#8A6400' : '#fff') + '" stroke-width="' + (c.elite ? 1.5 : 2.5) + '"/>' +
      '<text fill="' + (c.textInk || '#fff') + '" font-family="Hanken Grotesk,system-ui,sans-serif" font-size="11" font-weight="700"><textPath href="#' + id + '" textLength="192" lengthAdjust="spacing">' + c.text + '</textPath></text>' + mid + '</svg>';
  }
  function founderStampSVG(num) { return stampSVG('founder', num); }
  function eliteSealSVG(num) { return stampSVG('elite', num); }

  /* ---------- milestones ----------
     Awarded when a real month is stamped. Shown in the order earned (after the founder stamps).
     If the condition stops being true, the stamp fades; it comes back when it's true again. */
  /* Example figures never earn a stamp. An example entry counts as the person's own once they type their own
     figure into it (savings: amount saved; debts: balance; investments: monthly amount; planner rows:
     name or amount). Renaming alone isn't enough, because the figure would still be the example's. Until then it's left out of every stamp check. */
  var countExamples = false;   // only switched on inside dropExampleStamps(), to see what the old rules gave
  function byId(list, id) { return list.filter(function (x) { return x.id === id; })[0]; }
  function exampleSaving(sv) { var e = byId(defaultSavings(), sv.id); return !countExamples && !!e && amt(sv.saved) === amt(e.saved); }
  function exampleDebt(d) { var e = byId(defaultDebts(), d.id); return !countExamples && !!e && amt(d.balance) === amt(e.balance); }
  function exampleInvestment(iv) { var e = byId(defaultInvestments(), iv.id); return !countExamples && !!e && amt(iv.monthly) === amt(e.monthly); }
  function exampleItem(it) {
    if (countExamples) return false;
    var base = null;
    defaultGroups().forEach(function (g) { g.categories.forEach(function (c) { c.items.forEach(function (x) { if (x.id === it.id) base = x; }); }); });
    if (it.id === 'dbt_debt1') base = { label: 'Credit card', budgeted: '150' };
    return !!base && (it.label || '') === base.label && amt(it.budgeted) === amt(base.budgeted);
  }
  function ownSavings() { return state.savings.filter(function (sv) { return !exampleSaving(sv); }); }
  function ownDebts() { return state.debts.filter(function (d) { return !exampleDebt(d); }); }
  function costsTotal() { var g = findGroup('costs'); return g ? groupSum(g, 'budgeted') : 0; }
  function efundSaved(id) { var sv = id && findSaving(id); return sv && !exampleSaving(sv) ? savedNow(sv) : 0; }
  function totalDebtStart() { return ownDebts().reduce(function (t, d) { return t + amt(d.balance); }, 0); }
  function isaInvs() { return state.investments.filter(function (iv) { return iv.isa && !exampleInvestment(iv); }); }
  // Months stamped in a row, counting back from the most recent stamped month.
  function streakLen() {
    var idx = state.records.map(function (r) { return Number(r.year) * 12 + MONTHS.indexOf(r.month); }).sort(function (a, b) { return b - a; });
    if (!idx.length) return 0;
    var n = 1; for (var i = 1; i < idx.length; i++) { if (idx[i] === idx[i - 1] - 1) n++; else if (idx[i] !== idx[i - 1]) break; }
    return n;
  }
  var MILESTONES = [
    { key: 'first', permanent: true, check: function () { return true; } },
    { key: 'streak3', permanent: true, check: function () { return streakLen() >= 3; } },
    { key: 'streak6', permanent: true, check: function () { return streakLen() >= 6; } },
    { key: 'streak12', permanent: true, check: function () { return streakLen() >= 12; } },
    { key: 'goal', permanent: true, check: function () { return ownSavings().some(function (sv) { return amt(sv.goal) > 0 && savedNow(sv) >= amt(sv.goal); }); } },
    { key: 'efund1k', check: function () { return efundSaved(state.efundStarter) >= 1000; }, lost: 'Your £1,000 fund is below £1,000.', how: 'Mark your starter emergency fund on the Savings page and save £1,000 into it.' },
    // The example rows come ticked, so a row still showing its example name and amount holds this back.
    { key: 'automated', check: function () { var n = 0, all = true; state.groups.forEach(function (g) { if (g.key === 'income') return; g.categories.forEach(function (c) { c.items.forEach(function (it) { n++; if (!it.automated || exampleItem(it)) all = false; }); }); }); return n > 0 && all; }, lost: 'Not every payment is automated right now.' },
    { key: 'halfway', check: function () { var tot = totalDebtStart(); if (!tot) return false; var paid = ownDebts().reduce(function (t, d) { return t + Math.min(debtPaid(d).paid, amt(d.balance)); }, 0); return paid >= tot / 2; }, lost: 'Less than half your debt is paid off right now.', earnOnly: function () { return totalDebtStart() > 0; } },
    { key: 'debtfree', check: function () { return state.debts.every(function (d) { return !exampleDebt(d) && debtLeft(d) <= 0.005; }); }, lost: 'You have debt again. Clear it to bring this back.' },
    { key: 'isa', check: function () { return isaInvs().some(function (iv) { return amt(invMonthly(iv)) > 0; }); }, earn: function (rec) { var ids = isaInvs().map(function (iv) { return iv.id; }); return (rec.items || []).some(function (it) { return it.investmentId && ids.indexOf(it.investmentId) > -1 && it.value > 0; }); }, lost: 'Nothing is going into an ISA right now.' },
    { key: 'efund3', check: function () { var c = costsTotal(); return !!state.efundMain && c > 0 && efundSaved(state.efundMain) >= 3 * c; }, lost: 'Your emergency fund is below 3 months of costs.' },
    { key: 'efund6', check: function () { var c = costsTotal(); return !!state.efundMain && c > 0 && efundSaved(state.efundMain) >= 6 * c; }, lost: 'Your emergency fund is below 6 months of costs.' } ];
  // Takes away any stamp that was only earned because of example figures (true under the old rules,
  // false now). Stamps that are genuinely lost stay, faded, as before. Returns true if anything changed.
  function dropExampleStamps() {
    var changed = false, ms = state.milestones || {};
    MILESTONES.forEach(function (m) {
      if (!ms[m.key] || m.key === 'first' || /^streak/.test(m.key)) return;
      var now = m.check(); if (now) return;
      countExamples = true; var before; try { before = m.check(); } finally { countExamples = false; }
      if (before) { delete ms[m.key]; changed = true; }
    });
    return changed;
  }
  function awardMilestones(label) {
    if (!state.realStamped) return [];
    var rec = state.records[state.records.length - 1], fresh = [];
    MILESTONES.forEach(function (m) {
      if (state.milestones[m.key]) return;
      if (m.earnOnly && !m.earnOnly()) return;
      if (m.earn ? m.earn(rec) : m.check()) { state.milestones[m.key] = { at: Date.now(), label: label }; fresh.push(m.key); }
    });
    if (fresh.length) state.animStamps = fresh.slice();
    return fresh;
  }
  function stampButton(key, num, tip, faded) {
    var anim = (key === 'founder' && state.stampAnim) || (state.animStamps || []).indexOf(key) > -1;
    var b = h('button', { type: 'button', class: 'ms' + (faded ? ' faded' : '') + (anim ? ' anim' : ''), 'data-tip': tip, 'aria-label': tip, html: stampSVG(key, num) });
    b.addEventListener('click', function () { b.classList.toggle('tip-on'); setTimeout(function () { b.classList.remove('tip-on'); }, 2500); });
    return b;
  }
  function stampRow() {
    var F = state.founder, kids = [];
    if (F.number) kids.push(stampButton('founder', F.number, 'Founding Member #' + F.number + (F.since ? ' · since ' + F.since : '')));
    if (F.number && F.elite) kids.push(stampButton('elite', F.eliteNumber, 'Elite Founding Member #' + F.eliteNumber + (F.eliteSince ? ' · since ' + F.eliteSince : '')));
    MILESTONES.filter(function (m) { return state.milestones[m.key]; })
      .sort(function (a, b) { return state.milestones[a.key].at - state.milestones[b.key].at; })
      .forEach(function (m) {
        var on = m.permanent || m.check(), e = state.milestones[m.key];
        kids.push(stampButton(m.key, null, STAMP[m.key].name + ' · earned ' + e.label + (on ? '' : '. ' + m.lost), !on));
      });
    // Up to 7 sit side by side; more than that overlap neatly (sooner on phones).
    if (!kids.length) return null;
    var n = kids.length, phone = innerWidth <= 640, size = phone ? 46 : 52, room = Math.min(innerWidth - 32, 640);
    var stack = n > (phone ? 5 : 7), ov = 0;
    if (stack) ov = Math.max(16, Math.ceil((n * size - room) / (n - 1)));
    var r = h('div', { class: 'stamp-row' + (stack ? ' stack' : '') }, kids);
    r.style.setProperty('--ov', ov + 'px');
    return r;
  }

  /* ---------- v3.4: share cards ----------
     A picture people can post: a milestone, a stamped month, or their year. Drawn in the browser on a
     canvas (nothing is sent anywhere), with the PayStamp mark and the person's own invite link.
     By default a card shows percentages and streaks only, never amounts. On a phone, Share opens the
     share sheet (Instagram, WhatsApp...). Elsewhere it downloads, and the picture can be pressed and saved. */
  var SHARE_W = 1080, SHARE_H = 1350, shareCache = {}, shareCanvas = null;
  var SHARE_COPY = {
    first: ['My first month, stamped.', 'I’ve started planning every pay.'],
    streak3: ['3 months in a row.', 'Three months of planning every pay, without missing one.'],
    streak6: ['6 months in a row.', 'Half a year of planning every pay.'],
    streak12: ['12 months stamped.', 'A whole year of planning every pay, without missing one.'],
    goal: ['Savings goal reached.', 'Saved up for it, month by month.'],
    efund1k: ['£1,000 emergency fund.', 'Put away for the unexpected.'],
    efund3: ['Emergency fund: 3 months.', 'Three months of costs, put away for the unexpected.'],
    efund6: ['Emergency fund: 6 months.', 'Six months of costs, put away for the unexpected.'],
    automated: ['All on autopilot.', 'Every payment now moves by itself on payday.'],
    halfway: ['Halfway there.', 'Half my debt is paid off.'],
    debtfree: ['Debt-free.', 'Every debt paid off.'],
    isa: ['Investing every month.', 'Money going into my ISA, month after month.'] };
  var WIN_ORDER = ['debtfree', 'efund6', 'efund3', 'streak12', 'goal', 'halfway', 'efund1k', 'isa', 'automated', 'streak6', 'streak3', 'first'];
  function shareLinkText() { var c = state.founder && state.founder.code; return 'paystamp.co.uk' + (c ? '/?invite=' + c : ''); }
  function shareUrl() { return state.founder && state.founder.code ? inviteLink() : SITE; }
  function recStats(r) {
    var cg = findGroup('costs'), ct = cg ? cg.title : 'Costs', o = { income: Number(r.incomeTotal) || 0, saved: 0, invested: 0, costs: 0, debt: 0 };
    (r.items || []).forEach(function (it) {
      var v = Number(it.value) || 0;
      if (it.savingId) o.saved += v; else if (it.investmentId) o.invested += v;
      if (it.debtId) o.debt += v;
      if ((it.groupTitle || '') === ct) o.costs += v;
    });
    return o;
  }
  function pctN(a, b) { return b > 0 ? Math.round(a / b * 100) : 0; }
  function automatedPct() {
    var n = 0, a = 0;
    state.groups.forEach(function (g) { if (g.key === 'income') return; g.categories.forEach(function (c) { c.items.forEach(function (it) { if (amt(it.budgeted) > 0) { n++; if (it.automated) a++; } }); }); });
    return pctN(a, n);
  }
  function streakAt(month, year) {
    var have = {}; state.records.forEach(function (r) { have[Number(r.year) * 12 + MONTHS.indexOf(r.month)] = 1; });
    var i = Number(year) * 12 + MONTHS.indexOf(month), n = 0; while (have[i]) { n++; i--; } return n;
  }
  function yearRecs(y) { return state.records.filter(function (r) { return String(r.year) === String(y); }); }
  function yearWin(y) {
    var ms = state.milestones || {};
    var k = WIN_ORDER.find(function (key) { return ms[key] && String(ms[key].label || '').indexOf(String(y)) > -1; });
    return k ? STAMP[k].name : null;
  }
  function shareKey(sp) { return [sp.kind, sp.key || '', sp.month || '', sp.year || '', state.shareAmounts ? 1 : 0, shareLinkText()].join('|'); }
  function shareTitle(sp) {
    if (sp.kind === 'milestone') return STAMP[sp.key] ? STAMP[sp.key].name : 'Your stamp';
    if (sp.kind === 'year') return 'Your ' + sp.year + ', stamped';
    return sp.month + ' ' + sp.year + ' is stamped';
  }
  function openShare(sp) { state.pendingStamps = []; set({ overlay: 'share', shareSpec: sp, shareAmounts: false, shareMsg: '' }); }

  // drawing helpers
  function cRound(x, c, X, Y, W, H, r) { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r); x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r); x.closePath(); }
  function cWrap(x, text, cx, y, maxW, lh, align) {
    var words = String(text).split(' '), line = '', lines = [];
    words.forEach(function (w) { var t = line ? line + ' ' + w : w; if (x.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; });
    if (line) lines.push(line);
    x.textAlign = align || 'center';
    lines.forEach(function (l, i) { x.fillText(l, cx, y + i * lh); });
    return y + (lines.length - 1) * lh;
  }
  function cPill(x, text, cx, y, bg, fg, size) {
    x.font = '700 ' + size + 'px "Hanken Grotesk", system-ui, sans-serif';
    var w = x.measureText(text).width + size * 1.4, hgt = size * 2;
    x.fillStyle = bg; cRound(x, null, cx - w / 2, y, w, hgt, hgt / 2); x.fill();
    x.fillStyle = fg; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, cx, y + hgt / 2 + 1); x.textBaseline = 'alphabetic';
    return w;
  }
  function svgImg(svg, size) {
    var src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('<svg viewBox', '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox'));
    return new Promise(function (res) { var im = new Image(); im.onload = function () { res(im); }; im.onerror = function () { res(null); }; im.src = src; });
  }
  function shareFonts() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    return Promise.all(['400 80px "Besley"', '700 40px "Hanken Grotesk"', '400 40px "Hanken Grotesk"'].map(function (f) { return document.fonts.load(f).catch(function () {}); })).catch(function () {});
  }
  function cFoot(x, light) {
    x.font = '400 36px "Hanken Grotesk", system-ui, sans-serif'; x.fillStyle = light ? '#4A4356' : 'rgba(255,255,255,.88)'; x.textAlign = 'center';
    x.fillText('Plan your pay. Stamp your month.', SHARE_W / 2, SHARE_H - 148);
    cPill(x, shareLinkText(), SHARE_W / 2, SHARE_H - 116, light ? '#7E2A55' : '#FFFFFF', light ? '#FFFFFF' : '#7E2A55', 36);
  }
  function cBrand(x, color, tag) {
    x.font = '400 66px "Besley", Georgia, serif'; x.fillStyle = color; x.textAlign = 'left'; x.fillText('PayStamp', 80, 140);
    if (tag) { x.font = '700 26px "Hanken Grotesk", system-ui, sans-serif'; var w = x.measureText(tag).width + 44; x.strokeStyle = color; x.lineWidth = 3; x.globalAlpha = .7; cRound(x, null, SHARE_W - 80 - w, 92, w, 60, 30); x.stroke(); x.globalAlpha = 1; x.fillStyle = color; x.textAlign = 'center'; x.fillText(tag, SHARE_W - 80 - w / 2, 132); }
  }
  function renderShare(sp) {
    return shareFonts().then(function () {
      var cv = document.createElement('canvas'); cv.width = SHARE_W; cv.height = SHARE_H;
      var x = cv.getContext('2d'), amounts = !!state.shareAmounts;
      if (sp.kind === 'milestone') {
        var st = STAMP[sp.key] || STAMP.first, cp = SHARE_COPY[sp.key] || ['New stamp.', ''], e = (state.milestones || {})[sp.key];
        x.fillStyle = st.ink; x.fillRect(0, 0, SHARE_W, SHARE_H);
        x.fillStyle = 'rgba(255,255,255,.07)'; x.beginPath(); x.arc(SHARE_W - 60, 260, 300, 0, Math.PI * 2); x.fill();
        cBrand(x, '#FFFFFF', 'MILESTONE');
        return svgImg(stampSVG(sp.key), 440).then(function (im) {
          x.fillStyle = '#FFFFFF'; x.beginPath(); x.arc(SHARE_W / 2, 500, 255, 0, Math.PI * 2); x.fill();
          if (im) x.drawImage(im, SHARE_W / 2 - 220, 280, 440, 440);
          x.fillStyle = '#FFFFFF'; x.font = '400 104px "Besley", Georgia, serif';
          var y = cWrap(x, cp[0].replace(/£/g, cur()), SHARE_W / 2, 880, 900, 108);
          x.font = '400 40px "Hanken Grotesk", system-ui, sans-serif'; x.fillStyle = 'rgba(255,255,255,.9)';
          y = cWrap(x, cp[1], SHARE_W / 2, y + 76, 860, 52);
          if (e && e.label) { x.font = '700 30px "Hanken Grotesk", system-ui, sans-serif'; x.fillStyle = 'rgba(255,255,255,.75)'; x.fillText('EARNED ' + String(e.label).toUpperCase(), SHARE_W / 2, y + 70); }
          cFoot(x, false); return cv;
        });
      }
      if (sp.kind === 'month') {
        var r = state.records.find(function (q) { return q.month === sp.month && String(q.year) === String(sp.year); }) || { items: [] };
        var S = recStats(r), sk = streakAt(sp.month, sp.year);
        x.fillStyle = '#7E2A55'; x.fillRect(0, 0, SHARE_W, SHARE_H);
        cBrand(x, '#FFFFFF', 'MY MONEY');
        // the stamp: white, perforated, a little crooked
        x.save(); x.translate(SHARE_W / 2, 472); x.rotate(-3 * Math.PI / 180);
        var W = 600, H = 560; x.fillStyle = '#FFFFFF'; x.fillRect(-W / 2, -H / 2, W, H);
        x.fillStyle = '#7E2A55';
        for (var px = -W / 2; px <= W / 2 + 1; px += 40) { x.beginPath(); x.arc(px, -H / 2, 13, 0, Math.PI * 2); x.arc(px, H / 2, 13, 0, Math.PI * 2); x.fill(); }
        for (var py = -H / 2; py <= H / 2 + 1; py += 40) { x.beginPath(); x.arc(-W / 2, py, 13, 0, Math.PI * 2); x.arc(W / 2, py, 13, 0, Math.PI * 2); x.fill(); }
        x.fillStyle = '#7E2A55'; x.font = '700 32px "Hanken Grotesk", system-ui, sans-serif'; x.textAlign = 'center';
        x.fillText((sp.month + ' ' + sp.year).toUpperCase().split('').join(String.fromCharCode(8202)), 0, -H / 2 + 80);
        x.strokeStyle = '#1E6B47'; x.lineWidth = 7; x.beginPath(); x.arc(0, -30, 118, 0, Math.PI * 2); x.stroke();
        x.lineWidth = 3; x.setLineDash([8, 8]); x.beginPath(); x.arc(0, -30, 96, 0, Math.PI * 2); x.stroke(); x.setLineDash([]);
        x.lineWidth = 16; x.lineCap = 'round'; x.lineJoin = 'round'; x.beginPath(); x.moveTo(-42, -28); x.lineTo(-12, 4); x.lineTo(50, -64); x.stroke();
        x.fillStyle = '#1E6B47'; x.font = '400 84px "Besley", Georgia, serif'; x.fillText('Stamped', 0, 168);
        x.fillStyle = '#4A4356'; x.font = '700 36px "Hanken Grotesk", system-ui, sans-serif'; x.fillText(sk > 1 ? sk + ' months in a row' : 'Planned and stamped', 0, 222);
        x.restore();
        var tiles = amounts
          ? [[money(Math.round(S.saved)), 'saved'], [money(Math.round(S.invested)), 'invested'], [money(Math.round(S.debt)), 'off debt'], [automatedPct() + '%', 'automated']]
          : [[pctN(S.saved, S.income) + '%', 'of pay saved'], [pctN(S.invested, S.income) + '%', 'of pay invested'], [pctN(S.costs, S.income) + '%', 'on costs'], [automatedPct() + '%', 'automated']];
        tiles.forEach(function (t, i) {
          var tx = 80 + (i % 2) * 470, ty = 800 + Math.floor(i / 2) * 160;
          x.fillStyle = '#9A4A73'; cRound(x, null, tx, ty, 450, 144, 26); x.fill();
          x.fillStyle = '#FFFFFF'; x.textAlign = 'left'; x.font = '700 64px "Hanken Grotesk", system-ui, sans-serif'; x.fillText(curText(t[0]), tx + 32, ty + 80);
          x.fillStyle = 'rgba(255,255,255,.85)'; x.font = '400 32px "Hanken Grotesk", system-ui, sans-serif'; x.fillText(t[1], tx + 32, ty + 124);
        });
        cFoot(x, false); return Promise.resolve(cv);
      }
      // the year
      var Y = String(sp.year), recs = yearRecs(Y), have = {}; recs.forEach(function (q) { have[q.month] = 1; });
      var tot = { income: 0, saved: 0, invested: 0, debt: 0 }; recs.forEach(function (q) { var o = recStats(q); tot.income += o.income; tot.saved += o.saved; tot.invested += o.invested; tot.debt += o.debt; });
      var leftNow = state.debts.reduce(function (t, d) { return t + debtLeft(d) * entRate(debtItemId(d)); }, 0);
      x.fillStyle = '#FBF8FC'; x.fillRect(0, 0, SHARE_W, SHARE_H);
      cBrand(x, '#7E2A55', 'MY YEAR');
      x.fillStyle = '#211C2E'; x.textAlign = 'left'; x.font = '400 132px "Besley", Georgia, serif'; x.fillText(Y + ',', 76, 330); x.fillText('stamped.', 76, 460);
      MONTHS.forEach(function (m, i) {
        var bx = 80 + (i % 6) * 156, by = 530 + Math.floor(i / 6) * 156, on = !!have[m];
        x.fillStyle = on ? '#7E2A55' : '#EAE4EC'; cRound(x, null, bx, by, 140, 140, 18); x.fill();
        x.fillStyle = on ? '#FFFFFF' : '#9A93A3'; x.font = '700 30px "Hanken Grotesk", system-ui, sans-serif'; x.textAlign = 'center'; x.fillText(m.slice(0, 3).toUpperCase(), bx + 70, by + 80);
      });
      x.textAlign = 'left'; x.fillStyle = '#4A4356'; x.font = '400 36px "Hanken Grotesk", system-ui, sans-serif'; x.fillText(recs.length + ' of 12 months stamped', 80, 880);
      var rows = [['Of pay saved', pctN(tot.saved, tot.income) + '%'], ['Of pay invested', pctN(tot.invested, tot.income) + '%']];
      if (tot.debt > 0) rows.push(amounts ? ['Paid off debt', money(Math.round(tot.debt))] : ['Debt paid down', pctN(tot.debt, tot.debt + leftNow) + '%']);
      else if (amounts) rows.push(['Saved and invested', money(Math.round(tot.saved + tot.invested))]);
      rows.forEach(function (rw, i) {
        var ry = 960 + i * 78;
        x.fillStyle = '#4A4356'; x.font = '400 36px "Hanken Grotesk", system-ui, sans-serif'; x.textAlign = 'left'; x.fillText(rw[0], 80, ry);
        x.fillStyle = i === 2 ? '#1E6B47' : '#211C2E'; x.font = '700 50px "Hanken Grotesk", system-ui, sans-serif'; x.textAlign = 'right'; x.fillText(curText(rw[1]), SHARE_W - 80, ry + 2);
        x.fillStyle = '#E2DDE4'; x.fillRect(80, ry + 26, SHARE_W - 160, 2);
      });
      var win = yearWin(Y);
      if (win && rows.length < 3) { x.fillStyle = '#E3F0E8'; cRound(x, null, 80, 1130, SHARE_W - 160, 70, 18); x.fill(); x.fillStyle = '#1E6B47'; x.textAlign = 'left'; x.font = '700 30px "Hanken Grotesk", system-ui, sans-serif'; x.fillText('BIGGEST WIN  ·  ' + win.replace(/£/g, cur()), 108, 1176); }
      cFoot(x, true); return Promise.resolve(cv);
    });
  }
  function shareImage(sp, cb) {
    var k = shareKey(sp);
    if (shareCache[k]) { cb(shareCache[k]); return; }
    renderShare(sp).then(function (cv) { shareCanvas = cv; try { shareCache[k] = { url: cv.toDataURL('image/png'), cv: cv }; } catch (e) { shareCache[k] = { url: '', cv: cv }; } cb(shareCache[k]); })
      .catch(function () { cb({ url: '', cv: null }); });
  }
  function shareFileName(sp) { return 'paystamp-' + (sp.kind === 'milestone' ? sp.key : sp.kind === 'year' ? sp.year : (sp.month + '-' + sp.year).toLowerCase()) + '.png'; }
  function doShareCard(sp, mode) {
    var k = shareKey(sp), c = shareCache[k]; if (!c || !c.cv) return;
    c.cv.toBlob(function (blob) {
      if (!blob) return;
      var file = new File([blob], shareFileName(sp), { type: 'image/png' });
      var text = 'Planning my pay with PayStamp. ' + shareUrl();
      if (mode === 'share' && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], text: text }).catch(function () {}); return;
      }
      try {
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; document.body.append(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
        set({ shareMsg: mode === 'share' ? 'Sharing isn’t available here, so the picture has been saved instead. Post it from your photos or downloads.' : 'Saved. Look in your downloads.' });
      } catch (e) { set({ shareMsg: 'Press and hold the picture (or right-click it) to save it.' }); }
    }, 'image/png');
  }
  function shareBody() {
    var sp = state.shareSpec || { kind: 'month' }, amounts = !!state.shareAmounts;
    var img = h('img', { class: 'sh-img', alt: shareTitle(sp) + ' share card', width: '1080', height: '1350' });
    var prev = h('div', { class: 'sh-prev' }, [h('span', { class: 'sh-load', text: 'Making your card…' }), img]);
    shareImage(sp, function (c) { if (c.url) { img.src = c.url; prev.classList.add('ready'); } else prev.querySelector('.sh-load').textContent = 'Couldn’t make the picture in this browser.'; });
    var canAmounts = sp.kind !== 'milestone';
    var lead = sp.kind === 'milestone' ? 'You earned it. Want to share it?' : sp.kind === 'year' ? 'Your year on one card. Want to share it?' : (streakAt(sp.month, sp.year) > 1 ? streakAt(sp.month, sp.year) + ' months in a row. ' : '') + 'Want to share it?';
    return h('div', { class: 'sh-wrap' }, [prev,
      h('div', { class: 'sh-side' }, [
        h('p', { class: 'sh-lead', text: lead }),
        canAmounts ? h('div', { class: 'sh-opt' }, [h('div', {}, [h('b', { text: 'Show ' + cur() + ' amounts' }), h('small', { text: amounts ? 'Your card shows amounts. Only share it with people you’re happy to see them.' : 'Off: your card only shows percentages and your streak.' })]),
          h('button', { type: 'button', class: 'sw', role: 'switch', 'aria-checked': String(amounts), 'aria-label': 'Show amounts on your card', onclick: function () { set({ shareAmounts: !amounts, shareMsg: '' }); } }, [h('i')])]) : null,
        h('div', { class: 'sh-note' }, [h('span', { html: IC.link || '' }), h('span', { text: 'The link on your card is your own invite link (' + shareLinkText() + '). Anyone who joins from it counts as one of your invites.' })]),
        h('div', { class: 'sh-btns' }, [btn('pill-btn primary', 'Share', function () { doShareCard(sp, 'share'); }, ['Share']), btn('pill-btn', 'Download image', function () { doShareCard(sp, 'download'); }, ['Download image'])]),
        state.shareMsg ? h('p', { class: 'sh-msg', role: 'status', text: state.shareMsg }) : h('p', { class: 'sh-small', text: 'On a phone, Share opens Instagram, WhatsApp and the rest. You can also press and hold the picture to save it.' }) ]) ]);
  }
  // On payday (and for 3 days after, until the month is stamped): the same three steps as the payday email.
  function paydayBanner(month, year) {
    if (state.isExample || payRule().mode === 'varies') return null;
    var d = nextPayDate(), now = today0(); if (!d) return null;
    var last = new Date(d); last.setMonth(last.getMonth() - 1);
    var since = Math.round((now - (Math.round((d - now) / 864e5) === 0 ? d : prevPayDateGuess(d))) / 864e5);
    if (since < 0 || since > 3) return null;
    var key = month + ' ' + year; if (state.paydayBannerHidden === key || stampStatus(month, year).state === 'stamped') return null;
    var step = function (n, t) { return h('span', { class: 'pdb-step' }, [h('b', { text: String(n) }), t]); };
    return h('section', { class: 'pdb' }, [
      h('div', { class: 'pdb-t' }, [h('b', { text: (since === 0 ? 'It’s payday' : 'Payday was ' + (since === 1 ? 'yesterday' : since + ' days ago')) + (userName() ? ', ' + userName() : '') + '!' }),
        h('div', { class: 'pdb-steps' }, [step(1, 'Enter your pay'), step(2, 'Check your plan'), step(3, 'Press Stamp')])]),
      btn('pill-btn primary', 'Enter your pay', function () {
        var inp = document.querySelector('.group.inc-loc [data-k^="bud-"], .group [data-k^="bud-"]'); if (!inp) return;
        inp.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(function () { inp.focus(); }, 350);
      }, ['Enter your pay']),
      btn('rm', 'Hide until next payday', function () { set({ paydayBannerHidden: key }); }, ['✕']) ]);
  }
  // The payday before a given next payday: roughly a month earlier, using the same rule.
  function prevPayDateGuess(next) { var p = new Date(next); p.setMonth(p.getMonth() - 1); return p; }
  // In December and January: your year, ready to share, at the top of the planner.
  function yearShareCard() {
    var now = new Date(), m = now.getMonth(); if (m !== 11 && m !== 0) return null;
    var y = m === 11 ? now.getFullYear() : now.getFullYear() - 1;
    if (yearRecs(y).length < 3 || (state.yearShareHidden || {})[y] || state.isExample) return null;
    return h('section', { class: 'yr-card' }, [
      h('div', { class: 'yr-grid', 'aria-hidden': 'true' }, MONTHS.map(function (mm) { return h('i', { class: yearRecs(y).some(function (q) { return q.month === mm; }) ? 'on' : '' }); })),
      h('div', { class: 'yr-t' }, [h('b', { text: 'Your ' + y + ', stamped' }), h('small', { text: yearRecs(y).length + ' of 12 months stamped. See your year on one card.' })]),
      btn('pill-btn primary', 'See your ' + y, function () { openShare({ kind: 'year', year: y }); }, ['See your year']),
      btn('rm', 'Hide this', function () { state.yearShareHidden = Object.assign({}, state.yearShareHidden); state.yearShareHidden[y] = true; commit(); }, ['✕']) ]);
  }
  // Records: share any card, any time.

  function newStampsBody() {
    var keys = state.pendingStamps || [];
    var done = function () { state.pendingStamps = []; set({ overlay: null }); };
    return h('div', { class: 'f-welcome' }, [
      h('div', { class: 'ns-row' }, keys.map(function (k) { return h('div', { class: 'ns-item' }, [h('span', { class: 'f-big-stamp ns', html: stampSVG(k) }), h('b', { text: STAMP[k].name }),
        SHARE_COPY[k] ? btn('sh-chip', 'Share ' + STAMP[k].name, function () { openShare({ kind: 'milestone', key: k }); }, ['Share it']) : null]); })),
      h('p', { text: keys.length > 1 ? 'They’ve been added to the top of your Monthly Planner.' : 'It’s been added to the top of your Monthly Planner.' }),
      h('div', { class: 'sheet-actions' }, [btn('fb-send', 'Done', done, ['Done'])]) ]);
  }

  /* ---------- emergency funds (Savings page) ---------- */
  function efundSection() {
    var open = !!state.efundOpen, c = costsTotal();
    var pick = function (key, label, id) {
      var sel = h('select', { class: 'xsel', id: id, 'aria-label': label, onchange: function (e) { state[key] = e.target.value; commit(); } },
        [h('option', { value: '', text: 'Not set' })].concat(state.savings.map(function (sv) { return h('option', { value: sv.id, text: sv.name || 'Untitled savings' }); })));
      sel.value = state[key] || '';
      return h('label', { class: 'ef-pick', for: id }, [h('span', { text: label }), sel]);
    };
    var names = [state.efundStarter, state.efundMain].map(function (id) { var sv = id && findSaving(id); return sv ? sv.name : null; }).filter(Boolean);
    return h('section', { class: 'dsec prev' + (open ? ' open' : '') }, [
      h('button', { type: 'button', class: 'prev-toggle', 'aria-expanded': String(open), onclick: function () { set({ efundOpen: !open }); } }, [
        h('span', { class: 'pt-text' }, [h('h4', { text: 'Emergency fund and safety net' }), h('small', { text: names.length ? names.join(' · ') : 'Tell PayStamp which pots are your emergency fund and safety net.' })]),
        h('span', { class: 'pt-arrow', 'aria-hidden': 'true', text: open ? '▾' : '▸' }) ]),
      open ? h('div', { class: 'prev-body' }, [
        h('p', { class: 'prev-note', text: 'Used for your emergency fund stamps. Your safety net is measured against your monthly Costs (' + money(Math.round(c)) + '), so 3 months is ' + money(Math.round(c * 3)) + ' and 6 months is ' + money(Math.round(c * 6)) + '.' }),
        h('div', { class: 'ef-grid' }, [pick('efundStarter', 'Emergency fund (sudden costs)', 'f-ef-start'), pick('efundMain', 'Safety net (3–6 months of costs)', 'f-ef-main')]) ]) : null ]);
  }

  /* ---------- sheets ---------- */
  function founderInfoBody() {
    var F = state.founder;
    return h('div', { class: 'f-info' }, [
      h('p', { class: 'f-lead', text: 'Founders are the first 100 people to use PayStamp.' }),
      h('ul', { class: 'f-list' }, [
        h('li', {}, ['You get a founder number, from 1 to 100, when you ', h('b', { text: 'stamp your first month with a £0 balance' }), ', so every pound of your pay has a job.' ]),
        h('li', { text: 'Founders get perks as PayStamp grows.' }),
        h('li', {}, ['Invite 3 people who become founders, and you become an ', h('b', { text: 'Elite Founder' }), '. Elite places are rare, and they close when the 100 are gone.']) ]),
      F.number ? h('p', { class: 'f-you', text: 'You’re Founding Member #' + F.number + (F.elite ? ' and Elite Founding Member #' + F.eliteNumber : '') + '.' })
        : h('p', { class: 'f-hint', text: 'To get your number: plan your own month until it adds up to exactly your pay, then press Stamp.' }),
      h('div', { class: 'f-counter' }, [h('b', { text: String(F.placesLeft) }), ' founding places left']),
      h('div', { class: 'sheet-actions' }, [btn('fb-send', 'Gift a founder place', function () { openOverlay('invites'); }, ['Gift a founder place'])]) ]);
  }
  function nameField() {
    var F = state.founder;
    return h('label', { class: 'f-name', for: 'f-founder-name' }, [h('span', { text: 'Your first name, shown on your invite' }),
      field('founder-name', F.name, function (v) { F.name = v.trim().slice(0, 24); commit(); }, { cls: 'tf', ph: 'e.g. Sam', label: 'Your first name' })]);
  }
  function founderWelcomeBody() {
    var F = state.founder;
    return h('div', { class: 'f-welcome' }, [
      h('span', { class: 'f-big-stamp', html: founderStampSVG(F.number) }),
      h('h4', { text: 'Founding Member #' + F.number }),
      F.since ? h('p', { class: 'f-hint', text: 'Since ' + F.since }) : null,
      h('p', { text: 'You’re one of PayStamp’s first 100 users. Your stamp now sits at the top of your Monthly Planner.' }),
      h('div', { class: 'sheet-actions' }, [btn('fb-send', 'Done', function () { set({ overlay: (state.pendingStamps || []).length ? 'newStamps' : null }); }, ['Done']), btn('btn-t', 'What’s a founder?', function () { openOverlay('founderInfo'); }, ['What’s a founder?'])]) ]);
  }
  var qrLoad = null;
  function drawQR(el, text) {
    if (!qrLoad) qrLoad = new Promise(function (res, rej) { var sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'; sc.onload = res; sc.onerror = rej; document.head.append(sc); });
    qrLoad.then(function () { el.innerHTML = ''; new window.QRCode(el, { text: text, width: 148, height: 148, colorDark: '#211C2E', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M }); },
      function () { el.textContent = 'The QR code didn’t load. Use Copy link instead.'; });
  }
  function copyInvite(text, done) {
    var fallback = function () { var ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.remove(); done(); };
    try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e) { fallback(); }
  }
  function invitesBody() {
    var F = state.founder, msg = inviteMessage(), wa = 'https://wa.me/?text=' + encodeURIComponent(msg);
    var copyBtn = btn('mini', 'Copy your invite link', function () { copyInvite(inviteLink(), function () { copyBtn.textContent = 'Copied'; setTimeout(function () { copyBtn.textContent = 'Copy link'; }, 1600); }); }, ['Copy link']);
    var more = Math.max(0, 3 - (F.joined || 0));
    var prog = F.number && F.placesLeft > 0 && !F.elite ? h('div', { class: 'f-prog' }, [
      h('div', { class: 'f-dots' }, [0, 1, 2].map(function (i) { return h('i', { class: i < F.joined ? 'on' : '' }); })),
      h('span', {}, [h('b', { text: 'Gift ' + more + (more === 1 ? ' more place' : ' more places') }), ' and you become an ', h('b', { text: 'Elite Founder' }), '. ' + (F.joined ? F.joined + ' of 3 friends have claimed theirs.' : 'A place counts once your friend stamps their first month.')]) ]) : null;
    // v4.3: what a gifted place means for your friend, and how many are left
    var gets = F.placesLeft > 0 ? h('div', { class: 'f-gets' }, [
      h('b', { text: 'What your friend gets' }),
      h('ul', {}, [h('li', { text: 'A founder number from 1 to 100, theirs for good' }), h('li', { text: 'Founder perks as PayStamp grows' }), h('li', { text: 'PayStamp, completely free' })]),
      h('small', { text: 'They claim it by planning their month and stamping it with a £0 balance.' }) ]) : null;
    var left = F.placesLeft > 0 ? h('p', { class: 'f-left' }, ['Only ', h('b', { text: String(F.placesLeft) }), ' founder places left. Gift one before they’re gone.']) : null;
    return h('div', { class: 'f-body' }, [
      left, gets,
      curPage() === 'account' ? null : nameField(),
      h('div', { class: 'f-link-row' }, [h('span', { class: 'f-inv-link', text: inviteLink().replace('https://', '') }),
        h('a', { class: 'mini wa', href: wa, target: '_blank', rel: 'noopener' }, ['WhatsApp']), copyBtn]),
      h('div', { class: 'f-qr' }, [h('div', { class: 'f-qr-box', 'data-qr': wa }), h('p', { text: 'On a laptop? Scan this with your phone. WhatsApp opens with your invite ready to send.' })]),
      prog,
      h('div', { class: 'f-preview' }, [h('span', { class: 'fb-lbl', text: 'What your friend sees' }), h('p', { text: msg })]) ]);
  }

  /* ---------- What if? (savings) ----------
     Two ways round, both with interest added monthly:
       "What do I need to save?"  goal + time (+ already saved, interest) → monthly amount and the date
       "What will I have?"        monthly amount + time (+ already saved, interest) → total by then
     Pick one of your savings to fill in its numbers; then "Use £X a month" makes it that saving's monthly amount.
     Typing only updates the answer. Nothing changes your plan unless you press Use. */
  function saveWhatIf(cur) {
    var open = !!state.saveWifOpen;
    var W = state.saveWif;
    if (!W || W.mode == null) W = state.saveWif = { mode: 'need', potId: '', goal: '', start: '', aer: '', years: '1', months: '0', monthly: String(cur || '') };
    var head = h('button', { type: 'button', class: 'prev-toggle', 'aria-expanded': String(open), onclick: function () { if (!open) track('whatif', 'savings'); set({ saveWifOpen: !open }); } }, [
      h('span', { class: 'pt-text' }, [h('h4', { text: 'What if Calculator' }), h('small', { text: 'Set a goal and a time to see what to save each month, or see what you’d have.' })]),
      h('span', { class: 'pt-arrow', 'aria-hidden': 'true', text: open ? '▾' : '▸' }) ]);
    if (!open) return h('section', { class: 'dsec prev' }, [head]);
    if (W.potId && !findSaving(W.potId)) W.potId = '';
    var pot = W.potId ? findSaving(W.potId) : null, need = W.mode === 'need';

    var modes = h('div', { class: 'seg-o sw-modes', role: 'group', 'aria-label': 'What to work out' }, [['need', 'What do I need to save?'], ['have', 'What will I have?']].map(function (m) {
      return btn('', m[1], function () { W.mode = m[0]; commit(); }, [m[1]], { 'aria-pressed': String(W.mode === m[0]) });
    }));
    var potSel = h('select', { class: 'xsel', id: 'f-sw-pot', 'aria-label': 'Which savings', onchange: function (e) {
      W.potId = e.target.value; var sv = findSaving(W.potId);
      if (sv) { W.goal = sv.goal || ''; W.start = String(r2(savedNow(sv))); W.aer = sv.aer || ''; W.monthly = sv.monthly || ''; }
      commit();
    } }, [h('option', { value: '', text: 'A new goal (type your own numbers)' })].concat(state.savings.map(function (sv) { return h('option', { value: sv.id, text: (sv.name || 'Untitled savings') }); })));
    potSel.value = W.potId;

    var out = h('div', { class: 'sw-result' });
    var inp = function (key, prop, label, pre, post) {
      var el = h('input', { type: 'text', inputmode: 'decimal', class: 'gp-in', id: 'f-' + key, 'data-k': key, 'aria-label': label, placeholder: '0' });
      el.value = W[prop] == null ? '' : W[prop];
      el.addEventListener('input', function () { W[prop] = el.value; show(); });
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') el.blur(); });
      return h('label', { class: 'sw-f', for: 'f-' + key }, [h('span', { class: 'gp-k', text: label }), h('span', { class: 'gp-box' }, [pre ? h('b', { text: pre }) : null, el, post ? h('i', { text: post }) : null])]);
    };
    var when = h('div', { class: 'sw-f sw-when' }, [h('span', { class: 'gp-k', text: need ? 'Reach it in' : 'For' }), h('span', { class: 'gp-pair' }, [
      h('span', { class: 'gp-box' }, [(function () { var l = inp('sw-y', 'years', 'Years', '', 'yrs'); return l.querySelector('input'); })(), h('i', { text: 'yrs' })]),
      h('span', { class: 'gp-box' }, [(function () { var l = inp('sw-mo', 'months', 'Months', '', 'mths'); return l.querySelector('input'); })(), h('i', { text: 'mths' })]) ])]);
    var nameIn = null;
    if (!pot) { nameIn = h('input', { type: 'text', class: 'gp-in', id: 'f-sw-name', 'data-k': 'sw-name', 'aria-label': 'Name for this goal', placeholder: 'e.g. Holiday' });
      nameIn.value = W.name || ''; nameIn.addEventListener('input', function () { W.name = nameIn.value; }); }
    var grid = h('div', { class: 'sw-grid' }, need
      ? [inp('sw-goal', 'goal', 'Goal', '£'), inp('sw-start', 'start', 'Already saved', '£'), inp('sw-aer', 'aer', 'Interest', '', '% a year'), when]
      : [inp('sw-m', 'monthly', 'Save each month', '£'), inp('sw-start', 'start', 'Already saved', '£'), inp('sw-aer', 'aer', 'Interest', '', '% a year'), when]);

    // v4.1: a new goal you've worked out here can go straight into Savings and your planner
    function addNewGoal(monthly, goal) {
      var sv = { id: uid('sv'), name: (W.name || '').trim() || 'New goal', goal: String(Math.round(goal)), saved: String(amt(W.start) || ''), aer: W.aer || '', monthly: String(Math.round(monthly * 100) / 100) };
      state.savings.push(sv); addSavingToPlanner(sv); W.name = ''; track('whatif_goal_added'); commit();
      showUndo('Added ' + sv.name + ' to Savings and your plan', function () { removeSavingFromPlanner(sv); state.savings = state.savings.filter(function (x) { return x !== sv; }); commit(); });
    }
    function addBtn(monthly, goal) { return btn('gp-use sw-add', 'Add this goal to Savings and my plan', function () { addNewGoal(monthly, goal); }, ['+ Add to my savings goals and plan']); }
    function show() {
      out.replaceChildren();
      var n = Math.max(0, Math.round(amt(W.years) * 12 + amt(W.months))), S = amt(W.start), r = monthlyRate(amt(W.aer));
      var by = n > 0 ? byLabel(monthIndexNow() + n) : null;
      if (!n) { out.append(h('p', { class: 'gp-msg', text: 'Type how long you’ve got, in years and months.' })); return; }
      if (need) {
        var goal = amt(W.goal);
        if (!goal) { out.append(h('p', { class: 'gp-msg', text: 'Type how much you want to save.' })); return; }
        if (S >= goal) { out.append(h('p', { class: 'gp-msg', text: 'You’ve already got ' + money(S) + ', so you’ve reached ' + money(goal) + '.' })); return; }
        var M = Math.max(0, Math.ceil(neededMonthly(goal, S, r, n)));
        if (M === 0) { out.append(h('p', { class: 'gp-msg', text: 'The interest alone gets you to ' + money(goal) + ' by ' + by + '.' })); return; }
        out.append(h('div', { class: 'gp-need' }, [h('span', { class: 'gp-k2', text: 'To have ' + money(goal) + ' by ' + by + ', save' }), h('span', { class: 'gp-big', text: money(M) + ' a month' })]));
        var put = M * n, earned = Math.round(goal - S - put);
        out.append(h('p', { class: 'gp-note', text: 'You’d put in ' + money(Math.round(put)) + (earned > 0 ? ' and interest adds about ' + money(earned) : '') + '.' }));
        if (!pot) out.append(addBtn(M, goal));
        if (pot) {
          var now = amt(savingMonthly(pot)), at = now > 0 ? monthsToGoal(goal, S, r, now) : null;
          out.append(h('p', { class: 'gp-at ' + (now >= M ? 'ok' : 'short') }, [now > 0
            ? 'You save ' + money(now) + ' a month into ' + (pot.name || 'this') + ' now' + (at == null ? ', which won’t reach it.' : ', which gets there by ' + byLabel(monthIndexNow() + at) + ' (' + monthsText(at) + ').')
            : 'You’re not saving into ' + (pot.name || 'this') + ' each month yet.']));
          out.append(now === M ? h('span', { class: 'gp-set', text: '✓ This is already your monthly saving for ' + (pot.name || 'this') })
            : btn('gp-use', 'Use ' + money(M) + ' a month for ' + (pot.name || 'this saving'), function () { useMonthly(pot, M); if (amt(pot.goal) !== goal) pot.goal = String(goal); commit(); }, ['Use ' + money(M) + ' a month for ' + (pot.name || 'this saving')]));
        }
      } else {
        var m = amt(W.monthly), g = Math.pow(1 + r, n), total = S * g + (r ? m * (g - 1) / r : m * n), putIn = S + m * n;
        out.append(h('div', { class: 'gp-need' }, [h('span', { class: 'gp-k2', text: 'By ' + by + ' you’d have' }), h('span', { class: 'gp-big', text: money(Math.round(total)) })]));
        out.append(h('p', { class: 'gp-note', text: money(Math.round(putIn)) + ' put in' + (total - putIn >= 1 ? ' + ' + money(Math.round(total - putIn)) + ' interest' : '') + '.' }));
        if (!pot && m > 0) out.append(addBtn(m, amt(W.goal) || total));
        if (pot && amt(pot.goal) > 0) {
          var pg = amt(pot.goal);
          out.append(h('p', { class: 'gp-at ' + (total >= pg ? 'ok' : 'short'), text: total >= pg ? 'That reaches your ' + (pot.name || '') + ' goal of ' + money(pg) + '.' : 'That’s ' + money(Math.round(pg - total)) + ' short of your ' + (pot.name || '') + ' goal of ' + money(pg) + '.' }));
        }
      }
    }
    show();
    var body = h('div', { class: 'prev-body sw-body' }, [
      modes,
      h('label', { class: 'sw-f', for: 'f-sw-pot' }, [h('span', { class: 'gp-k', text: 'For' }), potSel]),
      nameIn ? h('label', { class: 'sw-f', for: 'f-sw-name' }, [h('span', { class: 'gp-k', text: 'Name' }), h('span', { class: 'gp-box' }, [nameIn])]) : null,
      grid, out,
      h('p', { class: 'wif-note', text: 'Interest is added monthly at the yearly rate you type. Nothing here changes your plan unless you press Use or Add.' }) ]);
    return h('section', { class: 'dsec prev open' }, [head, body]);
  }

  /* ---------- What if? (investments) ----------
     Monthly compounding from today's total worth: FV = V(1+r)^n + M((1+r)^n − 1)/r. */

  // v4.1: the What if chart. Each year: what you've put in, and what it's worth with growth.
  function iwChart(S, m, n, r, type) {
    var yrs = Math.max(1, Math.ceil(n / 12)), pts = [];
    for (var y = 0; y <= yrs; y++) { var k = Math.min(n, y * 12), f = Math.pow(1 + r, k); pts.push({ y: y, put: S + m * k, worth: S * f + (r ? m * (f - 1) / r : m * k) }); }
    var hi = Math.max.apply(null, pts.map(function (q) { return Math.max(q.put, q.worth); })) || 1;
    var stepV = (function (rr) { var mm = Math.pow(10, Math.floor(Math.log10(Math.max(rr, 1) / 4))), c = [1, 2, 2.5, 5, 10]; for (var i = 0; i < c.length; i++) if (rr / (c[i] * mm) <= 5) return c[i] * mm; return 10 * mm; })(hi);
    hi = Math.ceil(hi / stepV) * stepV;
    var narrow = window.innerWidth <= 640, VW = narrow ? 340 : 720, VH = narrow ? 210 : 260, L = narrow ? 44 : 60, R = 14, T = 16, B = 28;
    var bw = (VW - L - R) / (yrs + 1), X = function (y) { return type === 'bar' ? L + bw * (y + .5) : L + y / yrs * (VW - L - R); }, Y = function (v) { return T + (hi - v) / hi * (VH - T - B); };
    var short = function (v) { var a = Math.abs(v); return '£' + (a >= 1e6 ? (a / 1e6).toFixed(1).replace(/\.0$/, '') + 'm' : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k' : Math.round(a)); };
    var o = '<svg viewBox="0 0 ' + VW + ' ' + VH + '" class="iw-svg" role="img" aria-label="Worth after ' + yrs + (yrs === 1 ? ' year: ' : ' years: ') + short(pts[yrs].worth) + ', of which ' + short(pts[yrs].put) + ' put in">';
    for (var g = 0; g <= hi + 0.001; g += stepV) o += '<line x1="' + L + '" x2="' + (VW - R) + '" y1="' + Y(g).toFixed(1) + '" y2="' + Y(g).toFixed(1) + '" class="grid"/><text x="' + (L - 8) + '" y="' + (Y(g) + 4).toFixed(1) + '" text-anchor="end" class="ax">' + short(g) + '</text>';
    var every = yrs <= 12 ? 1 : yrs <= 25 ? (narrow ? 5 : 2) : 5;
    pts.forEach(function (q) { if (q.y % every === 0 || q.y === yrs) o += '<text x="' + X(q.y).toFixed(1) + '" y="' + (VH - 8) + '" text-anchor="middle" class="ax">' + (q.y === 0 ? 'Now' : q.y + 'y') + '</text>'; });
    if (type === 'bar') {
      var w = Math.max(3, Math.min(34, bw * .62));
      pts.forEach(function (q) {
        var x = X(q.y) - w / 2, gr = Math.max(0, q.worth - q.put);
        o += '<g><title>' + (q.y === 0 ? 'Now' : 'Year ' + q.y) + ': put in ' + money(Math.round(q.put)) + ', interest ' + money(Math.round(gr)) + ', worth ' + money(Math.round(q.worth)) + '</title>';
        o += '<rect x="' + x.toFixed(1) + '" y="' + Y(q.put).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(0, Y(0) - Y(q.put)).toFixed(1) + '" class="b-put" rx="2"/>';
        if (gr > 0) o += '<rect x="' + x.toFixed(1) + '" y="' + Y(q.worth).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(0, Y(q.put) - Y(q.worth)).toFixed(1) + '" class="b-grow" rx="2"/>';
        o += '</g>';
      });
    } else {
      var lw = pts.map(function (q, i) { return (i ? 'L' : 'M') + X(q.y).toFixed(1) + ' ' + Y(q.worth).toFixed(1); }).join(' ');
      var lp = pts.map(function (q, i) { return (i ? 'L' : 'M') + X(q.y).toFixed(1) + ' ' + Y(q.put).toFixed(1); }).join(' ');
      o += '<path d="' + lw + ' L' + X(yrs).toFixed(1) + ' ' + Y(0).toFixed(1) + ' L' + X(0).toFixed(1) + ' ' + Y(0).toFixed(1) + ' Z" class="a-grow"/>';
      o += '<path d="' + lp + ' L' + X(yrs).toFixed(1) + ' ' + Y(0).toFixed(1) + ' L' + X(0).toFixed(1) + ' ' + Y(0).toFixed(1) + ' Z" class="a-put"/>';
      o += '<path d="' + lp + '" class="l-put"/><path d="' + lw + '" class="l-grow"/>';
      pts.forEach(function (q) { o += '<circle cx="' + X(q.y).toFixed(1) + '" cy="' + Y(q.worth).toFixed(1) + '" r="' + (yrs > 25 ? 2.5 : 3.5) + '" class="p-grow"><title>' + (q.y === 0 ? 'Now' : 'Year ' + q.y) + ': worth ' + money(Math.round(q.worth)) + ' (put in ' + money(Math.round(q.put)) + ')</title></circle>'; });
      o += '<text x="' + (X(yrs) - 4).toFixed(1) + '" y="' + (Y(pts[yrs].worth) - 10).toFixed(1) + '" text-anchor="end" class="lbl">' + short(pts[yrs].worth) + '</text>';
    }
    return o + '</svg>';
  }
  function invWhatIf() {
    var open = !!state.invWifOpen;
    var cur = state.investments.reduce(function (t, iv) { return t + amt(invMonthly(iv)); }, 0);
    var W = state.invWif || (state.invWif = { start: '0', monthly: String(cur), years: '10', growth: '8' });
    var head = h('button', { type: 'button', class: 'prev-toggle', 'aria-expanded': String(open), onclick: function () { if (!open) track('whatif', 'investments'); set({ invWifOpen: !open }); } }, [
      h('span', { class: 'pt-text' }, [h('h4', { text: 'What if Calculator' }), h('small', { text: 'See what an investment could grow to.' })]),
      h('span', { class: 'pt-arrow', 'aria-hidden': 'true', text: open ? '▾' : '▸' }) ]);
    var body = null;
    if (open) {
      var vIn = h('span', { class: 'v' }), vEnd = h('span', { class: 'v hi' }), vGrow = h('span', { class: 'v' }), chartEl = h('div', { class: 'iw-chart' });
      // Monthly compounding: FV = S(1+r)^n + M((1+r)^n − 1)/r
      var show = function () {
        var S = amt(W.start), m = amt(W.monthly), n = Math.max(0, Math.round(amt(W.years) * 12)), r = amt(W.growth) / 1200;
        var f = Math.pow(1 + r, n), end = S * f + (r ? m * (f - 1) / r : m * n), put = S + m * n;
        vIn.textContent = money(Math.round(put)); vEnd.textContent = money(Math.round(end));
        vGrow.textContent = (end >= put ? '+' : '−') + money(Math.abs(Math.round(end - put)));
        chartEl.innerHTML = iwChart(S, m, n, r, W.chart === 'bar' ? 'bar' : 'line');
      };
      var inp = function (key, prop, pre, post, label) {
        var el = h('input', { type: 'text', inputmode: 'decimal', id: 'f-' + key, 'data-k': key, 'aria-label': label });
        el.value = W[prop]; el.addEventListener('input', function () { W[prop] = el.value; show(); });
        return h('label', { for: 'f-' + key }, [label, h('span', { class: 'wif-in' }, [pre ? h('span', { text: pre }) : null, el, post ? h('small', { style: 'font-size:14px;color:var(--muted);font-weight:600', text: post }) : null])]);
      };
      show();
      body = h('div', { class: 'prev-body iw' }, [
        h('div', { class: 'wif-grid four' }, [inp('iw-s', 'start', '£', '', 'Starting amount'), inp('iw-m', 'monthly', '£', '', 'Each month'), inp('iw-y', 'years', '', 'yrs', 'For'), inp('iw-g', 'growth', '', '%', 'Yearly interest')]),
        h('div', { class: 'wif-stats' }, [h('div', {}, [h('span', { class: 'k', text: 'Put in by then' }), vIn]), h('div', {}, [h('span', { class: 'k', text: 'Interest added' }), vGrow]), h('div', {}, [h('span', { class: 'k', text: 'Worth' }), vEnd])]),
        // v4.1: worth year by year, as a line or bars
        h('div', { class: 'iw-ch-h' }, [h('b', { text: 'Year by year' }),
          h('span', { class: 'iw-key' }, [h('i', { class: 'k-put' }), 'Put in', h('i', { class: 'k-grow' }), 'Interest']),
          h('div', { class: 'rt-seg iw-seg', role: 'group', 'aria-label': 'Chart type' }, [['line', 'Line'], ['bar', 'Bars']].map(function (o) {
            var on = (W.chart === 'bar' ? 'bar' : 'line') === o[0];
            return btn(on ? 'on' : '', 'Show as ' + o[1].toLowerCase(), function () { W.chart = o[0]; track('whatif_chart', o[0]); commit(); }, [o[1]], { 'aria-pressed': String(on) }); })) ]),
        chartEl,
        h('p', { class: 'wif-note', text: 'Interest here means growth, which isn’t guaranteed: investments can go down as well as up, so treat this as a rough guide.' }) ]);
    }
    return h('section', { class: 'dsec prev' + (open ? ' open' : '') }, [head, body]);
  }

  /* V4-BEGIN */
  /* ================= v4: the planner header =================
     The year at a glance (each stamped month is inked in), and one bar showing how this month's pay is split. */
  function jumpMonth(m, y) {
    var from = (state.month || MONTHS[new Date().getMonth()]) + ' ' + (state.year || String(new Date().getFullYear()));
    if (from === m + ' ' + y) return;
    switchVals(from, m + ' ' + y); set({ month: m, year: String(y) });
  }
  function yearStrip(month, year) {
    var now = new Date(), cy = now.getFullYear(), cm = now.getMonth(), stamped = {};
    state.records.forEach(function (r) { if (String(r.year) === String(year)) stamped[r.month] = r; });
    var n = Object.keys(stamped).length;
    return h('div', { class: 'ystrip' }, [
      h('div', { class: 'ys-row', role: 'group', 'aria-label': year + ' month by month' }, MONTHS.map(function (m, i) {
        var sel = m === month, st = !!stamped[m], fut = Number(year) > cy || (Number(year) === cy && i > cm);
        var chg = st && sel && stampStatus(m, year).state === 'changed';
        return h('button', { type: 'button', class: 'ys-m' + (sel ? ' on' : '') + (st ? ' st' : '') + (fut ? ' fut' : ''), 'aria-pressed': String(sel),
          'aria-label': m + ' ' + year + (st ? (chg ? ', changed since you stamped it' : ', stamped') : ''), title: m + ' ' + year + (st ? (chg ? ' · changed since you stamped it' : ' · stamped') : ''), onclick: function () { jumpMonth(m, year); } },
          [h('span', { class: 'ys-l', text: m.slice(0, 3) }), h('span', { class: 'ys-s', text: m.slice(0, 1) }),
           st ? h('span', { class: 'ys-tick' + (chg ? ' chg' : ''), 'aria-hidden': 'true', html: chg ? '!' : TICK_SVG }) : null]);
      })),
      h('small', { class: 'ys-note', text: n ? n + ' of 12 months stamped in ' + year : 'Each month you stamp is inked in here' }) ]);
  }

  /* "Give it a job": where money that's left over could go, in the same order Compass teaches.
     These are options, not advice: nothing moves until you press one, and it can be undone. */

  /* ================= v4: the stamp =================
     A round ink date stamp, drawn fresh each time. Used when a month is stamped and on the stamped card. */
  var inkN = 0;
  function inkStampSVG(day, mon, year, word) {
    var id = 'ink' + (++inkN), band = (day ? day + ' ' : '') + String(mon).slice(0, 3).toUpperCase() + ' ' + year;
    return '<svg viewBox="0 0 200 200" aria-hidden="true"><defs>' +
      '<filter id="' + id + '" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="' + (inkN * 7 % 50) + '" result="w"/><feDisplacementMap in="SourceGraphic" in2="w" scale="3" result="d"/>' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="' + (inkN * 3 % 40 + 2) + '" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.25 1.3" result="m"/><feComposite in="d" in2="m" operator="in"/></filter>' +
      '<path id="' + id + 'a" d="M 34 100 A 66 66 0 0 1 166 100"/><path id="' + id + 'b" d="M 26 100 A 74 74 0 0 0 174 100"/></defs>' +
      '<g filter="url(#' + id + ')" fill="none" stroke="currentColor"><circle cx="100" cy="100" r="92" stroke-width="5"/><circle cx="100" cy="100" r="83" stroke-width="1.6"/><circle cx="100" cy="100" r="52" stroke-width="1.6"/>' +
      '<g stroke="none" fill="currentColor" font-family="Hanken Grotesk, system-ui, sans-serif" font-weight="800" letter-spacing="5"><text font-size="17" text-anchor="middle"><textPath href="#' + id + 'a" startOffset="50%">PAYSTAMP</textPath></text>' +
      '<text font-size="15" text-anchor="middle"><textPath href="#' + id + 'b" startOffset="50%">' + (word || 'STAMPED') + '</textPath></text></g>' +
      '<circle cx="20" cy="100" r="2.6" fill="currentColor" stroke="none"/><circle cx="180" cy="100" r="2.6" fill="currentColor" stroke="none"/>' +
      '<rect x="10" y="80" width="180" height="40" rx="5" fill="var(--ink-paper,#fff)" stroke-width="3.4"/>' +
      '<text x="100" y="109" text-anchor="middle" stroke="none" fill="currentColor" font-family="Besley, Georgia, serif" font-weight="700" font-size="25" letter-spacing="1">' + band + '</text></g></svg>';
  }
  var cerEl = null;
  function stampCeremony(month, year) {
    if (cerEl) cerEl.remove();
    var d = new Date(), still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    cerEl = h('div', { class: 'cer' + (still ? ' still' : ''), 'aria-hidden': 'true' }, [h('div', { class: 'cer-stamp', html: inkStampSVG(d.getDate(), month, year) })]);
    document.body.append(cerEl);
    var pg = document.querySelector('#app .page');
    if (pg && !still) { setTimeout(function () { var p2 = document.querySelector('#app .page'); if (p2) { p2.classList.add('thud'); setTimeout(function () { p2.classList.remove('thud'); }, 320); } }, 210); }
    var el = cerEl; setTimeout(function () { el.remove(); if (cerEl === el) cerEl = null; }, still ? 1300 : 1950);
  }

  /* ----- what the records can tell you ----- */
  function recIdx(r) { return Number(r.year) * 12 + MONTHS.indexOf(r.month); }
  function recsSorted() { return (state.records || []).filter(function (r) { return MONTHS.indexOf(r.month) > -1; }).sort(function (a, b) { return recIdx(a) - recIdx(b); }); }
  function recGroupKey(x) {
    if (x.gk) return x.gk;
    var g = state.groups.find(function (gg) { return gg.title === x.groupTitle; });
    return g ? g.key : (x.groupTitle === incomeTitle() ? 'income' : 'other');
  }
  function recSplit(r) {
    var o = { income: 0, investSavings: 0, costs: 0, guiltFree: 0, other: 0 };
    (r.items || []).forEach(function (x) { var k = recGroupKey(x); o[o[k] != null ? k : 'other'] += Number(x.value) || 0; });
    o.out = o.investSavings + o.costs + o.guiltFree + o.other; o.left = Math.round((o.income - o.out) * 100) / 100;
    o.rate = o.income > 0 ? o.investSavings / o.income : 0;
    return o;
  }
  function stampStreak(upTo) {
    var have = {}; recsSorted().forEach(function (r) { have[recIdx(r)] = 1; });
    var n = 0; for (var i = upTo; have[i]; i--) n++;
    return n;
  }
  // Up to three plain sentences about the month just stamped, compared with the one before it.

  /* ================= v4: sums in amount boxes =================
     Type 45+12, 1200/12, 1.2k or 10% (of this month's pay) into any amount box and it's worked out for you. */
  function calcAmount(s) {
    s = String(s == null ? '' : s).replace(/[£$€¥₹,\s]/g, '').replace(/[×xX]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-');
    if (!s || !/^[0-9.+\-*/()%kKmM]+$/.test(s) || !/[+\-*/%kKmM(]/.test(s.slice(1))) return null;   // a plain number goes the usual way
    var i = 0, pay = 0; try { pay = totals().income; } catch (e) {}
    function num() {
      var st = i; while (i < s.length && /[0-9.]/.test(s[i])) i++;
      if (st === i) return NaN;
      var v = parseFloat(s.slice(st, i));
      if (/[kK]/.test(s[i] || '')) { v *= 1000; i++; } else if (/[mM]/.test(s[i] || '')) { v *= 1e6; i++; }
      if (s[i] === '%') { v = v / 100 * pay; i++; }
      return v;
    }
    function atom() { if (s[i] === '(') { i++; var v = expr(); if (s[i] !== ')') return NaN; i++; return v; } if (s[i] === '-') { i++; return -atom(); } if (s[i] === '+') { i++; return atom(); } return num(); }
    function term() { var v = atom(); while (s[i] === '*' || s[i] === '/') { var op = s[i++], r = atom(); v = op === '*' ? v * r : v / r; } return v; }
    function expr() { var v = term(); while (s[i] === '+' || s[i] === '-') { var op = s[i++], r = term(); v = op === '+' ? v + r : v - r; } return v; }
    var out = expr();
    return i === s.length && isFinite(out) ? Math.round(out * 100) / 100 : null;
  }

  /* ================= v4: undo and redo (Ctrl+Z, Ctrl+Shift+Z) =================
     Keeps the last 25 versions of your plan while you work on a month. Moving to another month starts afresh. */
  var HIST_KEYS = ['groups','locations','records','debts','debtOrder','debtCustomOrder','debtExtras','savings','savingOrder','savingCustomOrder','savingExtras','savingUsed','investments','investExtras','investUsed','pensions','sinking','couple','hustles','sent','debtBudget'];
  var hist = { undo: [], redo: [], last: null, month: null, lock: false };
  function histSnap() { var o = {}; HIST_KEYS.forEach(function (k) { o[k] = state[k]; }); return JSON.stringify(o); }
  function histNote() {
    if (hist.lock || !state.groups) return;
    var s; try { s = histSnap(); } catch (e) { return; }
    if (hist.month !== state.valsMonth) { hist.undo = []; hist.redo = []; hist.month = state.valsMonth; hist.last = s; return; }
    if (hist.last != null && s !== hist.last) { hist.undo.push(hist.last); if (hist.undo.length > 25) hist.undo.shift(); hist.redo = []; }
    hist.last = s;
  }
  function histApply(s) {
    var o = JSON.parse(s); hist.lock = true;
    HIST_KEYS.forEach(function (k) { if (o[k] === undefined) delete state[k]; else state[k] = o[k]; });
    hist.last = s; hist.lock = false; save(); scheduleRender();
  }
  function undoStep() { track('undo'); if (!hist.undo.length) { showUndo('Nothing to undo.'); return; } hist.redo.push(hist.last); histApply(hist.undo.pop()); showUndo('Undone.', redoStep, 'Redo'); }
  function redoStep() { if (!hist.redo.length) { showUndo('Nothing to redo.'); return; } hist.undo.push(hist.last); histApply(hist.redo.pop()); showUndo('Redone.', undoStep, 'Undo'); }
  function appShowing() { var a = document.getElementById('app'); return !!(a && !a.hidden && state.groups); }
  document.addEventListener('focusin', function (e) { var t = e.target; if (t && t.matches && t.matches('input,textarea')) setTimeout(function () { t._v0 = t.value; }, 0); }, true);
  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey, k = (e.key || '').toLowerCase(), t = document.activeElement;
    var typing = t && t.matches && t.matches('input,textarea,select,[contenteditable]');
    if (!appShowing() || e.altKey) return;
    if (!mod || (k !== 'z' && k !== 'y')) return;
    if (t && t.closest && t.closest('.kp-back, .pny, .qs-ov, .overlay')) return;
    if (typing && t._v0 !== undefined && t.value !== t._v0) return;      // still typing: the box undoes its own text first
    e.preventDefault(); if (t && t.blur) t.blur();
    if (k === 'y' || e.shiftKey) redoStep(); else undoStep();
  }, true);

  /* ================= v4: search and do (Ctrl+K, or /) =================
     One box to jump to any page or line, run common jobs, or work out a quick sum. */
  var kpEl = null, kpSel = 0, kpItems = [];

  /* ================= v4: Insights =================
     Everything here is worked out from the months you've stamped; nothing is guessed.
     Free: your last 3 stamped months. Pro: every month, the trend lines and the line-by-line table.
     Chart colours are checked steps of the planner's three group colours (safe for colour-blind readers). */
  var VIZ = { investSavings: '#3C9B6C', costs: '#9A3A30', guiltFree: '#1F689D', other: '#C98500', accent: '#8A2F5E' };
  // The label inside a coloured block: white or near-black, whichever reads better on that fill.
  function inkOn(hex) { var c = String(hex).replace('#', ''); if (c.length === 3) c = c.replace(/./g, '$&$&'); var f = function (i) { var v = parseInt(c.substr(i, 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4) > 0.2 ? '#1F1A28' : '#fff'; }
  var VIZ_KEYS = ['investSavings', 'costs', 'guiltFree', 'other'];
  function vizName(k) { var g = findGroup(k); return g ? g.title : k === 'other' ? 'Other' : k; }
  
  function escH(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function niceMax(v, steps) {
    if (!(v > 0)) return 1;
    var raw = v / steps, mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), n = raw / mag;
    var step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
    return step * Math.ceil(v / step - 1e-9);
  }
  function axisMoney(v, top) { return top >= 10000 ? '£' + (v / 1000) + 'K' : '£' + fmt(v); }
  function insRange() { return isPro() ? (state.insRange || '6') : '3'; }
  function insRecs() {
    var all = recsSorted(), r = insRange();
    if (r === 'all') return all;
    if (r === 'year') { var y = all.length ? all[all.length - 1].year : String(new Date().getFullYear()); return all.filter(function (x) { return String(x.year) === String(y); }); }
    return all.slice(-Number(r));
  }
  // One floating read-out per chart: shown on hover and on keyboard focus, never the only way to read a value.
  function vizTip(wrap) {
    var tip = h('div', { class: 'viz-tip', role: 'status' }); wrap.append(tip);
    return {
      show: function (kids, x, y) {
        tip.replaceChildren.apply(tip, kids); tip.classList.add('on');
        var w = wrap.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
        var left = Math.min(Math.max(4, x - tw / 2), w.width - tw - 4), top = y - th - 12; if (top < 0) top = y + 16;
        tip.style.left = left + 'px'; tip.style.top = top + 'px';
      },
      hide: function () { tip.classList.remove('on'); } };
  }
  function tipRow(color, name, value, extra) { return h('div', { class: 'vt-r' }, [color ? h('i', { style: 'background:' + color }) : h('i', { class: 'none' }), h('b', { text: value }), h('span', { text: name + (extra ? ' · ' + extra : '') })]); }
  function recLabel(r, long) { return (long ? r.month : r.month.slice(0, 3)) + ' ' + (long ? r.year : String(r.year).slice(2)); }

  /* Where your pay went: one column per month, stacked by group. One axis, in pounds. */
  function splitChart(recs) {
    var phone = innerWidth <= 640, W = phone ? 350 : 880, H = 250, L = phone ? 40 : 52, R = 12, T = 22, B = 34;
    var data = recs.map(function (r) { return { r: r, s: recSplit(r) }; });
    var keys = VIZ_KEYS.filter(function (k) { return data.some(function (d) { return d.s[k] > 0; }); });
    var top = niceMax(Math.max.apply(null, data.map(function (d) { return Math.max(d.s.out, d.s.income); }).concat([1])), 4);
    var pw = W - L - R, ph = H - T - B, band = pw / data.length, bw = Math.min(24, Math.max(10, band * 0.5));
    var y = function (v) { return T + ph - v / top * ph; };
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Where your pay went each month, in pounds">';
    for (var i = 0; i <= 4; i++) { var v = top / 4 * i; svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" class="vz-grid' + (i === 0 ? ' base' : '') + '"/><text x="' + (L - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end" class="vz-ax">' + axisMoney(v, top) + '</text>'; }
    data.forEach(function (d, j) {
      var cx = L + band * j + band / 2, x0 = cx - bw / 2, acc = 0, lastK = null;
      keys.forEach(function (k) { if (d.s[k] > 0) lastK = k; });
      svg += '<g class="vz-col" data-i="' + j + '">';
      keys.forEach(function (k) {
        var v = d.s[k]; if (!(v > 0)) return;
        var yTop = y(acc + v), hh = Math.max(1, y(acc) - yTop - (acc > 0 ? 2 : 0));       // 2px surface gap between segments
        svg += k === lastK ? '<path d="M' + x0 + ' ' + (yTop + hh) + 'V' + (yTop + 4) + 'a4 4 0 0 1 4-4h' + (bw - 8) + 'a4 4 0 0 1 4 4V' + (yTop + hh) + 'z" fill="' + VIZ[k] + '"/>'
          : '<rect x="' + x0 + '" y="' + yTop + '" width="' + bw + '" height="' + hh + '" fill="' + VIZ[k] + '"/>';
        acc += v;
      });
      svg += '<line x1="' + (cx - bw / 2 - 5) + '" x2="' + (cx + bw / 2 + 5) + '" y1="' + y(d.s.income) + '" y2="' + y(d.s.income) + '" class="vz-pay"/>';
      svg += '<text x="' + cx + '" y="' + (H - B + 17) + '" text-anchor="middle" class="vz-ax x">' + escH(d.r.month.slice(0, 3)) + '</text>';
      if (j === 0 || d.r.month === 'January') svg += '<text x="' + cx + '" y="' + (H - 3) + '" text-anchor="middle" class="vz-ax yr">' + escH(d.r.year) + '</text>';
      svg += '<rect class="vz-hit" x="' + (L + band * j) + '" y="' + T + '" width="' + band + '" height="' + ph + '" tabindex="0" role="img" aria-label="' + escH(recLabel(d.r, true) + ': pay ' + money(d.s.income) + '. ' + keys.map(function (k) { return vizName(k) + ' ' + money(d.s[k]); }).join(', ')) + '"/></g>';
    });
    var lastD = data[data.length - 1], lx = L + band * (data.length - 1) + band / 2;
    svg += '<text x="' + lx + '" y="' + (y(Math.max(lastD.s.income, lastD.s.out)) - 8) + '" text-anchor="middle" class="vz-lab">' + money(Math.round(lastD.s.income)) + ' pay</text></svg>';
    var wrap = h('div', { class: 'viz', html: svg }), tip = vizTip(wrap);
    Array.prototype.forEach.call(wrap.querySelectorAll('.vz-col'), function (g) {
      var d = data[Number(g.getAttribute('data-i'))], hit = g.querySelector('.vz-hit');
      var show = function () {
        var b = hit.getBoundingClientRect(), w = wrap.getBoundingClientRect();
        g.classList.add('on');
        tip.show([h('div', { class: 'vt-h', text: recLabel(d.r, true) }), tipRow(null, 'Pay', money(d.s.income))].concat(keys.slice().reverse().map(function (k) { return tipRow(VIZ[k], vizName(k), money(d.s[k]), pct(d.s[k], d.s.income)); }))
          .concat(Math.abs(d.s.left) >= 0.005 ? [tipRow(null, d.s.left > 0 ? 'Not given a job' : 'Over your pay', money(Math.abs(d.s.left)))] : []), b.left - w.left + b.width / 2, y(Math.max(d.s.out, d.s.income)) / H * w.height);
      };
      var hide = function () { g.classList.remove('on'); tip.hide(); };
      hit.addEventListener('pointerenter', show); hit.addEventListener('pointerleave', hide); hit.addEventListener('focus', show); hit.addEventListener('blur', hide);
    });
    var legend = h('div', { class: 'viz-leg' }, keys.map(function (k) { return h('span', {}, [h('i', { style: 'background:' + VIZ[k] }), vizName(k)]); }).concat([h('span', {}, [h('i', { class: 'pay' }), 'Your pay'])]));
    return h('div', { class: 'ins-card' }, [h('div', { class: 'ins-h' }, [h('h2', { text: 'Where your pay went' }), legend]), wrap]);
  }

  /* One line over time (a share of pay, or your worth): 2px line, a light wash, the last point labelled. */
  function lineChart(points, o) {
    var phone = innerWidth <= 640, W = phone ? 350 : 880, H = 210, L = phone ? 40 : 52, R = phone ? 44 : 56, T = 18, B = 34, n = points.length;
    var vals = points.map(function (p) { return p.v; }), lo = o.zero ? 0 : Math.min.apply(null, vals), hi = Math.max.apply(null, vals.concat([o.zero ? 0.0001 : -Infinity]));
    var top = o.pct ? Math.max(0.2, Math.ceil(hi * 5 - 1e-9) / 5) : niceMax(hi - (o.zero ? 0 : Math.min(0, lo)), 4), bot = o.zero ? 0 : (lo < 0 ? -niceMax(-lo, 2) : 0);
    if (!o.zero && lo > 0 && !o.pct) { bot = Math.floor(lo / (top / 4)) * (top / 4); if (bot === top) bot = 0; }
    var pw = W - L - R, ph = H - T - B, x = function (i) { return n === 1 ? L + pw / 2 : L + pw * i / (n - 1); }, y = function (v) { return T + ph - (v - bot) / (top - bot) * ph; };
    var fmtV = o.pct ? function (v) { return Math.round(v * 100) + '%'; } : function (v) { return axisMoney(v, Math.max(Math.abs(top), Math.abs(bot))); };
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + escH(o.label) + '">';
    for (var i = 0; i <= 4; i++) { var v = bot + (top - bot) / 4 * i; svg += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" class="vz-grid' + (v === 0 ? ' base' : '') + '"/><text x="' + (L - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end" class="vz-ax">' + fmtV(v) + '</text>'; }
    var path = points.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1); }).join('');
    if (n > 1) svg += '<path d="' + path + 'L' + x(n - 1).toFixed(1) + ' ' + y(Math.max(bot, 0)) + 'L' + x(0).toFixed(1) + ' ' + y(Math.max(bot, 0)) + 'z" fill="' + o.color + '" opacity=".1"/><path d="' + path + '" fill="none" stroke="' + o.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    var every = Math.ceil(n / (phone ? 6 : 12));
    points.forEach(function (p, i) {
      if (i % every === 0 || i === n - 1) svg += '<text x="' + x(i) + '" y="' + (H - B + 17) + '" text-anchor="middle" class="vz-ax x">' + escH(p.r.month.slice(0, 3)) + '</text>';
      if (i === 0 || p.r.month === 'January') svg += '<text x="' + x(i) + '" y="' + (H - 3) + '" text-anchor="middle" class="vz-ax yr">' + escH(p.r.year) + '</text>';
    });
    svg += '<line class="vz-cross" x1="0" x2="0" y1="' + T + '" y2="' + (T + ph) + '"/><circle class="vz-dot hov" r="5" fill="' + o.color + '"/>';
    svg += '<circle class="vz-dot" cx="' + x(n - 1) + '" cy="' + y(points[n - 1].v) + '" r="5" fill="' + o.color + '"/><text x="' + (x(n - 1) + 10) + '" y="' + (y(points[n - 1].v) + 4) + '" class="vz-lab">' + (o.pct ? Math.round(points[n - 1].v * 100) + '%' : (o.short ? o.short(points[n - 1].v) : money(Math.round(points[n - 1].v)))) + '</text>';
    svg += '<rect class="vz-hit" x="' + L + '" y="' + T + '" width="' + pw + '" height="' + ph + '" tabindex="0" role="img" aria-label="' + escH(o.label + '. ' + points.map(function (p) { return recLabel(p.r, true) + ' ' + (o.pct ? Math.round(p.v * 100) + '%' : money(Math.round(p.v))); }).join(', ')) + '"/></svg>';
    var wrap = h('div', { class: 'viz', html: svg }), tip = vizTip(wrap), cross = wrap.querySelector('.vz-cross'), dot = wrap.querySelector('.vz-dot.hov'), hit = wrap.querySelector('.vz-hit'), cur = -1;
    var at = function (i) {
      cur = i; var p = points[i], w = wrap.getBoundingClientRect(), k = w.width / W;
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(p.v)); wrap.classList.add('hov');
      tip.show([h('div', { class: 'vt-h', text: recLabel(p.r, true) }), tipRow(o.color, o.name, o.pct ? Math.round(p.v * 100) + '%' : money(Math.round(p.v)), p.note)], x(i) * k, y(p.v) * k);
    };
    var off = function () { wrap.classList.remove('hov'); tip.hide(); cur = -1; };
    hit.addEventListener('pointermove', function (e) { var b = hit.getBoundingClientRect(), i = n === 1 ? 0 : Math.round((e.clientX - b.left) / b.width * (n - 1)); i = Math.max(0, Math.min(n - 1, i)); if (i !== cur) at(i); });
    hit.addEventListener('pointerleave', off); hit.addEventListener('blur', off);
    hit.addEventListener('focus', function () { at(n - 1); });
    hit.addEventListener('keydown', function (e) { if (e.key === 'ArrowLeft' && cur > 0) { e.preventDefault(); at(cur - 1); } if (e.key === 'ArrowRight' && cur < n - 1) { e.preventDefault(); at(cur + 1); } });
    return wrap;
  }
  function sparkSVG(vals, color) {
    if (vals.length < 2) return '';
    var W = 96, H = 28, lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), sp = hi - lo || 1;
    var pt = function (v, i) { return (2 + (W - 8) * i / (vals.length - 1)).toFixed(1) + ' ' + (H - 5 - (v - lo) / sp * (H - 10)).toFixed(1); };
    var last = pt(vals[vals.length - 1], vals.length - 1).split(' ');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true"><path d="M' + vals.map(pt).join('L') + '" fill="none" stroke="#B3ACBB" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><circle cx="' + last[0] + '" cy="' + last[1] + '" r="3" fill="' + (color || VIZ.accent) + '" stroke="#fff" stroke-width="1.5"/></svg>';
  }
  function insTile(label, value, delta, spark, color) {
    return h('div', { class: 'ins-tile' }, [h('small', { text: label }), h('b', { text: value }),
      delta ? h('span', { class: 'ins-d ' + (delta.tone || '') }, [delta.arrow ? h('i', { text: delta.arrow }) : null, delta.text]) : h('span', { class: 'ins-d' }, [' ']),
      spark && spark.length > 1 ? h('span', { class: 'ins-sp', html: sparkSVG(spark, color) }) : null]);
  }
  // v4.1: overall worth and where it's heading, at the top of Insights
  function insWorth() {
    var ov = worthOverview(), W = worthNow();
    var hero = ov.querySelector('.g-hero'); if (hero) hero.remove();
    ov.querySelectorAll('.ov-card').forEach(function (c) { if (c.querySelector('.ov-debts')) c.remove(); });
    var chart = ov.querySelector('.ov-card'), tiles = ov.querySelector('.ov-tiles');
    if (tiles) {
      var dir = (worthAfter(12) - W.total) / 12, up = dir >= 0, flat = Math.abs(dir) < 0.5;
      tiles.append(h('div', { class: 'ov-tile ov-diff ' + (flat ? 'flat' : up ? 'up' : 'down') }, [h('small', { text: 'The difference' }),
        h('b', { text: (W.total < 0 ? '−' : '') + money(Math.round(Math.abs(W.total))) }),
        h('span', { text: flat ? 'Holding steady' : (up ? '▲ Heading up about ' : '▼ Heading down about ') + money(Math.round(Math.abs(dir))) + ' a month' })]));
      if (chart) chart.after(tiles);
    }
    return h('div', { class: 'ins-worth' }, [ov]);
  }
  function insightsBody() {
    var all = recsSorted(), pro = isPro();
    if (all.length < 2) return h('div', { class: 'ins' }, [h('div', { class: 'ins-empty' }, [
      h('span', { class: 'ins-empty-ink', html: inkStampSVG('', MONTHS[new Date().getMonth()], new Date().getFullYear(), 'INSIGHTS') }),
      h('h2', { text: all.length ? 'One more stamp and your trends start here' : 'Stamp two months and your trends start here' }),
      h('p', { text: 'Insights compares the months you’ve stamped: where your pay went, how much you saved and invested, and which lines are creeping up. It needs at least two months to compare.' }),
      btn('pill-btn primary', 'Go to your planner', function () { go('plan'); }, ['Go to your planner']) ])]);
    var recs = insRecs(), data = recs.map(function (r) { return { r: r, s: recSplit(r) }; }), n = data.length;
    var avg = function (f) { return data.reduce(function (a, d) { return a + f(d); }, 0) / n; };
    var rate = avg(function (d) { return d.s.rate; }), pay = avg(function (d) { return d.s.income; }), costR = avg(function (d) { return d.s.income > 0 ? d.s.costs / d.s.income : 0; });
    var first = data[0], last = data[n - 1], dr = Math.round(last.s.rate * 100) - Math.round(first.s.rate * 100), dc = Math.round((last.s.income > 0 ? last.s.costs / last.s.income : 0) * 100) - Math.round((first.s.income > 0 ? first.s.costs / first.s.income : 0) * 100);
    var since = 'since ' + first.r.month;
    var ranges = [['3', '3 months'], ['6', '6 months'], ['12', '12 months'], ['year', 'This year'], ['all', 'All']];
    var filter = h('div', { class: 'ins-filter' }, [h('div', { class: 'seg-o', role: 'group', 'aria-label': 'Months to show' }, ranges.map(function (r) {
      var locked = !pro && r[0] !== '3';
      return btn(locked ? 'lock' : '', r[1] + (locked ? ' (Pro)' : ''), function () { if (locked) { set({ insPeek: true }); setTimeout(function () { var el = document.getElementById('ins-pro'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 60); return; } track('insights_range', r[0]); set({ insRange: r[0] }); }, [r[1], locked ? proTag() : null], { 'aria-pressed': String(insRange() === r[0]) });
    })), h('small', { text: n + (n === 1 ? ' stamped month' : ' stamped months') + ', ' + recLabel(first.r, true) + (n > 1 ? ' to ' + recLabel(last.r, true) : '') })]);
    var kids = [filter];
    kids.push(h('div', { class: 'ins-tiles' }, [
      insTile('Saved and invested, on average', Math.round(rate * 100) + '% of pay', n > 1 ? { text: (dr === 0 ? 'No change ' : Math.abs(dr) + (Math.abs(dr) === 1 ? ' point ' : ' points ') + (dr > 0 ? 'up ' : 'down ')) + since, arrow: dr > 0 ? '↑' : dr < 0 ? '↓' : '', tone: dr > 0 ? 'good' : dr < 0 ? 'bad' : '' } : null, data.map(function (d) { return d.s.rate; }), VIZ.investSavings),
      insTile('Costs, on average', Math.round(costR * 100) + '% of pay', n > 1 ? { text: (dc === 0 ? 'No change ' : Math.abs(dc) + (Math.abs(dc) === 1 ? ' point ' : ' points ') + (dc > 0 ? 'up ' : 'down ')) + since, arrow: dc > 0 ? '↑' : dc < 0 ? '↓' : '', tone: dc < 0 ? 'good' : dc > 0 ? 'bad' : '' } : null, data.map(function (d) { return d.s.income > 0 ? d.s.costs / d.s.income : 0; }), VIZ.costs),
      insTile('Pay, on average', money(Math.round(pay)), n > 1 ? { text: money(Math.round(Math.min.apply(null, data.map(function (d) { return d.s.income; })))) + ' to ' + money(Math.round(Math.max.apply(null, data.map(function (d) { return d.s.income; })))) } : null, data.map(function (d) { return d.s.income; })),
      insTile('Stamped in a row', String(stampStreak(recIdx(all[all.length - 1]))) + (stampStreak(recIdx(all[all.length - 1])) === 1 ? ' month' : ' months'), { text: all.length + ' stamped in all' }) ]));
    kids.push(splitChart(recs));
    kids.push(insWorth());
    if (!pro) { kids.push(insLocked()); return h('div', { class: 'ins' }, kids); }
    // the share of pay saved and invested
    kids.push(h('div', { class: 'ins-card' }, [h('div', { class: 'ins-h' }, [h('h2', { text: 'Saved and invested, as a share of your pay' })]),
      lineChart(data.map(function (d) { return { r: d.r, v: d.s.rate, note: money(Math.round(d.s.investSavings)) }; }), { pct: true, zero: true, color: VIZ.investSavings, name: 'Saved and invested', label: 'Share of your pay saved and invested each month' }) ]));
    // worth at each stamp, once there are two real snapshots
    var ws = recs.filter(function (r) { return r.worth && typeof r.worth.t === 'number'; });
    if (ws.length >= 2) kids.push(h('div', { class: 'ins-card' }, [h('div', { class: 'ins-h' }, [h('h2', { text: 'Your total worth, each time you stamped' }), h('small', { text: 'Savings + investments + pensions − debts, as PayStamp had them on the day' })]),
      lineChart(ws.map(function (r) { return { r: r, v: r.worth.t }; }), { color: VIZ.accent, name: 'Total worth', label: 'Your total worth at each stamp' }) ]));
    else kids.push(h('p', { class: 'ins-note', text: 'From now on PayStamp notes your total worth each time you stamp. After two stamps you’ll see it charted here, as a true history.' }));
    kids.push(insLines(data));
    kids.push(insYear(all));
    return h('div', { class: 'ins' }, kids);
  }
  // Line by line: the table twin of the charts, with what moved most at the top.
  function insLines(data) {
    var n = data.length, lines = {}, order = [];
    data.forEach(function (d, j) { (d.r.items || []).forEach(function (x) {
      if (recGroupKey(x) === 'income') return;
      if (!lines[x.id]) { lines[x.id] = { id: x.id, name: x.name, gk: recGroupKey(x), v: [] }; order.push(x.id); }
      lines[x.id].name = x.name; lines[x.id].v[j] = Number(x.value) || 0;
    }); });
    var rows = order.map(function (id) {
      var l = lines[id], vals = []; for (var j = 0; j < n; j++) vals.push(l.v[j] || 0);
      var a = vals.reduce(function (p, c) { return p + c; }, 0) / n, last = vals[n - 1];
      return { l: l, vals: vals, avg: a, last: last, lo: Math.min.apply(null, vals), hi: Math.max.apply(null, vals), d: last - a };
    }).filter(function (r) { return r.hi > 0; });
    var sort = state.insSort || 'move';
    rows.sort(sort === 'big' ? function (a, b) { return b.avg - a.avg; } : function (a, b) { return Math.abs(b.d) - Math.abs(a.d); });
    var lastLabel = data[n - 1].r.month;
    var head = h('div', { class: 'il-r il-head' }, [h('span', { text: 'Line' }), h('span', { text: 'Trend' }), h('span', { text: 'Average' }), h('span', { text: 'Lowest' }), h('span', { text: 'Highest' }), h('span', { text: lastLabel }), h('span', { text: 'Against average' })]);
    return h('div', { class: 'ins-card' }, [
      h('div', { class: 'ins-h' }, [h('h2', { text: 'Line by line' }),
        h('div', { class: 'seg-o sm', role: 'group', 'aria-label': 'Order' }, [['move', 'Moved most'], ['big', 'Biggest']].map(function (s) { return btn('', s[1], function () { set({ insSort: s[0] }); }, [s[1]], { 'aria-pressed': String(sort === s[0]) }); }))]),
      h('div', { class: 'il', role: 'table', 'aria-label': 'Each line across these months' }, [head].concat(rows.map(function (r) {
        var up = r.d > 0.5, dn = r.d < -0.5, good = r.l.gk === 'investSavings' ? up : dn;
        return h('button', { type: 'button', class: 'il-r', role: 'row', title: 'Open ' + r.l.name + ' in your planner', onclick: function () { if (findItem(r.l.id)) openInPlanner(r.l.id); else go('history'); } }, [
          h('span', { class: 'il-n' }, [h('i', { style: 'background:' + (VIZ[r.l.gk] || VIZ.other) }), r.l.name]),
          h('span', { class: 'il-sp', html: sparkSVG(r.vals, VIZ[r.l.gk]) }),
          h('span', { text: money(Math.round(r.avg)) }), h('span', { text: money(Math.round(r.lo)) }), h('span', { text: money(Math.round(r.hi)) }), h('span', { class: 'b', text: money(Math.round(r.last)) }),
          h('span', { class: 'il-d' + (up || dn ? (good ? ' good' : ' bad') : '') }, [up ? '↑ ' + money(Math.round(r.d)) + ' above' : dn ? '↓ ' + money(Math.round(-r.d)) + ' below' : 'On average']) ]);
      }))) ]);
  }
  // The calendar year so far, as one whole split into parts.
  function insYear(all) {
    var y = all[all.length - 1].year, yr = all.filter(function (r) { return String(r.year) === String(y); }), t = { income: 0, investSavings: 0, costs: 0, guiltFree: 0, other: 0 };
    yr.forEach(function (r) { var s = recSplit(r); Object.keys(t).forEach(function (k) { t[k] += s[k]; }); });
    if (!(t.income > 0)) return null;
    var keys = VIZ_KEYS.filter(function (k) { return t[k] > 0; }), out = keys.reduce(function (a, k) { return a + t[k]; }, 0), base = Math.max(t.income, out);
    return h('div', { class: 'ins-card' }, [
      h('div', { class: 'ins-h' }, [h('h2', { text: y + ' so far' }), h('small', { text: yr.length + (yr.length === 1 ? ' stamped month' : ' stamped months') })]),
      h('p', { class: 'ins-year', text: 'You’ve been paid ' + money(Math.round(t.income)) + ' and put ' + money(Math.round(t.investSavings)) + ' into investments and savings, ' + pct(t.investSavings, t.income) + ' of it.' }),
      h('div', { class: 'tsb', role: 'img', 'aria-label': keys.map(function (k) { return vizName(k) + ' ' + money(Math.round(t[k])) + ', ' + pct(t[k], t.income); }).join('. ') }, keys.map(function (k) {
        return h('span', { class: 'tsb-s', style: 'flex:' + (t[k] / base).toFixed(4) + ' 1 0;background:' + VIZ[k] + ';color:' + inkOn(VIZ[k]), title: vizName(k) + ': ' + money(Math.round(t[k])) + ', ' + pct(t[k], t.income) + ' of pay' }, [h('span', { text: pct(t[k], t.income) })]);
      })),
      h('div', { class: 'viz-leg' }, keys.map(function (k) { return h('span', {}, [h('i', { style: 'background:' + VIZ[k] }), vizName(k) + ' ' + money(Math.round(t[k]))]); })) ]);
  }
  function insLocked() {
    return h('div', { class: 'ins-lock', id: 'ins-pro' }, [
      h('div', { class: 'ins-lock-t' }, [proTag(), h('h2', { text: 'See every month, not just the last three' }),
        h('ul', {}, [h('li', { text: 'Your savings rate as a line over 6 months, a year or all time' }), h('li', { text: 'Line by line: average, lowest, highest, and what’s creeping up' }), h('li', { text: 'Your total worth at each stamp, as a true history' }), h('li', { text: 'The year so far, split into where it went' })]),
        proCta('ins') ]),
      h('div', { class: 'ins-lock-v', 'aria-hidden': 'true', html: '<svg viewBox="0 0 320 150"><g class="vz-grid-g"><line x1="20" x2="310" y1="20" y2="20"/><line x1="20" x2="310" y1="60" y2="60"/><line x1="20" x2="310" y1="100" y2="100"/><line x1="20" x2="310" y1="140" y2="140"/></g><path d="M20 118 L62 110 L104 96 L146 100 L188 78 L230 70 L272 52 L310 40 L310 140 L20 140z" fill="#3C9B6C" opacity=".1"/><path d="M20 118 L62 110 L104 96 L146 100 L188 78 L230 70 L272 52 L310 40" fill="none" stroke="#3C9B6C" stroke-width="2" stroke-linejoin="round"/><circle cx="310" cy="40" r="5" fill="#3C9B6C" stroke="#fff" stroke-width="2"/></svg>' }) ]);
  }

  /* ================= v4: PayStamp Pro =================
     Two ways to pay (monthly or yearly), a 14-day trial with no card, and a small free taste of Penny.
     The live site supplies: PayStamp.isPro(), startCheckout(plan), manageBilling(), startTrial(), trialStartedAt().
     In the preview nothing is charged: the buttons only switch what you see. */
  var PRO_YEAR = '£19.99', PRO_TRIAL_DAYS = 14;
  function trialInfo() {
    var P = window.PayStamp || {}, t = state.proTrial, start = P.trialStartedAt && !P.preview ? P.trialStartedAt() : (t && t.start);
    if (!start) return { used: false, on: false, left: PRO_TRIAL_DAYS };
    var end = new Date(start).getTime() + PRO_TRIAL_DAYS * 864e5, left = Math.ceil((end - Date.now()) / 864e5);
    return { used: true, on: left > 0, left: Math.max(0, left), end: end };
  }
  function isPaidPro() { var P = window.PayStamp || {}; if (P.preview) return !!state.pvPro; return !!(P.isPro && P.isPro()); }
  function isFounderPro() { return !!(state.founder && state.founder.number); }
  // v4.3: PayStamp is completely free for now: every feature is open to everyone and there's no Pro to buy.
  var PRO_OFF = true;
  function isPro() { return PRO_OFF || isPaidPro() || isFounderPro() || trialInfo().on; }
  function startTrial() {
    var P = window.PayStamp || {};
    if (trialInfo().used) { go('pro'); return; }
    if (needsSignal('Starting a trial')) return;
    track('trial_start');
    if (P.startTrial && !P.preview) { P.startTrial().then(function () { showUndo('Your ' + PRO_TRIAL_DAYS + '-day Pro trial has started. No card needed.'); scheduleRender(); }, function () { showUndo('Your trial couldn’t start just now. Please try again.'); }); return; }
    set({ proTrial: { start: new Date().toISOString() }, trialEndSeen: false });
    showUndo('Your ' + PRO_TRIAL_DAYS + '-day Pro trial has started. No card needed.');
  }
  function proUpgrade(plan) {
    var P = window.PayStamp || {}; plan = plan === 'year' || plan === 'month' ? plan : (state.proPlan || 'year');
    if (needsSignal('Paying for Pro')) return;
    track('upgrade', plan);
    if (P.startCheckout && !P.preview) { if (P.startCheckout(plan) === false) showUndo('Payments aren’t switched on yet. Please try again soon.'); return; }
    set({ pvPro: true }); showUndo('Preview: you’re now seeing PayStamp as a Pro member (' + (plan === 'year' ? 'yearly' : 'monthly') + '). Nothing was charged.', function () { set({ pvPro: false }); });
  }
  // The one call to action used wherever something is part of Pro.
  function proCta(where) {
    var t = trialInfo();
    return h('div', { class: 'pro-cta' }, [
      t.used ? btn('pro-go', 'See Pro plans', function () { go('pro'); }, ['Get PayStamp Pro'])
        : btn('pro-go', 'Start a ' + PRO_TRIAL_DAYS + '-day free trial of Pro', startTrial, ['Try Pro free for ' + PRO_TRIAL_DAYS + ' days']),
      h('small', { text: t.used ? PRO_PRICE + ' a month or ' + PRO_YEAR + ' a year. Cancel any time.' : 'No card needed. After that it’s ' + PRO_PRICE + ' a month or ' + PRO_YEAR + ' a year, only if you choose to carry on.' }),
      where === 'page' ? null : btn('cp-inline', 'See what’s free and what’s in Pro', function () { go('pro'); }, ['See what’s free and what’s in Pro ›']) ]);
  }
  var PRO_PEEK = {
    hustle: ['Log what each side hustle brings in and what it costs', 'See your profit for the tax year at a glance', 'Know what to put aside for tax, and send it straight to your planner'],
    topic: ['Short lessons in plain English', 'A working part built from your own numbers', 'A checklist that keeps you moving'] };
  function proGate(title, sub, key) {
    track('pro_gate', key || curPage(), true);
    var isTopic = false, L = [], idx = [], first = null, c = null; // v4.1: no Compass lessons
    var points = isTopic && idx.length > 1 ? idx.slice(1, 5).map(function (i) { return L[i] ? L[i][0] : null; }).filter(Boolean) : PRO_PEEK[/hustle/i.test(title) ? 'hustle' : 'topic'];
    return h('div', { class: 'pgate' }, [
      h('div', { class: 'pgate-m' }, [
        h('div', { class: 'pgate-h' }, [proTag(), h('h2', { text: title + ' is part of PayStamp Pro' })]),
        sub ? h('p', { class: 'pgate-sub', text: sub }) : null,
        h('ul', { class: 'pgate-l' }, points.map(function (p) { return h('li', {}, [h('span', { class: 'pgate-tick', html: TICK_SVG }), p]); })),
        isTopic && idx.length > 5 ? h('small', { class: 'pgate-more', text: 'and ' + (idx.length - 5) + ' more, about ' + (c && c.mins ? c.mins : 4) + ' minutes in all' }) : null,
        proCta('gate') ]),
      first ? h('aside', { class: 'pgate-s' }, [h('small', { text: 'The first lesson, free' }), h('h3', { text: first[0] }), h('div', { class: 'pgate-tx' }, rich(first[1]))]) : null ]);
  }
  var PRO_FEATS = [
    ['history', 'Insights without limits', 'Every stamped month charted: your savings rate over time, each line’s average and what’s creeping up, and your worth at each stamp.', 'insights'],
    ['bag', 'PayStamp Hustle', 'Track side hustles, see your profit for the tax year and put tax aside as you go.', 'hustle'],
    ['group', 'Moai, when it arrives', 'Save as a group and take the pot in turns. Coming soon, and included.', null] ];
  var PRO_FAQ = [
    ['What stays free?', 'Everything you need to plan your pay: the Monthly Planner with its columns and email reminders, Investments, Savings and Debt with their What if calculators, Records, the Couples planner, and Insights for your last three months. Nothing that’s free today will move into Pro.'],
    ['How does the free trial work?', 'Press the button and Pro opens for ' + PRO_TRIAL_DAYS + ' days. You don’t give card details, so nothing can be taken at the end. If you want to keep Pro, you choose a plan then.'],
    ['Can I cancel?', 'Yes, any time, from this page. You keep Pro until the end of the month or year you’ve paid for.'],
    ['What happens to my plan if I stop?', 'Nothing is deleted. Your planner, records and everything free carry on as before. The Pro pages lock again, with your work kept safe inside them.'],
    ['How do I pay?', 'By card, Apple Pay or Google Pay through Stripe, who sell PayStamp Pro for us as Onelink and handle the VAT. PayStamp never sees or stores your card details. Your receipt comes from Onelink, and the price includes VAT.'] ];
  function proBody() {
    var pro = isPro(), paid = isPaidPro(), F = state.founder || {}, t = trialInfo(), plan = state.proPlan || 'year', P = window.PayStamp || {};
    var planCard = function (key, name, price, per, note) {
      return h('button', { type: 'button', class: 'pplan' + (plan === key ? ' on' : ''), 'aria-pressed': String(plan === key), onclick: function () { set({ proPlan: key }); } }, [
        h('span', { class: 'pplan-n' }, [name, note ? h('i', { text: note }) : null]), h('span', { class: 'pplan-p' }, [h('b', { text: price }), h('small', { text: per })]) ]);
    };
    var status = paid ? ['You’re on PayStamp Pro', 'Everything in PayStamp is open to you. Thank you for supporting it.']
      : isFounderPro() ? ['Pro is free for you as a founding member', 'Thank you for being one of the first. Founding members have Pro free for now.']
      : t.on ? ['Your free trial has ' + t.left + (t.left === 1 ? ' day' : ' days') + ' left', 'Everything in Pro is open. Choose a plan any time to keep it going after your trial.'] : null;
    var hero = h('div', { class: 'pro2-hero' }, [
      h('span', { class: 'pro-badge' }, ['PayStamp ', h('b', { text: 'Pro' })]),
      h('h2', { text: status ? status[0] : 'Get more from every payday' }),
      h('p', { text: status ? status[1] : 'Planning your pay stays free. Pro adds Insights for every month and PayStamp Hustle, with more to come.' }),
      paid || isFounderPro() ? (P.manageBilling && paid ? h('div', { class: 'pro2-manage' }, [btn('pro-alt', 'Manage or cancel your plan', function () { if (P.manageBilling() === false) showUndo('The billing page isn’t set up yet.'); }, ['Manage or cancel your plan']), h('small', { class: 'pro2-fine', text: 'Opens Onelink by Stripe, who take PayStamp’s payments. Sign in there with the email you paid with.' })]) : null)
        : h('div', { class: 'pro2-buy' }, [
            h('div', { class: 'pplans', role: 'group', 'aria-label': 'Choose a plan' }, [planCard('year', 'Yearly', PRO_YEAR, 'a year', '2 months free'), planCard('month', 'Monthly', PRO_PRICE, 'a month')]),
            h('div', { class: 'pro2-btns' }, [
              t.used ? null : btn('pro-go', 'Start a ' + PRO_TRIAL_DAYS + '-day free trial', startTrial, ['Try Pro free for ' + PRO_TRIAL_DAYS + ' days']),
              btn(t.used ? 'pro-go' : 'pro-alt', 'Subscribe to Pro, ' + (plan === 'year' ? 'yearly' : 'monthly'), function () { proUpgrade(plan); }, [(t.on ? 'Keep Pro: ' : 'Subscribe: ') + (plan === 'year' ? PRO_YEAR + ' a year' : PRO_PRICE + ' a month')]) ]),
            h('small', { class: 'pro2-fine' }, [(t.used ? '' : 'The trial needs no card. ') + 'Cancel any time. Prices include VAT. Payments are taken securely by Stripe. ', h('a', { href: '/terms.html', target: '_blank', rel: 'noopener', text: 'Pro terms' })]) ]) ]);
    var row = function (label, free, prov) { return h('div', { class: 'pro-r' }, [h('span', { text: label }), h('span', { class: free ? 'y' : 'n', text: free === true ? '✓' : free || '–' }), h('span', { class: 'y', text: prov || '✓' })]); };
    return h('div', { class: 'pro2' }, [
      hero,
      h('div', { class: 'pro2-feats' }, PRO_FEATS.map(function (f) {
        return h('div', { class: 'pfeat' }, [h('span', { class: 'pfeat-ic', html: IC[f[0]] || '' }), h('b', { text: f[1] }), h('p', { text: f[2] }),
          f[3] ? btn('cp-inline', 'Open ' + f[1], function () { go(f[3]); }, [pro ? 'Open ›' : 'Take a look ›'])  : null ]);
      })),
      h('h2', { class: 'pro2-h', text: 'Free and Pro, side by side' }),
      h('div', { class: 'pro-t' }, [h('div', { class: 'pro-r h' }, [h('span', { text: 'What you get' }), h('span', { text: 'Free' }), h('span', { text: 'Pro' })]),
        row('Monthly Planner, with stamps', true), row('Investments, Savings and Debt', true), row('Records', true), row('Couples planner', true),
        row('What if calculators', true), row('Insights', '3 months', 'All'),
        row('PayStamp Hustle', false), row('Moai', false, 'Soon')]),
      h('div', { class: 'pro2-why' }, [h('h2', { class: 'pro2-h', text: 'What your subscription pays for' }),
        h('div', { class: 'pro2-why-g' }, [
          h('div', {}, [h('b', { text: 'No adverts, ever' }), h('small', { text: 'PayStamp is paid for by the people who use it, not by advertisers.' })]),
          h('div', {}, [h('b', { text: 'Your data is never sold' }), h('small', { text: 'Your plan is yours. It’s stored to run your account and for nothing else.' })]),
          h('div', {}, [h('b', { text: 'It keeps the lights on' }), h('small', { text: 'The servers, emails and new features all cost money to run.' })]) ])]),
      h('h2', { class: 'pro2-h', text: 'Questions about Pro' }),
      h('div', { class: 'pro2-faq' }, PRO_FAQ.map(function (q) { return h('details', {}, [h('summary', { text: q[0] }), h('p', { text: q[1] })]); })) ]);
  }
  // In the bar while a trial is running, where the founder note usually sits.
  function trialChip() {
    var t = trialInfo(); if (!t.on || isPaidPro() || isFounderPro()) return null;
    return btn('pn-fpill pn-trial', 'Your Pro trial has ' + t.left + ' days left. See plans', function () { go('pro'); }, [h('b', { text: String(t.left) }), h('span', { class: 'fp-long', text: t.left === 1 ? ' day of Pro trial left' : ' days of Pro trial left' }), h('span', { class: 'fp-short', text: t.left === 1 ? ' day left' : ' days left' })]);
  }
  // Shown once on the planner after a trial ends.
  function trialEndedCard() {
    var t = trialInfo(); if (!t.used || t.on || isPro() || state.trialEndSeen) return null;
    return h('div', { class: 'tend' }, [h('div', {}, [h('b', { text: 'Your Pro trial has ended' }), h('small', { text: 'Everything you made is still here, and all the free parts carry on as before. Keep Pro from ' + PRO_PRICE + ' a month.' })]),
      btn('pill-btn primary', 'See Pro plans', function () { state.trialEndSeen = true; go('pro'); }, ['See plans']), btn('pill-btn', 'Not now', function () { set({ trialEndSeen: true }); }, ['Not now'])]);
  }

  /* ================= v4: small-screen manners =================
     On a phone the floating Penny and Tell us buttons step aside while you scroll down or type, and come back when you scroll up. */
  (function () {
    var lastY = 0, tick = false;
    window.addEventListener('scroll', function () {
      if (tick) return; tick = true;
      requestAnimationFrame(function () {
        var y = window.scrollY, d = y - lastY;
        if (Math.abs(d) > 8) { document.body.classList.toggle('fabs-off', d > 0 && y > 120); lastY = y; }
        tick = false;
      });
    }, { passive: true });
  })();

  /* ================= v4: the usage log =================
     A one-line note when someone does a key thing: which page, never amounts or anything in a plan.
     Sent in small batches by PayStamp.logEvent (live site). Anyone can switch it off in Your details › Your data.
     Events: open, page, plan_built, stamp, penny_ask, search, sum, job_idea, undo, insights_range, pro_gate, trial_start, upgrade. */
  var trackSeen = {};
  function track(name, detail, once) {
    if (state.noUsageLog) return;
    var key = name + '|' + (detail || '');
    if (once) { if (trackSeen[key]) return; trackSeen[key] = 1; }
    var P = window.PayStamp || {};
    try { if (P.logEvent) P.logEvent(name, curPage(), detail == null ? null : String(detail)); } catch (e) {}
  }

  /* ================= v4: Admin › Usage (owner only) =================
     How people use PayStamp: who's active, how far new people get, which pages they open, what they use, and the paid side.
     Loaded from admin_usage(days) in supabase-v4.0.sql. Your own use is left out. */
  var usageData = {}, usageBusy = false, usageErr = '';
  // v4.1: admin_usage_more(days): one definition of "active" everywhere, the home page funnel, and every event by name
  var usageMore = {}, usageMoreBusy = {};
  function usageMoreLoad(days) {
    var P = window.PayStamp || {}; if (!P.adminUsageMore || usageMoreBusy[days]) return;
    usageMoreBusy[days] = true;
    P.adminUsageMore(days).then(function (d) { usageMore[days] = d || {}; usageMoreBusy[days] = false; scheduleRender(); }, function () { usageMore[days] = { error: true }; usageMoreBusy[days] = false; scheduleRender(); });
  }
  var EVENT_NAMES = { cols: 'Columns beside the plan', email_tick: 'Email reminder ticks', currency: 'Changed currency', review: 'Cost review (✓ ? ✕)', remind_set: 'Set a Remind me date',
    whatif: 'Opened a What if', whatif_chart: 'Switched What if chart', whatif_goal_added: 'Added a goal from What if', debt_free: 'Ticked debt free', couple_amount: 'Changed a couples amount',
    automated: 'Ticked Automated', stamp: 'Stamped a month', sum: 'Typed a sum', undo: 'Used undo', job_idea: 'Used Give it a job', penny_ask: 'Asked Penny', insights_range: 'Changed the Insights range',
    plan_built: 'Built a plan', trial_start: 'Started a Pro trial', upgrade: 'Pressed Subscribe', pro_gate: 'Met a Pro page', penny_free_out: 'Used all free Penny questions', search: 'Used search' };
  function usageLoad(days) {
    var P = window.PayStamp || {}; if (!P.adminUsage || usageBusy) return;
    usageBusy = true; usageErr = '';
    P.adminUsage(days).then(function (d) { usageData[days] = d || {}; usageBusy = false; scheduleRender(); },
      function (e) { usageBusy = false; usageErr = (e && e.message) || 'Couldn’t load'; scheduleRender(); });
  }
  var USAGE_PAGES = { plan: 'Monthly Planner', investments: 'Investments', savings: 'Savings', debt: 'Debt', history: 'Records', insights: 'Insights', compass: 'Compass overview',
    couples: 'Couples planner', hustle: 'PayStamp Hustle', pro: 'PayStamp Pro', accounts: 'Bank accounts', account: 'Your details', help: 'Help & what’s new', privacy: 'Privacy', app: 'Get the app', 'cp-direct': 'Shape PayStamp', admin: 'Admin' };
  function usagePageName(k) { return USAGE_PAGES[k] || (/^cp-/.test(k || '') ? 'Compass (old): ' + k.slice(3) : k || 'Unknown'); }
  var USAGE_FEATS = [['penny_ask', 'Asked Penny a question'], ['search', 'Used search (Ctrl + K)'], ['sum', 'Typed a sum into an amount box'], ['job_idea', 'Used Give it a job'], ['undo', 'Used undo'], ['insights_range', 'Changed the Insights range']];
  function usageBody() {
    var P = window.PayStamp || {}, days = state.adminDays || 30, D = usageData[days];
    if (!D && !usageBusy && !usageErr) setTimeout(function () { usageLoad(days); }, 0);
    var seg = h('div', { class: 'seg-o sm', role: 'group', 'aria-label': 'Period' }, [[7, '7 days'], [30, '30 days'], [90, '90 days']].map(function (x) {
      return btn('', 'Last ' + x[1], function () { usageErr = ''; set({ adminDays: x[0] }); }, [x[1]], { 'aria-pressed': String(days === x[0]) });
    }));
    if (!D && isOffline()) return h('div', { class: 'us' }, [seg, h('p', { class: 'f-hint', text: 'You’re offline. The usage numbers load when you’re back online.' })]);
    if (usageErr) return h('div', { class: 'us' }, [seg, h('p', { class: 'f-hint', style: 'color:var(--warn)', text: 'Couldn’t load the usage numbers: ' + usageErr + '. Have you run supabase-v4.1.sql?' }), btn('pill-btn', 'Try again', function () { usageErr = ''; usageLoad(days); }, ['Try again'])]);
    if (!D) return h('div', { class: 'us' }, [seg, h('p', { class: 'f-hint', text: 'Loading…' })]);
    var M = usageMore[days]; if (!M && !usageMoreBusy[days]) setTimeout(function () { usageMoreLoad(days); }, 0); M = M && !M.error ? M : null;
    var n = function (v) { return Number(v) || 0; }, F = D.funnel || {}, base = n(F.accounts);
    var stat = function (v, label, sub) { return h('div', { class: 'pa-stat' }, [h('b', { text: String(n(v)) }), h('small', { text: label }), sub ? h('span', { class: 'us-sub', text: sub }) : null]); };
    var bars = function (rows, max, fmtRight) {
      return h('div', { class: 'us-bars' }, rows.map(function (r) {
        var w = max > 0 ? Math.max(r.v > 0 ? 2 : 0, Math.round(r.v / max * 100)) : 0;
        return h('div', { class: 'us-br' }, [h('span', { class: 'us-bn', text: r.label }), h('span', { class: 'us-bt' }, [h('i', { style: 'width:' + w + '%' })]), h('span', { class: 'us-bv', text: fmtRight(r) })]);
      }));
    };
    var card = function (title, sub, kids) { return h('section', { class: 'us-card' }, [h('div', { class: 'us-h' }, [h('h3', { text: title }), sub ? h('small', { text: sub }) : null])].concat(kids)); };
    var steps = [['accounts', 'Made an account'], ['built', 'Built a plan'], ['stamp1', 'Stamped a month'], ['stamp2', 'Stamped 2 months'], ['stamp3', 'Stamped 3 months']];
    var funnel = card('New people: how far they get', 'People who made an account in the last ' + days + ' days', [base ? bars(steps.map(function (s) { return { label: s[1], v: n(F[s[0]]) }; }), base, function (r) { return r.v + ' · ' + Math.round(r.v / base * 100) + '%'; })
      : h('p', { class: 'f-hint', text: 'Nobody new in this period yet.' })]);
    var weeks = D.weeks || [], wmax = Math.max.apply(null, weeks.map(function (w) { return n(w.people); }).concat([1]));
    var weekly = card('People using PayStamp each week', 'Anyone who opened it that week', [weeks.length ? h('div', { class: 'us-cols', role: 'img', 'aria-label': weeks.map(function (w) { return 'Week of ' + w.week + ': ' + n(w.people); }).join(', ') }, weeks.map(function (w) {
      var d = new Date(w.week); return h('div', { class: 'us-col', title: 'Week of ' + d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) + ': ' + n(w.people) + ' people' }, [h('b', { text: String(n(w.people)) }), h('span', { class: 'us-cb' }, [h('i', { style: 'height:' + Math.round(n(w.people) / wmax * 100) + '%' })]), h('small', { text: d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) })]);
    })) : h('p', { class: 'f-hint', text: 'No visits logged yet.' })]);
    var pages = D.pages || [], pmax = Math.max.apply(null, pages.map(function (p) { return n(p.people); }).concat([1]));
    var pagesCard = card('Which pages people open', 'People who opened each page at least once', [pages.length ? bars(pages.map(function (p) { return { label: usagePageName(p.page), v: n(p.people), views: n(p.views) }; }), pmax, function (r) { return r.v + (r.v === 1 ? ' person' : ' people'); }) : h('p', { class: 'f-hint', text: 'No page visits logged yet.' })]);
    var fe = {}; (D.features || []).forEach(function (x) { fe[x.name] = x; });
    var feats = card('What people use', null, [h('div', { class: 'us-tbl' }, [h('div', { class: 'us-tr us-th' }, [h('span', { text: 'Feature' }), h('span', { text: 'People' }), h('span', { text: 'Times' })])].concat(USAGE_FEATS.map(function (f) {
      var x = fe[f[0]] || {}; return h('div', { class: 'us-tr' }, [h('span', { text: f[1] }), h('span', { text: String(n(x.people)) }), h('span', { text: String(n(x.times)) })]);
    })))]);
    var gates = D.gates || [];
    var pro = card('The paid side', null, [
      h('div', { class: 'pa-stats' }, [stat(D.trials, 'Trials started'), stat(D.upgrades, 'Pressed Subscribe'), stat(D.penny_free_out, 'Used all 3 free Penny questions')]),
      gates.length ? h('p', { class: 'us-note', text: 'Where people met a Pro page: ' + gates.map(function (g) { return usagePageName(g.page) + ' (' + n(g.people) + ')'; }).join(', ') + '.' }) : null ]);
    var report = function () {
      var L = ['PayStamp usage, last ' + days + ' days (my own use left out)', '', 'Active people: ' + n(D.active) + ' · new accounts: ' + n(D.new_accounts) + ' · months stamped: ' + n(D.stamps), '',
        'New people, how far they got:'].concat(steps.map(function (s) { return '- ' + s[1] + ': ' + n(F[s[0]]) + (base ? ' (' + Math.round(n(F[s[0]]) / base * 100) + '%)' : ''); }))
        .concat(['', 'People each week: ' + weeks.map(function (w) { return w.week + ' ' + n(w.people); }).join(', '), '', 'Pages (people):'])
        .concat(pages.map(function (p) { return '- ' + usagePageName(p.page) + ': ' + n(p.people) + ' people, ' + n(p.views) + ' visits'; }))
        .concat(['', 'Features (people / times):']).concat(USAGE_FEATS.map(function (f) { var x = fe[f[0]] || {}; return '- ' + f[1] + ': ' + n(x.people) + ' / ' + n(x.times); }))
        .concat(['', 'Pro: ' + n(D.trials) + ' trials started, ' + n(D.upgrades) + ' pressed Subscribe, ' + n(D.penny_free_out) + ' used all free Penny questions', 'Pro pages met: ' + gates.map(function (g) { return usagePageName(g.page) + ' ' + n(g.people); }).join(', '),
          '', 'Please review this: where do people drop off, what is and isn’t used, and what should I change in PayStamp?']);
      if (M) { var ins = ['', 'Home page (anonymous visits): opened ' + n((M.landing || {}).home) + ', started the builder ' + n(((M.landing || {}).steps || {})['1']) + ', finished it ' + n((M.landing || {}).try_done) + ', opened sign-up ' + n((M.landing || {}).signup_open) + ', created an account ' + n((M.landing || {}).signup_done),
          'Builder steps reached: ' + Object.keys((M.landing || {}).steps || {}).sort().map(function (k) { return 'step ' + k + ' ' + n(M.landing.steps[k]); }).join(', '),
          'Home page buttons pressed: ' + (Object.keys(M.taps || {}).map(function (k) { return (TAP_NAMES[k] || k) + ' ' + n(M.taps[k]); }).join(', ') || 'none yet'),
          'Came from: ' + ((M.referrers || []).map(function (r) { return r.site + ' ' + n(r.n); }).join(', ') || 'direct'), '', 'Every action (people / times):'].concat((M.events || []).map(function (e) { return '- ' + (EVENT_NAMES[e.name] || e.name) + (e.detail ? ' · ' + e.detail : '') + ': ' + n(e.people) + ' / ' + n(e.times); }));
        L.splice.apply(L, [L.length - 2, 0].concat(ins)); }
      copyText(L.join('\n'), 'usageCopy');
    };
    var reportJson = function () { copyText(JSON.stringify({ app: 'PayStamp', period_days: days, generated: new Date().toISOString(), usage: D, more: M }, null, 1), 'usageJson'); };
    return h('div', { class: 'us' }, [
      h('div', { class: 'pa-bar' }, [seg, h('span', { class: 'pa-bar-r' }, [btn('pill-btn', 'Copy this report to paste into a chat with Claude or another AI', report, [state.cpCopied === 'usageCopy' ? 'Copied' : 'Copy report for AI']), btn('pill-btn', 'Copy all the numbers as data (JSON)', reportJson, [state.cpCopied === 'usageJson' ? 'Copied' : 'Copy as data']), btn('pill-btn', 'Refresh the numbers', function () { delete usageData[days]; usageLoad(days); scheduleRender(); }, ['Refresh'])])]),
      P.preview ? h('p', { class: 'us-pv', text: 'Preview: these are example numbers. On paystamp.co.uk this shows your real users.' }) : null,
      h('div', { class: 'pa-stats' }, [stat(M ? M.active : D.active, 'Active people', 'opened PayStamp, not you'), stat(D.new_accounts, 'New accounts'), stat(D.stamps, 'Months stamped'), stat(D.returning, 'Came back', 'used it on 2 or more days')]),
      landingCard(M, days), funnel, weekly, h('div', { class: 'us-two' }, [pagesCard, eventsCard(M) || feats]),
      h('p', { class: 'us-note', text: 'Your own use is left out. Only page names and actions are logged, never amounts or anything in a plan, and anyone can switch it off in Your details › Your data. Numbers start from the day this goes live.' }) ]);
  }
  // v4.3: the home page buttons, in plain words
  var TAP_NAMES = { start_hero: 'Start now (top of the page)', start_nav: 'Start now (top bar)', start_bottom: 'Start now (bottom of the page)', claim: 'Start now (founding card)',
    try_hero: 'Try it (top of the page)', nav_try: 'Try it (top bar)', nav_inside: 'What’s inside (top bar)', nav_faq: 'Questions (top bar)',
    try_pay: 'Typed their pay in Try it', try_fill: 'Fill it in for me', try_tool_pct: 'Tried % of pay', try_tool_rev: 'Tried Review', try_tool_note: 'Tried Notes', try_tool_auto: 'Tried Automation',
    try_keep: 'Start now with these figures', try_fresh: 'Start a fresh planner', whatif: 'Used the What if sliders', faq: 'Opened a question', showcase_1: 'Showcase: Plan your month', showcase_2: 'Showcase: Your records', showcase_3: 'Showcase: On your phone' };
  function landingCard(M, days) {
    var n = function (v) { return Number(v) || 0; };
    if (!M) return h('section', { class: 'us-card' }, [h('div', { class: 'us-h' }, [h('h3', { text: 'Home page: how far visitors get' })]), h('p', { class: 'f-hint', text: 'Run supabase-v4.3.sql to start counting the home page.' })]);
    var Lg = M.landing || {}, T = M.taps || {}, tv = function (k) { return n(T[k]); }, base = n(Lg.home);
    var rows = [
      ['Opened the home page', base, 'Every visit, not signed in'],
      ['Pressed Start now', tv('start_hero') + tv('start_nav') + tv('start_bottom') + tv('claim'), 'Any of the Start now buttons'],
      ['Played with Try it', Math.max(tv('try_pay'), tv('try_fill')), 'Typed their pay or pressed Fill it in'],
      ['Built a plan', n(Lg.try_done) + tv('try_keep'), 'Finished the start-up questions, or used their Try it figures'],
      ['Opened sign-up', n(Lg.signup_open), ''],
      ['Made an account', n(Lg.signup_done), ''] ];
    var funnel = base ? h('div', { class: 'us-fun' }, rows.map(function (r, i) {
      var pct = Math.round(r[1] / base * 100), prev = i ? rows[i - 1][1] : 0, drop = i && prev ? Math.round((1 - r[1] / prev) * 100) : null;
      return h('div', { class: 'us-fr' }, [
        h('div', { class: 'us-fl' }, [h('b', { text: r[0] }), r[2] ? h('small', { text: r[2] }) : null]),
        h('div', { class: 'us-fb' }, [h('i', { style: 'width:' + Math.max(r[1] > 0 ? 2 : 0, pct) + '%' })]),
        h('div', { class: 'us-fv' }, [h('b', { text: String(r[1]) }), h('small', { text: i ? pct + '% of visits' : '' })]),
        drop != null && drop > 0 ? h('span', { class: 'us-drop', text: '−' + drop + '% from the step before' }) : null ]); }))
      : h('p', { class: 'f-hint', text: 'No home-page visits counted yet.' });
    var taps = Object.keys(T).map(function (k) { return { k: k, v: n(T[k]) }; }).sort(function (a, b) { return b.v - a.v; });
    var tmax = Math.max.apply(null, taps.map(function (t) { return t.v; }).concat([1]));
    var tapList = taps.length ? h('div', { class: 'us-bars' }, taps.map(function (t) {
      return h('div', { class: 'us-br' }, [h('span', { class: 'us-bn', text: TAP_NAMES[t.k] || t.k }), h('span', { class: 'us-bt' }, [h('i', { style: 'width:' + Math.max(2, Math.round(t.v / tmax * 100)) + '%' })]), h('span', { class: 'us-bv', text: t.v + (base ? ' · ' + Math.round(t.v / base * 100) + '%' : '') })]); }))
      : h('p', { class: 'f-hint', text: 'No buttons pressed yet. Counting starts once 4.3 is live.' });
    return h('section', { class: 'us-card us-home' }, [h('div', { class: 'us-h' }, [h('h3', { text: 'Home page: how far visitors get' }), h('small', { text: 'Anonymous visits in the last ' + days + ' days. Each button counted once per visit.' })]),
      funnel,
      h('h4', { class: 'us-sub-h', text: 'What visitors pressed' }), tapList,
      (M.referrers || []).length ? h('p', { class: 'us-note', text: 'Came from: ' + M.referrers.map(function (r) { return r.site + ' (' + n(r.n) + ')'; }).join(', ') + '.' }) : null,
      Lg.wide != null ? h('p', { class: 'us-note', text: 'Laptop or bigger: ' + n(Lg.wide) + ' · phone or tablet: ' + n(Lg.narrow) + '.' }) : null ]);
  }
  function eventsCard(M) {
    if (!M || !(M.events || []).length) return null;
    var n = function (v) { return Number(v) || 0; };
    return h('section', { class: 'us-card' }, [h('div', { class: 'us-h' }, [h('h3', { text: 'Everything people did' }), h('small', { text: 'Each action, with what was chosen' })]),
      h('div', { class: 'us-tbl' }, [h('div', { class: 'us-tr us-th' }, [h('span', { text: 'Action' }), h('span', { text: 'People' }), h('span', { text: 'Times' })])].concat(M.events.map(function (e) {
        return h('div', { class: 'us-tr' }, [h('span', { text: (EVENT_NAMES[e.name] || e.name) + (e.detail ? ' · ' + e.detail : '') }), h('span', { text: String(n(e.people)) }), h('span', { text: String(n(e.times)) })]); })))]);
  }
  // The switch in Your details › Your data.
  function usageSwitch() {
    var on = !state.noUsageLog;
    return h('label', { class: 'us-sw', for: 'f-usage-log' }, [
      h('input', { type: 'checkbox', id: 'f-usage-log', checked: on ? true : null, onchange: function (e) { set({ noUsageLog: !e.target.checked }); } }),
      h('span', {}, [h('b', { text: 'Help improve PayStamp' }), h('small', { text: 'Shares which pages you open and which buttons you use, so we can see what works. Never amounts or anything in your plan.' })]) ]);
  }

  /* ================= v4: shared records for couples =================
     C().records = [{ id, month, year, lines: [{ id, name, cat, total, mine, theirs }], by: { me: iso, them: iso } }]
     A shared month is saved when either partner stamps their own month (or presses Stamp in Couples).
     On the live site these records sit with the couple in the database, so both partners see the same table
     and either can change a past month. Each partner keeps a copy if they stop sharing. */
  function cpRecs() { var c = C(); return c.records || (c.records = []); }
  function cpRecFind(month, year) { return cpRecs().filter(function (r) { return r.month === month && String(r.year) === String(year); })[0]; }
  function cpRecSnapshot() {
    return C().lines.filter(function (l) { return l.name || amt(l.total); }).map(function (l) { return { id: l.id, name: l.name || 'Untitled', cat: l.cat, total: amt(l.total), mine: cpMine(l), theirs: cpTheirs(l) }; });
  }
  function cpRecStamp(month, year, who) {
    if (!coupleOn() || !C().lines.length) return null;
    var r = cpRecFind(month, year), now = new Date().toISOString();
    if (!r) { r = { id: uid('cpr'), month: month, year: String(year), lines: [], by: {} }; cpRecs().push(r); }
    r.lines = cpRecSnapshot(); r.by = Object.assign({}, r.by); r.by[who || 'me'] = now; r.changed = false;
    return r;
  }
  function cpRecTotals(r) { var t = { total: 0, mine: 0, theirs: 0 }; (r.lines || []).forEach(function (x) { t.total += amt(x.total); t.mine += amt(x.mine); t.theirs += amt(x.theirs); }); return t; }
  // Changing a past month keeps that line's split as it was.
  function cpRecSet(r, x, v) {
    var t = amt(v), old = amt(x.total), share = old > 0 ? amt(x.mine) / old : 0.5;
    x.total = t; x.mine = Math.round(t * share * 100) / 100; x.theirs = Math.round((t - x.mine) * 100) / 100; r.changed = true; commit();
  }
  // Three example months, stamped by both, when the example partner is connected.
  function cpRecExample() {
    var now = monthIndexNow();
    [3, 2, 1].forEach(function (back, k) {
      var i = now - back, r = { id: uid('cpr'), month: MONTHS[i % 12], year: String(Math.floor(i / 12)), lines: cpRecSnapshot(), by: { me: new Date().toISOString(), them: new Date().toISOString() } };
      r.lines.forEach(function (x) {
        if (/grocer/i.test(x.name)) { x.total = [385, 432, 410][k]; x.mine = x.total / 2; x.theirs = x.total / 2; }
        if (/energy/i.test(x.name)) { var e = [96, 118, 131][k], sh = x.mine / (x.mine + x.theirs || 1); x.total = e; x.mine = Math.round(e * sh); x.theirs = e - x.mine; }
      });
      cpRecs().push(r);
    });
  }
  function couplesRecords(readOnly) {
    var c = C(), pn = readOnly ? (c.pastPartner || 'your partner') : coupleName(), all = cpRecs();
    var month = state.month || MONTHS[new Date().getMonth()], year = state.year || String(new Date().getFullYear());
    var years = all.map(function (r) { return Number(r.year); }); if (!readOnly) years.push(Number(year));
    if (!years.length) return null;
    var minY = Math.min.apply(null, years), maxY = Math.max.apply(null, years), Y = state.cprYear != null ? Number(state.cprYear) : maxY;
    Y = Math.max(minY, Math.min(maxY, Y));
    var recs = all.filter(function (r) { return Number(r.year) === Y; }).sort(function (a, b) { return MONTHS.indexOf(a.month) - MONTHS.indexOf(b.month); });
    var head = h('div', { class: 'cpr-top' }, [
      h('h3', { text: readOnly ? 'Your shared records with ' + pn : 'Shared records' }),
      h('div', { class: 'cpr-yr' }, [btn('mbtn', 'Previous year', function () { set({ cprYear: Y - 1 }); }, [], { html: IC.chevL, disabled: Y <= minY ? true : null }), h('b', { text: String(Y) }), btn('mbtn', 'Next year', function () { set({ cprYear: Y + 1 }); }, [], { html: IC.chevR, disabled: Y >= maxY ? true : null })]) ]);
    var cur = cpRecFind(month, year), curSt = cur ? (cur.by.me && cur.by.them ? 'both' : cur.by.me ? 'me' : 'them') : 'none';
    var stampBar = readOnly ? null : h('div', { class: 'cpr-stamp' + (curSt === 'both' ? ' done' : '') }, [
      h('span', { class: 'cpr-st-t' }, [h('b', { text: curSt === 'both' ? month + ' ' + year + ' is stamped by you both' : curSt === 'me' ? 'You’ve stamped ' + month + ' ' + year : curSt === 'them' ? pn + ' has stamped ' + month + ' ' + year : month + ' ' + year + ' isn’t in your shared records yet' }),
        h('small', { text: curSt === 'both' ? 'It’s saved for both of you below.' : curSt === 'me' ? 'Waiting for ' + pn + ' to stamp their month too.' : curSt === 'them' ? 'Stamp it too, so you’re both up to date.' : 'It’s added by itself when either of you stamps your own month. Or stamp the shared month now.' })]),
      curSt === 'both' || curSt === 'me' ? null : btn('pill-btn primary', 'Stamp the shared month for ' + month + ' ' + year, function () { cpRecStamp(month, year, 'me'); state.cprYear = Number(year); commit(); showUndo(month + ' ' + year + ' added to your shared records.'); }, ['Stamp ' + month + ' together']) ]);
    if (!recs.length) return h('section', { class: 'cpr' }, [head, stampBar, h('p', { class: 'cpr-empty', text: 'No shared months in ' + Y + ' yet. Each month you stamp is saved here for both of you.' })]);
    var cols = 'grid-template-columns:minmax(150px,1fr) repeat(' + recs.length + ',minmax(96px,120px))';
    var names = [], seen = {};
    recs.forEach(function (r) { r.lines.forEach(function (x) { if (!seen[x.id]) { seen[x.id] = 1; names.push({ id: x.id, name: x.name, cat: x.cat }); } else names.filter(function (n) { return n.id === x.id; })[0].name = x.name; }); });
    var row = function (cls, first, cells) { return h('div', { class: 'cpr-r ' + cls, style: cols }, [h('span', { class: 'cpr-n' }, first)].concat(cells)); };
    var t = h('div', { class: 'cpr-t', role: 'table', 'aria-label': 'Shared records for ' + Y }, [
      row('hd', ['Shared cost'], recs.map(function (r) { var tt = cpRecTotals(r); return h('span', { class: 'cpr-mh' }, [h('b', { text: r.month.slice(0, 3) }), h('small', { text: money(Math.round(tt.total)) })]); })) ]);
    names.forEach(function (n) {
      t.append(row('it', [n.name], recs.map(function (r) {
        var x = r.lines.filter(function (y) { return y.id === n.id; })[0];
        if (!x) return h('span', { class: 'cpr-z', text: '–' });
        return readOnly ? h('span', { text: money(amt(x.total)) }) : field('cpr-' + r.id + '-' + n.id, String(x.total), function (v) { cpRecSet(r, x, v); }, { cls: 'cpr-in', num: true, money: true, label: n.name + ' in ' + r.month + ' ' + r.year });
      })));
    });
    t.append(row('tot', ['Total'], recs.map(function (r) { return h('span', { text: money(Math.round(cpRecTotals(r).total * 100) / 100) }); })));
    t.append(row('who', [h('i', { class: 'cpl-dot a' }), 'You paid'], recs.map(function (r) { return h('span', { text: money(Math.round(cpRecTotals(r).mine * 100) / 100) }); })));
    t.append(row('who', [h('i', { class: 'cpl-dot b' }), pn + ' paid'], recs.map(function (r) { return h('span', { text: money(Math.round(cpRecTotals(r).theirs * 100) / 100) }); })));
    t.append(row('st', ['Stamped'], recs.map(function (r) {
      var both = r.by.me && r.by.them;
      return h('span', {}, [h('span', { class: 'cpr-chip' + (both ? ' both' : ''), title: both ? 'Stamped by you both' : r.by.me ? 'Stamped by you' : 'Stamped by ' + pn, text: both ? '✓ Both' : r.by.me ? 'You' : pn })]);
    })));
    var yt = recs.reduce(function (a, r) { var tt = cpRecTotals(r); a.total += tt.total; a.mine += tt.mine; a.theirs += tt.theirs; return a; }, { total: 0, mine: 0, theirs: 0 });
    return h('section', { class: 'cpr' }, [head, stampBar, h('div', { class: 'rx-scroll' }, [t]),
      h('p', { class: 'cpr-sum', text: Y + ' so far: ' + money(Math.round(yt.total)) + ' shared over ' + recs.length + (recs.length === 1 ? ' month' : ' months') + '. You paid ' + money(Math.round(yt.mine)) + ', ' + pn + ' paid ' + money(Math.round(yt.theirs)) + '.' }),
      readOnly ? null : h('small', { class: 'cpr-note', text: 'Either of you can change a past month by typing in it. Each line keeps the split it had that month.' }) ]);
  }

  /* ================= v4: offline =================
     The planner, stamping, Records, Insights, Compass and the rest work with no signal (the live site keeps a copy of
     the plan on the device and sends changes when it can). Things that need a server say so plainly. */
  function isOffline() { return navigator.onLine === false; }
  function needsSignal(what) { if (!isOffline()) return false; showUndo('You’re offline. ' + what + ' needs an internet connection; everything else works as normal.'); return true; }
  window.addEventListener('online', function () { if (state.groups) scheduleRender(); });
  window.addEventListener('offline', function () { if (state.groups) scheduleRender(); });
  function offlinePill(cls) { return isOffline() ? h('span', { class: 'off-pill ' + (cls || ''), title: 'No internet connection. Your changes are kept on this device and sent when you’re back online.', text: 'Offline' }) : null; }

  /* ================= v4: Couples on the live site =================
     The shared table, its split and the shared records live with the couple in the database (supabase-v4.0-couples.sql),
     stored as partner "a" and partner "b". Each person's PayStamp turns that into "me" and "them" for their own view.
     Changes are sent a moment after they're made; the latest is fetched when Couples opens, every few seconds while
     it's open, every minute otherwise, and when the connection comes back. */
  // v4.3: the shape of the shared table. The database refuses saves from an older PayStamp, so an old page can't muddle it.
  var CP_SCHEMA = 2;
  function cpOutdated() { if (window.PayStampAppRefresh) window.PayStampAppRefresh('couples-' + Date.now().toString().slice(0, 7)); }
  function cpLive() { var P = window.PayStamp || {}; return !P.preview && P.couple ? P.couple : null; }
  var cpS = { version: 0, role: 'a', last: null, timer: null, busy: false, pulling: false, lastPull: 0, asked: false };
  function cpToShared(c, role) {
    var me = role, them = role === 'a' ? 'b' : 'a';
    var flip = function (m) { return m === 'me' ? me : m === 'them' ? them : (m || 'usual'); };
    var pct = c.customPct == null ? 50 : amt(c.customPct);
    return {
      split: c.split || 'income', customPctA: role === 'a' ? pct : 100 - pct,
      lines: (c.lines || []).map(function (l) { var o = { id: l.id, name: l.name || '', cat: l.cat || 'Home', total: l.total || '', mode: flip(l.mode) };
        if (l.mode === 'amt') { o[me] = l.me || ''; o[them] = l.them == null ? String(cpTheirs(l) || '') : l.them; }
        if (l.remind) o.remind = l.remind; return o; }),
      transfers: (c.transfers || []).map(function (t) { return { id: t.id, from: flip(t.from), amount: t.amount || '', note: t.note || '' }; }),
      schema: CP_SCHEMA,
      records: (c.records || []).map(function (r) {
        var by = {}; if (r.by && r.by.me) by[me] = r.by.me; if (r.by && r.by.them) by[them] = r.by.them;
        return { id: r.id, month: r.month, year: String(r.year), by: by, lines: (r.lines || []).map(function (x) { var o = { id: x.id, name: x.name, cat: x.cat, total: x.total }; o[me] = x.mine; o[them] = x.theirs; return o; }) };
      }) };
  }
  function cpFromShared(s, role) {
    s = s || {}; var me = role, them = role === 'a' ? 'b' : 'a';
    var flip = function (m) { return m === me ? 'me' : m === them ? 'them' : (m || 'usual'); };
    var pa = s.customPctA == null ? 50 : Number(s.customPctA);
    return {
      split: s.split || 'income', customPct: String(role === 'a' ? pa : 100 - pa),
      lines: (s.lines || []).map(function (l) { var o = { id: l.id, name: l.name || '', cat: l.cat || 'Home', total: l.total || '', mode: flip(l.mode) };
        if (o.mode === 'amt') { o.me = l[me] == null ? '' : String(l[me]); if (l[them] != null) o.them = String(l[them]); }
        if (l.remind) o.remind = l.remind; return o; }),
      transfers: (s.transfers || []).map(function (t) { return { id: t.id, from: flip(t.from), amount: t.amount || '', note: t.note || '' }; }),
      records: (s.records || []).map(function (r) {
        var by = r.by || {};
        return { id: r.id, month: r.month, year: String(r.year), by: { me: by[me] || null, them: by[them] || null }, lines: (r.lines || []).map(function (x) { return { id: x.id, name: x.name, cat: x.cat, total: x.total, mine: x[me] || 0, theirs: x[them] || 0 }; }) };
      }) };
  }
  // Take what the database says and show it.
  function cpApply(g, quiet) {
    if (!g || !state.groups) return;
    var c = C(), was = c.status === 'connected', wasName = c.partner && c.partner.name;
    if (g.status === 'linked' && g.shared && Number(g.shared.schema || 0) > CP_SCHEMA) { cpOutdated(); return; }   // saved by a newer PayStamp: refresh first
    if (g.status === 'linked') {
      cpS.role = g.role || 'a'; cpS.version = g.version || 0;
      c.status = 'connected'; c.code = g.code || c.code; c.partner = { name: g.partner_name || 'Your partner', pay: g.partner_pay == null ? '' : String(g.partner_pay) };
      Object.assign(c, cpFromShared(g.shared, cpS.role));
      cpS.last = JSON.stringify(cpToShared(c, cpS.role));
      if (!was && !quiet) showUndo('You’re connected with ' + c.partner.name + '.');
    } else {
      if (!was && c.code === (g.status === 'waiting' ? g.code : '') && c.status !== 'connected') return;   // nothing changed
      if (was) { c.pastPartner = wasName || c.pastPartner; c.partner = null; c.lines = []; if (!quiet) showUndo((wasName || 'Your partner') + ' has stopped sharing. Your copy of your shared records is kept.'); }
      c.status = 'none'; c.code = g.status === 'waiting' ? g.code : ''; cpS.last = null;
    }
    commit();
  }
  function cpPull(quiet) {
    var L = cpLive(); if (!L || cpS.pulling || isOffline()) return;
    if (cpS.timer && cpS.last !== null) return;               // a change of yours is about to be sent: send that first
    cpS.pulling = true; cpS.lastPull = Date.now();
    L.get().then(function (g) {
      cpS.pulling = false;
      if (g && g.status === 'linked' && cpS.last !== null && g.version === cpS.version) return;   // nothing new
      cpApply(g, quiet);
    }, function () { cpS.pulling = false; });
  }
  // Called after every change (from commit): sends the shared table if it changed.
  function cpQueuePush() {
    if (!cpLive() || !coupleOn() || cpS.last === null) return;
    var s = JSON.stringify(cpToShared(C(), cpS.role)); if (s === cpS.last) return;
    clearTimeout(cpS.timer); cpS.timer = setTimeout(cpPush, 1200);
  }
  function cpPush() {
    cpS.timer = null;
    var L = cpLive(); if (!L || !coupleOn() || cpS.busy) return;
    if (isOffline()) return;                                   // sent when the connection comes back
    var shared = cpToShared(C(), cpS.role), s = JSON.stringify(shared); if (s === cpS.last) return;
    cpS.busy = true;
    L.save(shared, cpS.version, userName(), C().split === 'income' ? cpMyPay() : null).then(function (g) {
      cpS.busy = false; cpS.version = g.version; cpS.last = s;
      if (JSON.stringify(cpToShared(C(), cpS.role)) !== s) cpQueuePush();
    }, function (e) {
      cpS.busy = false;
      if (/outdated/.test((e && e.message) || '')) { cpOutdated(); return; }
      if (/changed/.test((e && e.message) || '')) {
        L.get().then(function (g) { cpApply(g, true); showUndo(coupleName() + ' changed the shared table at the same moment, so you’re seeing the latest now. Check your last change is still there.'); });
      } else { clearTimeout(cpS.timer); cpS.timer = setTimeout(cpPush, 8000); }
    });
  }
  // Your code for your partner, made once by the database.
  function cpEnsureCode() {
    var L = cpLive(); if (!L || cpS.asked || isOffline()) return;
    cpS.asked = true;
    L.start(userName()).then(function (g) { cpApply(g, true); }, function () { cpS.asked = false; });
  }
  function cpJoinLive(code) {
    var L = cpLive(); if (!L) return false;
    set({ cpMsg: null, cpJoining: true });
    L.join(code, userName(), C().split === 'income' ? cpMyPay() : null, C().lines.length ? cpToShared(C(), 'b') : null).then(function (g) {
      state.cpJoining = false;
      if (g && g.status === 'error') { set({ cpMsg: g.message }); return; }
      cpApply(g);
    }, function (e) { set({ cpJoining: false, cpMsg: (e && e.message) || 'That didn’t work. Please try again.' }); });
    return true;
  }
  function cpLeaveLive(done) {
    var L = cpLive(); if (!L) return false;
    if (needsSignal('Stopping sharing')) return true;
    L.leave().then(function () { cpS.last = null; cpS.asked = false; done(); }, function () { showUndo('That didn’t work. Please try again.'); });
    return true;
  }
  // Keep up to date: every 5 seconds on the Couples page (so a new connection or change shows quickly), every minute otherwise.
  setInterval(function () {
    if (!cpLive() || !state.groups || document.hidden) return;
    var onPage = curPage() === 'couples', gap = Date.now() - cpS.lastPull;
    if ((onPage && gap > 5000) || (coupleOn() && gap > 60000)) cpPull(true);
  }, 2500);
  window.addEventListener('online', function () { if (cpLive() && state.groups) { if (cpS.last !== null) cpQueuePush(); cpPull(true); } });

  /* V4-END */
  function start(initial) {
    initial = Object.assign({}, initial || {});
    var qsNew = initial.qsNew, qsDraft = initial.qsDraft; delete initial.qsNew; delete initial.qsDraft;
    Object.assign(state, initial);
    migrate();
    // v3.7: a plan built on the home page becomes this new account's planner, or opens ready to compare
    if (qsNew) { var nI = PSQuick.create({ mode: 'planner', result: function () { return null; } }); nI.load(qsNew); applyQuick(nI.state(), 'replace'); }
    else if (qsDraft) { state.qsOpen = true; quickInst().load(Object.assign({}, qsDraft, { step: 4 })); }
    syncLinkedItems();
    syncDebtExtras();
    syncSavingExtras();
    syncInvestExtras();
    if (dropExampleStamps()) save();
    track('open', null, true);
    var hp = (location.hash || '').slice(1); hp = PAGE_MOVED[hp] || hp; if (PAGE_INFO[hp]) state.page = hp;
    render();
    if (cpLive()) setTimeout(function () { cpPull(true); }, 1500);
  }
  // v4.3: put a plan combined from two devices in place (then it saves as usual)
  function replaceSaved(data, msg) {
    data = data || {};
    SAVED_KEYS.forEach(function (k) { if (data[k] !== undefined) state[k] = data[k]; else delete state[k]; });
    migrate(); syncLinkedItems(); syncDebtExtras(); syncSavingExtras(); syncInvestExtras();
    state.editRow = null; commit(); if (msg) showUndo(msg);
  }
  window.PlannerApp = { start: start, replaceSaved: replaceSaved, refresh: function (msg) { if (msg) showUndo(msg); scheduleRender(); }, savedKeys: SAVED_KEYS, exampleRecords: function () { return exampleRecords(); },
    // Preview only: start again as a new person (with a plan from the home page, or the quick start open), or as someone rebuilding their own plan.
    preview: {
      newUser: function (draft) { SAVED_KEYS.forEach(function (k) { delete state[k]; }); migrate(); qsInst = null; state.qsOpen = false; state.page = 'plan';
        if (draft) { var nI = PSQuick.create({ mode: 'planner', result: function () { return null; } }); nI.load(draft); applyQuick(nI.state(), 'replace'); } else { state.qsOpen = true; commit(); } },
      example: function () { SAVED_KEYS.forEach(function (k) { delete state[k]; }); migrate(); qsInst = null; state.qsOpen = false; state.page = 'plan'; commit(); exampleRecords(); },
      setPro: function (v) { set({ pvPro: !!v }); },
      getPro: function () { return !!state.pvPro; },
      rebuild: function () { SAVED_KEYS.forEach(function (k) { delete state[k]; }); migrate(); state.isExample = false; state.exampleHidden = true; state.page = 'plan'; openQuick(); }
    } };
})();
