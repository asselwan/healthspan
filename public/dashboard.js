/* NOMOI Healthspan — clinician dashboard logic.
 *
 * The longitudinal surface. The clinician picks (or adds) a patient and
 * sees: every intake round's readiness score plotted over time, a panel
 * to enter dated lab biomarkers, a field for the Cognitive Wellness
 * score, hand-rolled SVG trend charts, and a patient summary report.
 *
 * v1 read model — patient records are private (RLS gives anon INSERT
 * only, no read; biomarkers are anon-locked entirely). A static page
 * therefore cannot safely hold a key that can read or write patient data.
 * So the clinician enters a read key at runtime; it lives only in this
 * tab's memory and is never written into the repo, the page, or storage.
 * A hosted multi-clinic v2 replaces this with a thin authenticated
 * backend route. Same trade-off as the frontdesk repo's /clinic view.
 */
(function () {
  'use strict';

  var CFG = window.__HEALTHSPAN_CONFIG || {};
  var emit = window.__nomoiSurfaceEmit || function () {};

  var T_PATIENTS = CFG.PATIENTS_TABLE || 'healthspan_patients';
  var T_ROUNDS = CFG.ROUNDS_TABLE || 'healthspan_intake_rounds';
  var T_BIO = CFG.BIOMARKERS_TABLE || 'healthspan_biomarkers';

  /* ---- Known biomarkers --------------------------------------------- */
  // direction: 'lower' = lower is generally better, 'higher' = higher is
  // generally better. Used only to colour the latest-value hint, never to
  // diagnose.
  var MARKERS = [
    { key: 'fasting_glucose', label: 'Fasting glucose', unit: 'mg/dL', direction: 'lower' },
    { key: 'hba1c',           label: 'HbA1c',           unit: '%',     direction: 'lower' },
    { key: 'apob',            label: 'ApoB',            unit: 'mg/dL', direction: 'lower' },
    { key: 'hscrp',           label: 'hsCRP',           unit: 'mg/L',  direction: 'lower' },
    { key: 'triglycerides',   label: 'Triglycerides',   unit: 'mg/dL', direction: 'lower' },
    { key: 'ldl',             label: 'LDL cholesterol', unit: 'mg/dL', direction: 'lower' },
    { key: 'hdl',             label: 'HDL cholesterol', unit: 'mg/dL', direction: 'higher' },
    { key: 'total_cholesterol', label: 'Total cholesterol', unit: 'mg/dL', direction: 'lower' }
  ];
  function markerByKey(k) {
    for (var i = 0; i < MARKERS.length; i++) if (MARKERS[i].key === k) return MARKERS[i];
    return { key: k, label: k, unit: '', direction: 'lower' };
  }

  /* ---- DOM ----------------------------------------------------------- */
  var gate = document.getElementById('gate');
  var gateErr = document.getElementById('gateErr');
  var dash = document.getElementById('dash');
  var patientSelect = document.getElementById('patientSelect');
  var pickState = document.getElementById('pickState');
  var pv = document.getElementById('pv');

  var sb = null;
  var patients = [];
  var current = null;   // current patient object
  var rounds = [];      // rounds for current patient
  var biomarkers = [];  // biomarkers for current patient

  /* ---- Gate ---------------------------------------------------------- */
  document.getElementById('enterBtn').addEventListener('click', enter);
  document.getElementById('keyInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') enter();
  });

  function enter() {
    var pass = document.getElementById('passInput').value.trim();
    var key = document.getElementById('keyInput').value.trim();
    gateErr.style.display = 'none';

    if (pass !== (CFG.CLINIC_PASSCODE || 'healthspan2026')) {
      return showGateErr('That passcode is not correct.');
    }
    if (!key) {
      return showGateErr('Enter the read key to open the dashboard.');
    }
    if (!window.supabase || !window.supabase.createClient) {
      return showGateErr('The Supabase client did not load. Check the connection and reload.');
    }
    try {
      sb = window.supabase.createClient(CFG.SUPABASE_URL, key, {
        db: { schema: CFG.SCHEMA || 'public' },
        auth: { persistSession: false }
      });
    } catch (e) {
      return showGateErr('Could not start the client. Check the read key.');
    }

    emit('dashboard_unlocked', {});
    gate.style.display = 'none';
    dash.classList.add('show');
    loadPatients();
  }
  function showGateErr(msg) {
    gateErr.textContent = msg;
    gateErr.style.display = 'block';
  }

  /* ---- Helpers ------------------------------------------------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function ageFrom(dob) {
    if (!dob) return null;
    var d = new Date(dob + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    var now = new Date();
    var a = now.getFullYear() - d.getFullYear();
    var m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
    return a >= 0 && a < 130 ? a : null;
  }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
  function scoreBand(s) {
    if (s == null) return '';
    if (s >= 80) return 'Strong footing';
    if (s >= 65) return 'Solid, room to gain';
    if (s >= 50) return 'Mixed picture';
    return 'Worth attention';
  }

  /* ---- Load patients ------------------------------------------------- */
  function loadPatients() {
    sb.from(T_PATIENTS).select('*').order('full_name', { ascending: true })
      .then(function (res) {
        if (res.error) {
          patientSelect.innerHTML = '<option value="">Could not load</option>';
          showInState('err', 'Could not load patients. ' +
            esc(res.error.message || 'Check the read key and that the migration is applied.'));
          return;
        }
        patients = res.data || [];
        var opts = '<option value="">Select a patient (' + patients.length + ')</option>';
        patients.forEach(function (p) {
          opts += '<option value="' + esc(p.id) + '">' + esc(p.full_name) + '</option>';
        });
        patientSelect.innerHTML = opts;
        if (current) {
          patientSelect.value = current.id;
        }
      })
      .catch(function (err) {
        showInState('err', 'Could not reach Supabase. ' + esc(String(err)));
      });
  }

  function showInState(kind, msg) {
    pv.classList.remove('show');
    pickState.className = 'state' + (kind === 'err' ? ' err' : '');
    pickState.textContent = msg;
    pickState.style.display = 'block';
  }

  document.getElementById('reloadBtn').addEventListener('click', function () {
    loadPatients();
    if (current) selectPatient(current.id);
  });

  patientSelect.addEventListener('change', function () {
    if (patientSelect.value) selectPatient(patientSelect.value);
  });

  /* ---- New patient --------------------------------------------------- */
  var newPatient = document.getElementById('newPatient');
  document.getElementById('newPatientBtn').addEventListener('click', function () {
    newPatient.classList.toggle('show');
  });
  document.getElementById('npCancel').addEventListener('click', function () {
    newPatient.classList.remove('show');
  });
  document.getElementById('npSave').addEventListener('click', function () {
    var npErr = document.getElementById('npErr');
    npErr.style.display = 'none';
    var name = document.getElementById('npName').value.trim();
    if (!name) {
      npErr.textContent = 'Enter a name for the patient.';
      npErr.style.display = 'block';
      return;
    }
    var id = uuid();
    var row = {
      id: id,
      full_name: name,
      date_of_birth: document.getElementById('npDob').value || null,
      sex: document.getElementById('npSex').value || null,
      email: document.getElementById('npEmail').value.trim() || null,
      phone: document.getElementById('npPhone').value.trim() || null
    };
    var btn = document.getElementById('npSave');
    btn.disabled = true; btn.textContent = 'Saving...';
    sb.from(T_PATIENTS).insert(row)
      .then(function (res) {
        if (res.error) throw res.error;
        emit('patient_added', { patient_id: id });
        newPatient.classList.remove('show');
        ['npName', 'npDob', 'npEmail', 'npPhone'].forEach(function (f) {
          document.getElementById(f).value = '';
        });
        document.getElementById('npSex').value = '';
        // Add locally and select.
        row.created_at = new Date().toISOString();
        patients.push(row);
        loadPatients();
        selectPatient(id);
      })
      .catch(function (err) {
        npErr.textContent = 'Could not save the patient. ' + esc(String(err && err.message || err));
        npErr.style.display = 'block';
      })
      .then(function () {
        btn.disabled = false; btn.textContent = 'Save patient';
      });
  });

  /* ---- Select a patient + load their data --------------------------- */
  function selectPatient(id) {
    current = null;
    for (var i = 0; i < patients.length; i++) {
      if (patients[i].id === id) { current = patients[i]; break; }
    }
    if (!current) { showInState('plain', 'Patient not found. Refresh and try again.'); return; }
    patientSelect.value = id;
    emit('patient_selected', { patient_id: id });

    pickState.style.display = 'none';
    pv.classList.add('show');
    renderPatientHead();

    // Reset before reload.
    rounds = [];
    biomarkers = [];
    document.getElementById('readinessChart').innerHTML = '<div class="chart-empty">Loading...</div>';
    document.getElementById('roundsTable').innerHTML = '<div class="chart-empty">Loading...</div>';
    document.getElementById('biomarkerCharts').innerHTML = '<div class="chart-empty">Loading...</div>';

    Promise.all([loadRounds(id), loadBiomarkers(id)]).then(function () {
      renderReadiness();
      renderRoundsTable();
      renderReadinessChart();
      renderBiomarkers();
      renderCognitive();
      renderReport();
    });

    // Default the date fields to today.
    document.getElementById('bmDate').value = todayISO();
    document.getElementById('cwDate').value = current.cognitive_wellness_dated_on || todayISO();

    // Reset the lab upload control so a prior patient's state does not linger.
    var labFile = document.getElementById('labFile');
    if (labFile) labFile.value = '';
    clearLabStatus();
  }

  function renderPatientHead() {
    document.getElementById('pvName').textContent = current.full_name;
    var bits = [];
    var age = ageFrom(current.date_of_birth);
    if (age != null) bits.push(age + ' years');
    if (current.sex) bits.push(current.sex);
    if (current.email) bits.push(current.email);
    if (current.phone) bits.push(current.phone);
    bits.push('patient since ' + fmtDate(current.created_at));
    document.getElementById('pvMeta').textContent = bits.join('  ·  ');
  }

  function loadRounds(id) {
    // A round may carry patient_id, or only patient_name if it arrived
    // before the patient row existed. Match on either.
    return sb.from(T_ROUNDS).select('*')
      .or('patient_id.eq.' + id + ',patient_name.eq.' + JSON.stringify(current.full_name))
      .order('created_at', { ascending: true })
      .then(function (res) {
        if (res.error) { rounds = []; return; }
        rounds = res.data || [];
      })
      .catch(function () { rounds = []; });
  }

  function loadBiomarkers(id) {
    return sb.from(T_BIO).select('*').eq('patient_id', id)
      .order('sampled_on', { ascending: true })
      .then(function (res) {
        if (res.error) { biomarkers = []; return; }
        biomarkers = res.data || [];
      })
      .catch(function () { biomarkers = []; });
  }

  /* ---- Readiness summary -------------------------------------------- */
  function renderReadiness() {
    var host = document.getElementById('readinessLatest');
    var bandEl = document.getElementById('readinessBand');
    if (!rounds.length) {
      host.innerHTML = '<span class="of">No intake rounds yet.</span>';
      bandEl.textContent = '';
      return;
    }
    var latest = rounds[rounds.length - 1];
    var score = Number(latest.readiness_score);
    var html = '<span class="big">' + score + '</span><span class="of">/ 100</span>';
    if (rounds.length > 1) {
      var prev = Number(rounds[rounds.length - 2].readiness_score);
      var d = score - prev;
      var cls = d > 0 ? 'up' : (d < 0 ? 'down' : 'flat');
      var sign = d > 0 ? '+' : '';
      html += '<span class="delta ' + cls + '">' + sign + d + ' since last round</span>';
    }
    host.innerHTML = html;
    bandEl.textContent = scoreBand(score) + '  ·  ' + fmtDate(latest.created_at);
  }

  /* ---- Rounds table -------------------------------------------------- */
  function renderRoundsTable() {
    var host = document.getElementById('roundsTable');
    if (!rounds.length) {
      host.innerHTML = '<div class="chart-empty">No intake rounds yet. ' +
        'The patient completes the intake at /intake.</div>';
      return;
    }
    var html = '<table><thead><tr>' +
      '<th>Date</th><th>Score</th><th>Sleep</th><th>Activity</th>' +
      '<th>Symptoms</th><th>Goals</th></tr></thead><tbody>';
    // Newest first in the table.
    rounds.slice().reverse().forEach(function (r) {
      var syms = (r.symptoms || []);
      var goals = (r.longevity_goals || []);
      html += '<tr>' +
        '<td>' + esc(fmtDate(r.created_at)) + '</td>' +
        '<td class="score-cell">' + esc(r.readiness_score) + '</td>' +
        '<td>' + (r.sleep_hours != null ? esc(r.sleep_hours) + ' h' : '—') + '</td>' +
        '<td>' + (r.exercise_days != null ? esc(r.exercise_days) + ' d/wk' : '—') + '</td>' +
        '<td>' + (syms.length ? esc(syms.length) + ' flagged' : 'None') + '</td>' +
        '<td>' + (goals.length ? esc(goals.length) : '—') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    host.innerHTML = html;
  }

  /* ===================================================================
   * SVG TREND CHART — hand-rolled, no library.
   *
   * series: array of { x: Date-or-iso, y: number, label: string }
   * opts:   { color, yMin, yMax, height, valueSuffix, invertGood }
   * Renders a responsive line chart with a soft area fill, point dots,
   * a value label on the latest point, and date ticks on the x axis.
   * =================================================================== */
  function buildChart(series, opts) {
    opts = opts || {};
    var W = 720, H = opts.height || 240;
    var padL = 44, padR = 18, padT = 18, padB = 34;
    var color = opts.color || '#c4976b';

    if (!series.length) {
      return '<div class="chart-empty">No data yet.</div>';
    }

    var pts = series.map(function (d) {
      var t = (d.x instanceof Date) ? d.x : new Date(String(d.x).length <= 10 ? d.x + 'T00:00:00' : d.x);
      return { t: t.getTime(), y: Number(d.y), label: d.label, raw: d };
    }).filter(function (p) { return isFinite(p.t) && isFinite(p.y); });

    if (!pts.length) return '<div class="chart-empty">No data yet.</div>';

    var ys = pts.map(function (p) { return p.y; });
    var yMin = opts.yMin != null ? opts.yMin : Math.min.apply(null, ys);
    var yMax = opts.yMax != null ? opts.yMax : Math.max.apply(null, ys);
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    else {
      var pad = (yMax - yMin) * 0.12;
      if (opts.yMin == null) yMin -= pad;
      if (opts.yMax == null) yMax += pad;
    }

    var tMin = pts[0].t, tMax = pts[pts.length - 1].t;
    if (tMin === tMax) { tMin -= 86400000; tMax += 86400000; }

    function sx(t) {
      return padL + ((t - tMin) / (tMax - tMin)) * (W - padL - padR);
    }
    function sy(y) {
      return padT + (1 - (y - yMin) / (yMax - yMin)) * (H - padT - padB);
    }

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img">';

    // Horizontal gridlines + y labels (4 bands).
    for (var g = 0; g <= 4; g++) {
      var gy = yMin + (g / 4) * (yMax - yMin);
      var py = sy(gy);
      svg += '<line x1="' + padL + '" y1="' + py.toFixed(1) +
        '" x2="' + (W - padR) + '" y2="' + py.toFixed(1) +
        '" stroke="rgba(244,241,234,0.07)" stroke-width="1" />';
      svg += '<text x="' + (padL - 8) + '" y="' + (py + 3.5).toFixed(1) +
        '" text-anchor="end" font-family="DM Mono, monospace" font-size="10" ' +
        'fill="rgba(244,241,234,0.35)">' + roundNice(gy) + '</text>';
    }

    // Area fill.
    var areaD = 'M ' + sx(pts[0].t).toFixed(1) + ' ' + sy(pts[0].y).toFixed(1);
    pts.forEach(function (p, i) {
      if (i > 0) areaD += ' L ' + sx(p.t).toFixed(1) + ' ' + sy(p.y).toFixed(1);
    });
    var baseY = (H - padB).toFixed(1);
    var areaClose = ' L ' + sx(pts[pts.length - 1].t).toFixed(1) + ' ' + baseY +
      ' L ' + sx(pts[0].t).toFixed(1) + ' ' + baseY + ' Z';
    svg += '<path d="' + areaD + areaClose + '" fill="' + color + '" fill-opacity="0.10" />';

    // Line.
    var lineD = 'M ' + sx(pts[0].t).toFixed(1) + ' ' + sy(pts[0].y).toFixed(1);
    pts.forEach(function (p, i) {
      if (i > 0) lineD += ' L ' + sx(p.t).toFixed(1) + ' ' + sy(p.y).toFixed(1);
    });
    svg += '<path d="' + lineD + '" fill="none" stroke="' + color +
      '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />';

    // Dots + x ticks.
    pts.forEach(function (p, i) {
      var x = sx(p.t), y = sy(p.y);
      svg += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) +
        '" r="' + (i === pts.length - 1 ? 4 : 2.8) + '" fill="' + color +
        '" stroke="#161411" stroke-width="1.5" />';
      // x label only at first, last, and middle to avoid crowding.
      if (i === 0 || i === pts.length - 1 || (pts.length > 4 && i === Math.floor(pts.length / 2))) {
        svg += '<text x="' + x.toFixed(1) + '" y="' + (H - padB + 18) +
          '" text-anchor="' + (i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle') +
          '" font-family="DM Mono, monospace" font-size="9.5" ' +
          'fill="rgba(244,241,234,0.35)">' + esc(shortDate(p.t)) + '</text>';
      }
    });

    // Latest value label.
    var last = pts[pts.length - 1];
    var lx = sx(last.t), ly = sy(last.y);
    var labelTxt = roundNice(last.y) + (opts.valueSuffix || '');
    var anchor = lx > W - 80 ? 'end' : 'start';
    var lxText = anchor === 'end' ? lx - 8 : lx + 8;
    svg += '<text x="' + lxText.toFixed(1) + '" y="' + (ly - 8).toFixed(1) +
      '" text-anchor="' + anchor + '" font-family="DM Mono, monospace" ' +
      'font-size="11" fill="' + color + '">' + esc(labelTxt) + '</text>';

    svg += '</svg>';
    return svg;
  }
  function roundNice(n) {
    if (Math.abs(n) >= 100) return String(Math.round(n));
    if (Math.abs(n) >= 10) return String(Math.round(n * 10) / 10);
    return String(Math.round(n * 100) / 100);
  }
  function shortDate(t) {
    var d = new Date(t);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function renderReadinessChart() {
    var host = document.getElementById('readinessChart');
    if (!rounds.length) {
      host.innerHTML = '<div class="chart-empty">No intake rounds yet. ' +
        'The chart appears once the patient has completed at least one round.</div>';
      return;
    }
    var series = rounds.map(function (r) {
      return { x: r.created_at, y: Number(r.readiness_score) };
    });
    host.innerHTML = buildChart(series, {
      color: '#c4976b', yMin: 0, yMax: 100, height: 240
    }) + '<div class="legend"><span><i style="background:#c4976b"></i>' +
      'Readiness score, 0 to 100</span></div>';
  }

  /* ---- Biomarkers ---------------------------------------------------- */
  function renderBiomarkers() {
    var host = document.getElementById('biomarkerCharts');
    if (!biomarkers.length) {
      host.innerHTML = '<div class="chart-empty">No lab values yet. ' +
        'Add one above and a trend line appears here.</div>';
      return;
    }
    // Group by marker_key.
    var groups = {};
    biomarkers.forEach(function (b) {
      (groups[b.marker_key] = groups[b.marker_key] || []).push(b);
    });
    var html = '';
    Object.keys(groups).forEach(function (key) {
      var rows = groups[key].slice().sort(function (a, b) {
        return new Date(a.sampled_on) - new Date(b.sampled_on);
      });
      var meta = markerByKey(key);
      var latest = rows[rows.length - 1];
      var unit = latest.unit || meta.unit || '';
      html += '<div class="marker-block">';
      html += '<div class="marker-head">' +
        '<span class="mh-name">' + esc(latest.marker_label || meta.label) + '</span>' +
        '<span class="mh-latest">latest ' + esc(roundNice(Number(latest.value))) +
        ' ' + esc(unit) + '  ·  ' + esc(fmtDate(latest.sampled_on)) + '</span>' +
        '</div>';
      var series = rows.map(function (r) {
        return { x: r.sampled_on, y: Number(r.value) };
      });
      html += buildChart(series, {
        color: '#5bbfab', height: 190,
        valueSuffix: unit ? ' ' + unit : ''
      });
      html += '</div>';
    });
    host.innerHTML = html;
  }

  // Populate the marker dropdown once.
  (function fillMarkerSelect() {
    var sel = document.getElementById('bmMarker');
    var opts = '';
    MARKERS.forEach(function (m) {
      opts += '<option value="' + m.key + '" data-unit="' + esc(m.unit) +
        '" data-label="' + esc(m.label) + '">' + esc(m.label) + '</option>';
    });
    sel.innerHTML = opts;
    sel.addEventListener('change', function () {
      var o = sel.options[sel.selectedIndex];
      document.getElementById('bmUnit').value = o.getAttribute('data-unit') || '';
    });
    // Prime the unit field for the first option.
    if (sel.options.length) {
      document.getElementById('bmUnit').value = sel.options[0].getAttribute('data-unit') || '';
    }
  })();

  document.getElementById('bmSave').addEventListener('click', function () {
    var bmErr = document.getElementById('bmErr');
    var bmOk = document.getElementById('bmOk');
    bmErr.style.display = 'none'; bmOk.style.display = 'none';
    if (!current) { return; }

    var sel = document.getElementById('bmMarker');
    var o = sel.options[sel.selectedIndex];
    var valStr = document.getElementById('bmValue').value.trim();
    var dateStr = document.getElementById('bmDate').value;
    var unit = document.getElementById('bmUnit').value.trim();

    if (valStr === '' || !isFinite(Number(valStr))) {
      bmErr.textContent = 'Enter a numeric value.';
      bmErr.style.display = 'block';
      return;
    }
    if (!dateStr) {
      bmErr.textContent = 'Choose the date the sample was taken.';
      bmErr.style.display = 'block';
      return;
    }
    var row = {
      id: uuid(),
      patient_id: current.id,
      marker_key: sel.value,
      marker_label: o.getAttribute('data-label') || sel.value,
      value: Number(valStr),
      unit: unit || null,
      sampled_on: dateStr
    };
    var btn = document.getElementById('bmSave');
    btn.disabled = true; btn.textContent = 'Saving...';
    sb.from(T_BIO).insert(row)
      .then(function (res) {
        if (res.error) throw res.error;
        emit('biomarker_added', { patient_id: current.id, marker_key: row.marker_key });
        row.created_at = new Date().toISOString();
        biomarkers.push(row);
        document.getElementById('bmValue').value = '';
        bmOk.style.display = 'block';
        renderBiomarkers();
        renderReport();
        window.setTimeout(function () { bmOk.style.display = 'none'; }, 2500);
      })
      .catch(function (err) {
        bmErr.textContent = 'Could not save the value. ' + esc(String(err && err.message || err));
        bmErr.style.display = 'block';
      })
      .then(function () {
        btn.disabled = false; btn.textContent = 'Add value';
      });
  });

  /* ---- Lab report PDF upload + extraction --------------------------- */
  // The clinician picks a lab PDF. It is uploaded to the healthspan-labs
  // Storage bucket using the same service-role key that opened this tab,
  // then the NOMOI document-extraction backend reads it and writes the
  // biomarker rows. We then refresh the patient's biomarker view.
  var LABS_BUCKET = CFG.LABS_BUCKET || 'healthspan-labs';

  function setLabStatus(kind, msg) {
    var el = document.getElementById('labStatus');
    el.className = 'lu-status show ' + kind;
    el.textContent = msg;
  }
  function clearLabStatus() {
    var el = document.getElementById('labStatus');
    el.className = 'lu-status';
    el.textContent = '';
  }

  document.getElementById('labUploadBtn').addEventListener('click', function () {
    var btn = document.getElementById('labUploadBtn');
    var fileInput = document.getElementById('labFile');

    if (!current) {
      setLabStatus('err', 'Select a patient before uploading a lab report.');
      return;
    }
    var file = fileInput.files && fileInput.files[0];
    if (!file) {
      setLabStatus('err', 'Choose a PDF lab report first.');
      return;
    }
    var name = (file.name || '').toLowerCase();
    var isPdf = file.type === 'application/pdf' || /\.pdf$/.test(name);
    if (!isPdf) {
      setLabStatus('err', 'That file is not a PDF. Choose a PDF lab report.');
      return;
    }

    var token = CFG.EXTRACT_API_TOKEN;
    var apiBase = CFG.EXTRACT_API_BASE || 'https://docextract.nomoi.ai';
    if (!token) {
      setLabStatus('err', 'The extraction service is not configured. Ask the NOMOI operator.');
      return;
    }

    var patientId = current.id;
    var storagePath = patientId + '/' + Date.now() + '.pdf';

    btn.disabled = true;
    fileInput.disabled = true;
    setLabStatus('working', 'Uploading the report...');

    sb.storage.from(LABS_BUCKET).upload(storagePath, file, {
      contentType: 'application/pdf',
      upsert: false
    })
      .then(function (res) {
        if (res.error) {
          throw new Error('Upload failed. ' + (res.error.message || 'Check the storage bucket exists.'));
        }
        emit('lab_report_uploaded', { patient_id: patientId });
        setLabStatus('working', 'Reading the report. This can take up to a minute...');

        return fetch(apiBase.replace(/\/+$/, '') + '/extract/labs', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
          },
          body: JSON.stringify({
            patient_id: patientId,
            storage_bucket: LABS_BUCKET,
            storage_path: storagePath
          })
        });
      })
      .then(function (resp) {
        // Read the body once, then branch on status, so a 422 with a JSON
        // error message and a 200 with a result are both handled cleanly.
        return resp.text().then(function (text) {
          var body = null;
          try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
          if (!resp.ok) {
            var detail = (body && (body.error || body.message)) ||
              text || ('HTTP ' + resp.status);
            throw new Error('Could not read the report. ' + detail);
          }
          return body || {};
        });
      })
      .then(function (result) {
        emit('lab_report_extracted', {
          patient_id: patientId,
          inserted: result.inserted || 0
        });
        var inserted = Number(result.inserted || 0);
        if (inserted > 0) {
          setLabStatus('done', 'Done. ' + inserted + ' biomarker value' +
            (inserted === 1 ? '' : 's') + ' read from the report.');
        } else {
          setLabStatus('done', 'Done. No biomarker values were found in that PDF.');
        }
        fileInput.value = '';
        // The backend has written the rows; refresh this patient's view.
        return loadBiomarkers(patientId).then(function () {
          renderBiomarkers();
          renderReport();
        });
      })
      .catch(function (err) {
        var msg = (err && err.message) ? err.message : String(err);
        setLabStatus('err', msg);
      })
      .then(function () {
        btn.disabled = false;
        fileInput.disabled = false;
      });
  });

  // Clear a stale status when a new file is chosen.
  document.getElementById('labFile').addEventListener('change', clearLabStatus);

  /* ---- Cognitive Wellness score ------------------------------------- */
  function renderCognitive() {
    var el = document.getElementById('cwCurrent');
    if (current.cognitive_wellness_score != null) {
      el.innerHTML = '<b>' + esc(current.cognitive_wellness_score) + '</b> / 100' +
        (current.cognitive_wellness_dated_on
          ? '  ·  ' + esc(fmtDate(current.cognitive_wellness_dated_on)) : '');
    } else {
      el.textContent = 'Not recorded yet.';
    }
    document.getElementById('cwScore').value =
      current.cognitive_wellness_score != null ? current.cognitive_wellness_score : '';
  }

  document.getElementById('cwSave').addEventListener('click', function () {
    var cwErr = document.getElementById('cwErr');
    var cwOk = document.getElementById('cwOk');
    cwErr.style.display = 'none'; cwOk.style.display = 'none';
    if (!current) return;

    var scoreStr = document.getElementById('cwScore').value.trim();
    var dateStr = document.getElementById('cwDate').value;
    var score = Number(scoreStr);
    if (scoreStr === '' || !isFinite(score) || score < 0 || score > 100) {
      cwErr.textContent = 'Enter a score between 0 and 100.';
      cwErr.style.display = 'block';
      return;
    }
    var btn = document.getElementById('cwSave');
    btn.disabled = true; btn.textContent = 'Saving...';
    sb.from(T_PATIENTS).update({
      cognitive_wellness_score: score,
      cognitive_wellness_dated_on: dateStr || todayISO()
    }).eq('id', current.id)
      .then(function (res) {
        if (res.error) throw res.error;
        emit('cognitive_score_saved', { patient_id: current.id });
        current.cognitive_wellness_score = score;
        current.cognitive_wellness_dated_on = dateStr || todayISO();
        renderCognitive();
        renderReport();
        cwOk.style.display = 'block';
        window.setTimeout(function () { cwOk.style.display = 'none'; }, 2500);
      })
      .catch(function (err) {
        cwErr.textContent = 'Could not save the score. ' + esc(String(err && err.message || err));
        cwErr.style.display = 'block';
      })
      .then(function () {
        btn.disabled = false; btn.textContent = 'Save';
      });
  });

  /* ---- Patient summary / report ------------------------------------- */
  var reportHead = document.getElementById('reportHead');
  reportHead.addEventListener('click', function () {
    var rep = document.getElementById('report');
    rep.classList.toggle('open');
    document.getElementById('reportToggle').textContent =
      rep.classList.contains('open') ? 'Hide' : 'Show';
    if (rep.classList.contains('open')) emit('report_opened', { patient_id: current.id });
  });

  function renderReport() {
    var body = document.getElementById('reportBody');
    var name = current.full_name;
    var age = ageFrom(current.date_of_birth);

    var latest = rounds.length ? rounds[rounds.length - 1] : null;
    var first = rounds.length ? rounds[0] : null;

    // Narrative — deterministic, plain, no hype.
    var lines = [];
    if (latest) {
      var s = Number(latest.readiness_score);
      lines.push('As of ' + fmtDate(latest.created_at) + ', ' + name +
        ' has a healthspan readiness score of ' + s + ' out of 100, which sits in the ' +
        scoreBand(s).toLowerCase() + ' range.');
      if (rounds.length > 1) {
        var d = s - Number(first.readiness_score);
        if (d > 0) {
          lines.push('Across ' + rounds.length + ' rounds since ' + fmtDate(first.created_at) +
            ', the score has risen by ' + d + ' points.');
        } else if (d < 0) {
          lines.push('Across ' + rounds.length + ' rounds since ' + fmtDate(first.created_at) +
            ', the score has fallen by ' + Math.abs(d) + ' points, which is worth discussing at the next visit.');
        } else {
          lines.push('Across ' + rounds.length + ' rounds since ' + fmtDate(first.created_at) +
            ', the score has held steady.');
        }
      } else {
        lines.push('This is the first recorded round. The intake is built to be re-taken every few months so a trend can form.');
      }
      var syms = latest.symptoms || [];
      if (syms.length) {
        lines.push('At the most recent round the patient flagged ' + syms.length +
          ' current symptom' + (syms.length === 1 ? '' : 's') + '.');
      } else {
        lines.push('At the most recent round the patient flagged no current symptoms.');
      }
    } else {
      lines.push(name + ' has not yet completed an intake round. Share the /intake link to begin tracking healthspan readiness.');
    }
    if (current.cognitive_wellness_score != null) {
      lines.push('Cognitive Wellness score is ' + current.cognitive_wellness_score +
        ' out of 100' + (current.cognitive_wellness_dated_on
          ? ', recorded ' + fmtDate(current.cognitive_wellness_dated_on) : '') + '.');
    }
    if (biomarkers.length) {
      var markerKeys = {};
      biomarkers.forEach(function (b) { markerKeys[b.marker_key] = true; });
      lines.push(biomarkers.length + ' lab value' + (biomarkers.length === 1 ? '' : 's') +
        ' recorded across ' + Object.keys(markerKeys).length + ' marker' +
        (Object.keys(markerKeys).length === 1 ? '' : 's') + '.');
    }

    var goals = latest && latest.longevity_goals ? latest.longevity_goals : [];

    var html = '';
    html += '<div class="r-title">' + esc(name) + '</div>';
    html += '<div class="r-date">Healthspan summary' +
      (age != null ? '  ·  ' + age + ' years' : '') +
      '  ·  generated ' + fmtDate(todayISO()) + '</div>';

    html += '<div class="r-stats">';
    html += '<div class="r-stat"><div class="rs-num">' +
      (latest ? Number(latest.readiness_score) : '—') +
      '</div><div class="rs-label">Readiness</div></div>';
    html += '<div class="r-stat"><div class="rs-num">' +
      (current.cognitive_wellness_score != null ? current.cognitive_wellness_score : '—') +
      '</div><div class="rs-label">Cognition</div></div>';
    html += '<div class="r-stat"><div class="rs-num">' + rounds.length +
      '</div><div class="rs-label">Rounds</div></div>';
    html += '<div class="r-stat"><div class="rs-num">' + biomarkers.length +
      '</div><div class="rs-label">Lab values</div></div>';
    html += '</div>';

    lines.forEach(function (l) { html += '<p>' + esc(l) + '</p>'; });

    if (goals.length) {
      html += '<p style="margin-top:12px;"><b style="font-weight:500;color:var(--fg)">' +
        'Stated longevity goals</b></p><div class="r-list">';
      goals.forEach(function (g) { html += '<span class="chip">' + esc(g) + '</span>'; });
      html += '</div>';
    }

    var fam = latest && latest.family_history ? latest.family_history.filter(function (x) { return x !== 'None'; }) : [];
    var pers = latest && latest.personal_history ? latest.personal_history.filter(function (x) { return x !== 'None'; }) : [];
    if (pers.length) {
      html += '<p style="margin-top:12px;"><b style="font-weight:500;color:var(--fg)">' +
        'Personal history</b></p><div class="r-list">';
      pers.forEach(function (c) { html += '<span class="chip">' + esc(c) + '</span>'; });
      html += '</div>';
    }
    if (fam.length) {
      html += '<p style="margin-top:10px;"><b style="font-weight:500;color:var(--fg)">' +
        'Family history</b></p><div class="r-list">';
      fam.forEach(function (c) { html += '<span class="chip">' + esc(c) + '</span>'; });
      html += '</div>';
    }

    html += '<div class="r-print">' +
      '<button class="btn" id="printReport">Print this summary</button>' +
      '<span style="font-size:11.5px;color:var(--faint);margin-left:10px;">' +
      'Opens the browser print dialog. Save as PDF to share.</span></div>';

    body.innerHTML = html;

    var printBtn = document.getElementById('printReport');
    if (printBtn) {
      printBtn.addEventListener('click', function () {
        emit('report_printed', { patient_id: current.id });
        window.print();
      });
    }
  }

})();
