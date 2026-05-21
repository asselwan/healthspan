/* NOMOI Healthspan — patient intake logic.
 *
 * A five-step, RE-TAKEABLE longevity intake. Every submission is a dated
 * "round". On submit the client computes a deterministic readiness score
 * (0-100) from the lifestyle and symptom answers, then writes a patient
 * row and a round row to Supabase.
 *
 * If the anon key is not yet configured (or the migration is not applied),
 * the form runs in demo mode: it validates, scores, and shows the
 * confirmation screen, but does not call Supabase.
 *
 * IMPORTANT — anon key is INSERT-only by RLS. It cannot read a row back,
 * so inserts must NOT chain a .select(); doing so fails with "permission
 * denied". The patient id and round id are minted client-side, so the ids
 * are already known. This is the exact bug fixed in the frontdesk repo.
 */
(function () {
  'use strict';

  var CFG = window.__HEALTHSPAN_CONFIG || {};
  var emit = window.__nomoiSurfaceEmit || function () {};

  var CONFIGURED =
    !!CFG.SUPABASE_URL &&
    !!CFG.ANON_KEY &&
    CFG.ANON_KEY !== 'REPLACE_WITH_SUPABASE_ANON_KEY';

  var sb = null;
  if (CONFIGURED && window.supabase && window.supabase.createClient) {
    try {
      sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.ANON_KEY, {
        db: { schema: CFG.SCHEMA || 'public' },
        auth: { persistSession: false }
      });
    } catch (e) {
      sb = null;
    }
  }
  if (!sb) {
    document.getElementById('demoBanner').classList.add('show');
  }

  /* ===================================================================
   * READINESS SCORE — deterministic, transparent, 0-100.
   *
   * The score starts from a neutral baseline of 50 and is moved by six
   * lifestyle components and one symptom penalty. Each component has a
   * fixed weight (the maximum points it can add) and a 0..1 quality
   * factor derived only from the patient's answer. The component
   * contribution is weight * factor. Symptoms subtract a fixed amount
   * each, capped. The total is clamped to [0, 100] and rounded.
   *
   *   base                = 50
   *   sleep    (max +12)  factor by closeness to 7-9 h
   *   exercise (max +12)  factor = min(days, 5) / 5
   *   nutrition(max +9)   whole_food 1.0 / mixed 0.5 / processed 0.0
   *   alcohol  (max +6)   none 1.0 / light 0.8 / moderate 0.4 / heavy 0.0
   *   smoking  (max +6)   never 1.0 / former 0.6 / current 0.0
   *   stress   (max +5)   factor = (5 - stress) / 4   (stress 1..5)
   *   symptoms (penalty)  -3 per symptom, capped at -15
   *
   * Maximum reachable = 50 + 12 + 12 + 9 + 6 + 6 + 5 = 100.
   * Minimum reachable = 50 + 0 + 0 + 0 + 0 + 0 + 0 - 15 = 35, then any
   * unfilled-but-required answer cannot occur because step 2 is required.
   * The score is a readiness indicator, never a diagnosis.
   * =================================================================== */
  var SCORE = {
    base: 50,
    weights: { sleep: 12, exercise: 12, nutrition: 9, alcohol: 6, smoking: 6, stress: 5 },
    symptomPenaltyEach: 3,
    symptomPenaltyCap: 15
  };

  function sleepFactor(hours) {
    var h = Number(hours);
    if (!isFinite(h) || h <= 0) return 0;
    // Full credit in the 7-9 h band, linear falloff to 0 at 4 h and 11 h.
    if (h >= 7 && h <= 9) return 1;
    if (h < 7) return Math.max(0, (h - 4) / 3);
    return Math.max(0, (11 - h) / 2);
  }
  function exerciseFactor(days) {
    var d = Number(days);
    if (!isFinite(d) || d < 0) return 0;
    return Math.min(d, 5) / 5;
  }
  function nutritionFactor(v) {
    return ({ whole_food: 1, mixed: 0.5, processed_heavy: 0 })[v] || 0;
  }
  function alcoholFactor(v) {
    return ({ none: 1, light: 0.8, moderate: 0.4, heavy: 0 })[v] != null
      ? { none: 1, light: 0.8, moderate: 0.4, heavy: 0 }[v] : 0.5;
  }
  function smokingFactor(v) {
    return ({ never: 1, former: 0.6, current: 0 })[v] != null
      ? { never: 1, former: 0.6, current: 0 }[v] : 0.5;
  }
  function stressFactor(level) {
    var s = Number(level);
    if (!isFinite(s)) return 0.5;
    return Math.max(0, Math.min(1, (5 - s) / 4));
  }

  // Returns { score, breakdown } where breakdown lists each component's
  // points so the confirmation screen can show how the score was reached.
  function computeReadiness(a) {
    var w = SCORE.weights;
    var parts = [
      { key: 'sleep',     label: 'Sleep',     pts: w.sleep * sleepFactor(a.sleep_hours),         max: w.sleep },
      { key: 'exercise',  label: 'Activity',  pts: w.exercise * exerciseFactor(a.exercise_days), max: w.exercise },
      { key: 'nutrition', label: 'Nutrition', pts: w.nutrition * nutritionFactor(a.nutrition_pattern), max: w.nutrition },
      { key: 'alcohol',   label: 'Alcohol',   pts: w.alcohol * alcoholFactor(a.alcohol_pattern), max: w.alcohol },
      { key: 'smoking',   label: 'Smoking',   pts: w.smoking * smokingFactor(a.smoking_status),  max: w.smoking },
      { key: 'stress',    label: 'Stress',    pts: w.stress * stressFactor(a.perceived_stress),  max: w.stress }
    ];
    var symptomCount = (a.symptoms || []).length;
    var symptomPenalty = Math.min(symptomCount * SCORE.symptomPenaltyEach, SCORE.symptomPenaltyCap);

    var raw = SCORE.base;
    parts.forEach(function (p) { raw += p.pts; });
    raw -= symptomPenalty;

    var score = Math.max(0, Math.min(100, Math.round(raw)));

    var breakdown = { base: SCORE.base, components: {}, symptom_penalty: symptomPenalty, symptom_count: symptomCount };
    parts.forEach(function (p) {
      breakdown.components[p.key] = { label: p.label, points: Math.round(p.pts * 10) / 10, max: p.max };
    });
    breakdown.parts = parts.map(function (p) {
      return { key: p.key, label: p.label, points: Math.round(p.pts * 10) / 10, max: p.max };
    });
    return { score: score, breakdown: breakdown };
  }

  function scoreBand(s) {
    if (s >= 80) return 'Strong footing';
    if (s >= 65) return 'Solid, room to gain';
    if (s >= 50) return 'Mixed picture';
    return 'Worth attention';
  }

  /* ---- Checklist content -------------------------------------------- */
  var GOALS = [
    'Live longer in good health', 'Keep my energy up', 'Stay physically strong',
    'Protect my heart', 'Protect my brain and memory', 'Sleep better',
    'Reach a healthy weight', 'Lower my long-term disease risk'
  ];
  var SYMPTOMS = [
    'Low energy or fatigue', 'Poor sleep', 'Brain fog or poor focus',
    'Joint or muscle pain', 'Shortness of breath', 'Frequent low mood',
    'Unexplained weight change', 'Frequent headaches'
  ];
  var CONDITIONS = [
    'Hypertension', 'Diabetes or pre-diabetes', 'High cholesterol',
    'Heart disease', 'Stroke', 'Cancer', 'Thyroid disorder', 'None'
  ];

  function buildChecklist(hostId, name, items) {
    var host = document.getElementById(hostId);
    items.forEach(function (it) {
      var lab = document.createElement('label');
      lab.className = 'check';
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.name = name;
      input.value = it;
      var box = document.createElement('span');
      box.className = 'box';
      var txt = document.createElement('span');
      txt.className = 'c-text';
      txt.textContent = it;
      lab.appendChild(input);
      lab.appendChild(box);
      lab.appendChild(txt);
      host.appendChild(lab);
    });
  }
  buildChecklist('goalList', 'goal', GOALS);
  buildChecklist('symptomList', 'symptom', SYMPTOMS);
  buildChecklist('personalList', 'personal_condition', CONDITIONS);
  buildChecklist('familyList', 'family_condition', CONDITIONS);

  /* ---- Step navigation ---------------------------------------------- */
  var TOTAL = 5;
  var current = 1;
  var steps = {};
  document.querySelectorAll('.step[data-step]').forEach(function (el) {
    steps[el.getAttribute('data-step')] = el;
  });
  var fill = document.getElementById('progressFill');
  var stepLabels = document.querySelectorAll('#progressSteps span');

  function renderProgress() {
    fill.style.width = (current / TOTAL) * 100 + '%';
    stepLabels.forEach(function (s) {
      var n = parseInt(s.getAttribute('data-step'), 10);
      s.classList.toggle('active', n === current);
      s.classList.toggle('done', n < current);
    });
  }
  function showStep(n) {
    Object.keys(steps).forEach(function (k) {
      steps[k].hidden = parseInt(k, 10) !== n;
    });
    current = n;
    renderProgress();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    emit('intake_step_view', { step: n });
  }

  /* ---- Validation ---------------------------------------------------- */
  function setInvalid(fieldEl, msg) {
    fieldEl.classList.add('invalid');
    if (msg) {
      var err = fieldEl.querySelector('.field-err');
      if (err) err.textContent = msg;
    }
  }
  function clearInvalid(fieldEl) { fieldEl.classList.remove('invalid'); }

  function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

  function checkRequiredText(stepEl, name, msg) {
    var f = stepEl.querySelector('[data-name="' + name + '"]');
    if (!f) return true;
    var input = f.querySelector('input, textarea, select');
    if (!input.value.trim()) { setInvalid(f, msg); return false; }
    clearInvalid(f);
    return true;
  }
  function checkRequiredRadio(stepEl, name, msg) {
    var f = stepEl.querySelector('[data-name="' + name + '"]');
    if (!f) return true;
    var picked = f.querySelector('input[type="radio"]:checked');
    if (!picked) { setInvalid(f, msg); return false; }
    clearInvalid(f);
    return true;
  }

  function validateStep(n) {
    var ok = true;
    var stepEl = steps[String(n)];

    if (n === 1) {
      ok = checkRequiredText(stepEl, 'patient_name', 'Please enter your full name.') && ok;
      var emF = stepEl.querySelector('[data-name="patient_email"]');
      var emV = emF.querySelector('input').value.trim();
      if (emV && !isEmail(emV)) { setInvalid(emF, 'Please enter a valid email address.'); ok = false; }
      else clearInvalid(emF);
    }

    if (n === 2) {
      ok = checkRequiredText(stepEl, 'sleep_hours', 'Please enter your typical sleep hours.') && ok;
      ok = checkRequiredRadio(stepEl, 'exercise_days', 'Please choose how many days you are active.') && ok;
      ok = checkRequiredText(stepEl, 'nutrition_pattern', 'Please choose the option that fits best.') && ok;
      ok = checkRequiredText(stepEl, 'alcohol_pattern', 'Please choose your alcohol pattern.') && ok;
      ok = checkRequiredText(stepEl, 'smoking_status', 'Please choose your smoking status.') && ok;
      ok = checkRequiredRadio(stepEl, 'perceived_stress', 'Please rate your recent stress.') && ok;
    }

    // Steps 3 and 4 are all optional.

    if (n === 5) {
      var cs = stepEl.querySelector('[data-name="consent_store"]');
      var csErr = stepEl.querySelector('[data-name="consent_store_err"]');
      if (!cs.querySelector('input').checked) {
        cs.classList.add('invalid'); csErr.classList.add('invalid'); ok = false;
      } else { cs.classList.remove('invalid'); csErr.classList.remove('invalid'); }
    }

    return ok;
  }

  document.getElementById('intakeForm').addEventListener('input', function (ev) {
    var f = ev.target.closest('.field, .consent-block');
    if (f && f.classList.contains('invalid')) clearInvalid(f);
    if (ev.target.name === 'consent_store') {
      steps['5'].querySelector('[data-name="consent_store"]').classList.remove('invalid');
      steps['5'].querySelector('[data-name="consent_store_err"]').classList.remove('invalid');
    }
  });
  document.getElementById('intakeForm').addEventListener('change', function (ev) {
    var f = ev.target.closest('.field');
    if (f && f.classList.contains('invalid')) clearInvalid(f);
  });

  /* ---- Next / Back --------------------------------------------------- */
  document.querySelectorAll('[data-next]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (!validateStep(current)) {
        emit('intake_step_blocked', { step: current });
        var firstErr = steps[String(current)].querySelector('.invalid');
        if (firstErr) firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (current < TOTAL) showStep(current + 1);
    });
  });
  document.querySelectorAll('[data-back]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (current > 1) showStep(current - 1);
    });
  });

  /* ---- Collect ------------------------------------------------------- */
  function collect() {
    var form = document.getElementById('intakeForm');
    function val(name) {
      var el = form.querySelector('[name="' + name + '"]');
      return el ? el.value.trim() : '';
    }
    function num(name) {
      var v = val(name);
      if (v === '') return null;
      var n = Number(v);
      return isFinite(n) ? n : null;
    }
    function intOf(name) {
      var n = num(name);
      return n == null ? null : Math.round(n);
    }
    function radioVal(name) {
      var el = form.querySelector('input[name="' + name + '"]:checked');
      return el ? el.value : null;
    }
    function checked(name) {
      var out = [];
      form.querySelectorAll('input[name="' + name + '"]:checked').forEach(function (c) {
        out.push(c.value);
      });
      return out;
    }
    return {
      patient_name: val('patient_name'),
      patient_email: val('patient_email') || null,
      sleep_hours: num('sleep_hours'),
      exercise_days: radioVal('exercise_days') != null ? parseInt(radioVal('exercise_days'), 10) : null,
      nutrition_pattern: val('nutrition_pattern') || null,
      alcohol_pattern: val('alcohol_pattern') || null,
      smoking_status: val('smoking_status') || null,
      perceived_stress: radioVal('perceived_stress') != null ? parseInt(radioVal('perceived_stress'), 10) : null,
      longevity_goals: checked('goal'),
      symptoms: checked('symptom'),
      personal_history: checked('personal_condition'),
      family_history: checked('family_condition'),
      height_cm: num('height_cm'),
      weight_kg: num('weight_kg'),
      resting_heart_rate: intOf('resting_heart_rate'),
      bp_systolic: intOf('bp_systolic'),
      bp_diastolic: intOf('bp_diastolic'),
      consent_store: !!form.querySelector('[name="consent_store"]').checked,
      consent_share: !!form.querySelector('[name="consent_share"]').checked,
      user_agent: navigator.userAgent
    };
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
  function shortRef(id) {
    return 'HS-' + String(id).replace(/-/g, '').slice(0, 8).toUpperCase();
  }

  /* ---- Submit -------------------------------------------------------- */
  var submitBtn = document.getElementById('submitBtn');
  var submitErr = document.getElementById('submitErr');

  document.getElementById('intakeForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (!validateStep(5)) {
      var firstErr = steps['5'].querySelector('.invalid');
      if (firstErr) firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    submitErr.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
    emit('intake_submit_start', {});

    var answers = collect();
    var scored = computeReadiness(answers);

    // Demo mode — no Supabase configured.
    if (!sb) {
      window.setTimeout(function () {
        finish('DEMO-' + Date.now().toString(36).toUpperCase().slice(-6), scored);
      }, 600);
      return;
    }

    // Mint ids client-side. The anon key is INSERT-only (RLS) and cannot
    // read a row back, so neither insert chains a .select().
    var patientId = uuid();
    var roundId = uuid();

    var patientRow = {
      id: patientId,
      full_name: answers.patient_name,
      email: answers.patient_email
    };
    var roundRow = {
      id: roundId,
      patient_id: patientId,
      patient_name: answers.patient_name,
      patient_email: answers.patient_email,
      sleep_hours: answers.sleep_hours,
      exercise_days: answers.exercise_days,
      nutrition_pattern: answers.nutrition_pattern,
      alcohol_pattern: answers.alcohol_pattern,
      perceived_stress: answers.perceived_stress,
      smoking_status: answers.smoking_status,
      longevity_goals: answers.longevity_goals,
      symptoms: answers.symptoms,
      personal_history: answers.personal_history,
      family_history: answers.family_history,
      height_cm: answers.height_cm,
      weight_kg: answers.weight_kg,
      resting_heart_rate: answers.resting_heart_rate,
      bp_systolic: answers.bp_systolic,
      bp_diastolic: answers.bp_diastolic,
      readiness_score: scored.score,
      readiness_breakdown: scored.breakdown,
      consent_store: answers.consent_store,
      consent_share: answers.consent_share,
      user_agent: answers.user_agent
    };

    // Insert the patient first so the round's foreign key resolves. If the
    // patient insert fails the round still inserts with the patient_id
    // present; the dashboard reconciles by patient_name as a fallback.
    sb.from(CFG.PATIENTS_TABLE).insert(patientRow)
      .then(function () {
        // Ignore a patient insert error: the round carries patient_name
        // and the FK is ON DELETE SET NULL, so the round is still useful.
        return sb.from(CFG.ROUNDS_TABLE).insert(roundRow);
      })
      .then(function (res) {
        if (res && res.error) throw res.error;
        emit('intake_submit_success', { round_id: roundId, score: scored.score });
        finish(shortRef(roundId), scored);
      })
      .catch(function (err) {
        emit('intake_submit_error', { message: String(err && err.message || err) });
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit round';
        submitErr.textContent =
          'We could not save this round just now. Please check your connection and try again. ' +
          'If it keeps happening, your clinic can complete it with you in person.';
        submitErr.style.display = 'block';
      });
  });

  /* ---- Confirmation screen ------------------------------------------ */
  function finish(ref, scored) {
    document.getElementById('introCard').hidden = true;
    document.querySelector('.progress').style.display = 'none';
    document.getElementById('intakeForm').hidden = true;
    var done = document.getElementById('doneCard');
    done.hidden = false;

    document.getElementById('doneRef').textContent = 'Reference ' + ref;
    document.getElementById('scoreBand').textContent = scoreBand(scored.score);

    // Animate the ring and the number.
    var arc = document.getElementById('scoreArc');
    var circ = 2 * Math.PI * 58; // 364.4
    var target = circ * (1 - scored.score / 100);
    var numEl = document.getElementById('scoreNum');
    var start = null;
    function step(ts) {
      if (start == null) start = ts;
      var t = Math.min(1, (ts - start) / 900);
      var eased = 1 - Math.pow(1 - t, 3);
      arc.style.strokeDashoffset = String(circ - (circ - target) * eased);
      numEl.textContent = String(Math.round(scored.score * eased));
      if (t < 1) requestAnimationFrame(step);
      else numEl.textContent = String(scored.score);
    }
    arc.style.strokeDashoffset = String(circ);
    requestAnimationFrame(step);

    // Render the per-component breakdown.
    var host = document.getElementById('bdRows');
    var rows = '';
    rows += bdRow('Baseline', scored.breakdown.base, 50);
    scored.breakdown.parts.forEach(function (p) {
      rows += bdRow(p.label, p.points, p.max);
    });
    if (scored.breakdown.symptom_penalty > 0) {
      rows += bdRow('Symptoms', -scored.breakdown.symptom_penalty, 15, true);
    }
    host.innerHTML = rows;

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function bdRow(label, points, max, isPenalty) {
    var pct = max > 0 ? Math.max(0, Math.min(100, (Math.abs(points) / max) * 100)) : 0;
    var color = isPenalty ? '#e08c7d' : (label === 'Baseline' ? '#c4976b' : '#5bbfab');
    var shown = (points > 0 && !isPenalty ? '+' : '') + points + ' / ' +
      (isPenalty ? '-' + max : max);
    return '<div class="bd-row">' +
      '<span class="bd-label">' + esc(label) + '</span>' +
      '<span class="bd-track"><span class="bd-bar" style="width:' + pct + '%;background:' + color + ';"></span></span>' +
      '<span class="bd-val">' + esc(shown) + '</span>' +
      '</div>';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---- Init ---------------------------------------------------------- */
  renderProgress();

  // Expose the scorer for tests / inspection.
  window.__healthspanComputeReadiness = computeReadiness;
})();
