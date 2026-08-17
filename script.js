// scan_scheduler 플러그인 풀페이지 스크립트
// jikji_sf와 동일하게 new Function('pluginId', 'container', ...)로 실행되므로
// import 없이 전역 API + 인자로 받는 pluginId/container만 사용합니다.

(function () {
  const LOG_PREFIX = '[scan_scheduler]';
  console.log(LOG_PREFIX, '0/3 Fullpage Timetable UI loaded.');

  let allItems = [];
  let currentEditItem = null; // 지금 편집 패널에서 다루고 있는 item (allItems의 원소 참조)
  let helperListenersBound = false;
  let viewMode = 'grid'; // 'grid' (요일×시간) | 'timeline' (라이브러리별)

  const SCOPE_COLORS = {
    general: '#3b82f6',
    adult: '#ec4899',
    audiobook: '#22c55e',
  };

  // 그리드 뷰의 요일 컬럼 순서(월~일). dow는 cron 표준(0=일요일)의 값.
  const GRID_DAYS = [
    { label: '월', dow: 1 },
    { label: '화', dow: 2 },
    { label: '수', dow: 3 },
    { label: '목', dow: 4 },
    { label: '금', dow: 5 },
    { label: '토', dow: 6 },
    { label: '일', dow: 0 },
  ];

  // ------------------------------------------------------------------
  // cron 파싱 (분/시 필드만 사용, 표준 5필드 cron 가정: 분 시 일 월 요일)
  // ------------------------------------------------------------------
  function parseCronField(field, min, max) {
    if (!field || field === '*') {
      const arr = [];
      for (let i = min; i <= max; i += 1) arr.push(i);
      return arr;
    }
    const result = [];
    field.split(',').forEach((part) => {
      let step = 1;
      let rangePart = part;
      if (part.includes('/')) {
        const [r, s] = part.split('/');
        rangePart = r;
        step = parseInt(s, 10) || 1;
      }
      let start = min;
      let end = max;
      if (rangePart !== '*') {
        if (rangePart.includes('-')) {
          const [s, e] = rangePart.split('-').map(Number);
          if (!Number.isNaN(s)) start = s;
          if (!Number.isNaN(e)) end = e;
        } else {
          const v = parseInt(rangePart, 10);
          if (!Number.isNaN(v)) {
            start = v;
            end = v;
          }
        }
      }
      for (let i = start; i <= end; i += step) result.push(i);
    });
    return Array.from(new Set(result)).sort((a, b) => a - b);
  }

  // 요일별 색상 (겹침 여부와 무관하게 항상 이 색으로 표시, 겹치면 빨간 테두리 추가)
  const DOW_COLORS = {
    null: '#94a3b8', // 매일(요일 필드가 *) - 슬레이트
    0: '#ef4444', // 일요일 - 빨강
    1: '#f97316', // 월요일 - 주황
    2: '#eab308', // 화요일 - 노랑
    3: '#22c55e', // 수요일 - 초록
    4: '#06b6d4', // 목요일 - 청록
    5: '#3b82f6', // 금요일 - 파랑
    6: '#a855f7', // 토요일 - 보라
  };
  const DOW_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

  // cron 문자열 -> [{hour, minute, dow}, ...]. dow는 0~6 또는 요일필드가 '*'
  // (매일)이면 null. 파싱 실패/빈 값이면 빈 배열.
  function cronToTimes(cronStr) {
    if (!cronStr || typeof cronStr !== 'string') return [];
    const fields = cronStr.trim().split(/\s+/);
    if (fields.length < 2) return [];
    try {
      const minutes = parseCronField(fields[0], 0, 59);
      const hours = parseCronField(fields[1], 0, 23);
      const dowField = fields.length >= 5 ? fields[4] : '*';
      // 요일필드가 '*'이면 "매일" 하나로 취급(dow=null). 아니면 지정된 요일마다
      // 별개의 발생(occurrence)으로 전개한다.
      const dowValues = !dowField || dowField === '*' ? [null] : parseCronField(dowField, 0, 6);

      const times = [];
      hours.forEach((h) => {
        minutes.forEach((m) => {
          dowValues.forEach((d) => {
            times.push({ hour: h, minute: m, dow: d });
          });
        });
      });
      return times;
    } catch (e) {
      console.warn(LOG_PREFIX, 'cron 파싱 실패:', cronStr, e);
      return [];
    }
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function itemKey(item) {
    return `${item.scope}:${item.id}`;
  }

  // 편집 중이면 아직 저장 안 된 미리보기 값을, 아니면 실제 저장된 값을 반환
  function effectiveCron(item) {
    return item._pendingCron != null ? item._pendingCron : item.cron_schedule;
  }

  // 두 발생(occurrence)이 실제로 같은 날 겹치는지: 요일이 같거나(dow===dow),
  // 둘 중 하나라도 "매일"(dow=null)이면 그 요일과는 항상 겹친다.
  function sameDay(d1, d2) {
    if (d1 === null || d2 === null) return true;
    return d1 === d2;
  }

  // ------------------------------------------------------------------
  // 겹침 계산: scope 구분 없이 전체(같은 서버/스토리지 자원을 공유한다고
  // 가정)에서 같은 요일 + 같은 hour:minute에 2개 이상 라이브러리가 몰리면
  // "겹침"으로 표시. 요일이 다르면(예: 일요일 03:00 vs 월요일 03:00) 시:분이
  // 같아도 겹침으로 보지 않는다. 편집 중인 항목은 미리보기(pending) 값 기준.
  // 겹침 결과는 각 occurrence 객체(t)에 t.isOverlap으로 직접 표시해둔다.
  // ------------------------------------------------------------------
  function computeOverlapMap(items) {
    const occurrences = []; // [{item, t}, ...] 전체 발생 목록 (너무 촘촘한 cron은 제외)
    items.forEach((item) => {
      const times = cronToTimes(effectiveCron(item));
      item._times = times;
      if (times.length > 96) return; // 매우 잦은 주기는 겹침 판정에서 제외
      times.forEach((t) => {
        t.isOverlap = false;
        occurrences.push({ item, t });
      });
    });

    let overlapCount = 0;
    for (let i = 0; i < occurrences.length; i += 1) {
      for (let j = i + 1; j < occurrences.length; j += 1) {
        const a = occurrences[i];
        const b = occurrences[j];
        if (a.item === b.item) continue; // 같은 라이브러리 내부 발생끼리는 비교 안 함
        if (a.t.hour !== b.t.hour || a.t.minute !== b.t.minute) continue;
        if (!sameDay(a.t.dow, b.t.dow)) continue;
        if (!a.t.isOverlap) overlapCount += 1;
        if (!b.t.isOverlap) overlapCount += 1;
        a.t.isOverlap = true;
        b.t.isOverlap = true;
      }
    }
    return overlapCount;
  }

  function renderAxis() {
    const row = el('div', 'rm-axis-row');
    for (let h = 0; h < 24; h += 1) {
      row.appendChild(el('span', 'rm-axis-cell', h % 3 === 0 ? `${pad2(h)}시` : ''));
    }
    return row;
  }

  function renderTimeline(item) {
    const timeline = el('div', 'rm-timeline');
    const times = item._times || [];
    const cronStr = effectiveCron(item);

    if (times.length === 0) {
      const empty = el('span', 'rm-no-schedule', 'cron 없음/파싱불가');
      empty.style.position = 'absolute';
      empty.style.left = '4px';
      empty.style.top = '50%';
      empty.style.transform = 'translateY(-50%)';
      timeline.appendChild(empty);
      return timeline;
    }

    if (times.length > 96) {
      const bar = el('div');
      bar.style.position = 'absolute';
      bar.style.left = '0';
      bar.style.right = '0';
      bar.style.top = '50%';
      bar.style.height = '6px';
      bar.style.transform = 'translateY(-50%)';
      bar.style.borderRadius = '3px';
      bar.style.background = 'rgba(59, 130, 246, 0.55)';
      bar.title = `${cronStr} (매우 잦은 주기)`;
      timeline.appendChild(bar);
      return timeline;
    }

    times.forEach((t) => {
      const marker = el('div', 'rm-marker' + (t.isOverlap ? ' rm-overlap' : ''));
      if (times.length > 12) marker.classList.add('rm-many');
      marker.style.backgroundColor = DOW_COLORS[t.dow];
      const pct = ((t.hour * 60 + t.minute) / 1440) * 100;
      marker.style.left = `${pct}%`;
      const dayText = t.dow === null ? '매일' : `${DOW_LABELS[t.dow]}요일`;
      marker.title = `${item.name} · ${dayText} ${pad2(t.hour)}:${pad2(t.minute)}${
        t.isOverlap ? ' (같은 요일·시간에 다른 라이브러리와 겹침)' : ''
      }`;
      timeline.appendChild(marker);
    });

    return timeline;
  }

  function renderLibRow(item) {
    const isEditing = currentEditItem && itemKey(currentEditItem) === itemKey(item);
    const row = el('div', 'rm-lib-row' + (isEditing ? ' rm-editing' : ''));

    const label = el('div', 'rm-lib-label');
    const nameSpan = el('span', null, item.name);
    label.appendChild(nameSpan);

    const icons = el('span', 'rm-lib-icons');
    if (item.is_remote) {
      const cloud = el('i', 'fa-solid fa-cloud');
      cloud.title = item.rclone_rc_url
        ? `원격(rclone) 마운트: ${item.rclone_rc_url}`
        : '원격(rclone) 마운트';
      icons.appendChild(cloud);
    }
    if (item.vfs_refresh_before_scan) {
      const rotate = el('i', 'fa-solid fa-arrows-rotate');
      rotate.title = '스캔 전 VFS refresh 수행';
      icons.appendChild(rotate);
    }
    const editBtn = el('button', 'rm-edit-btn');
    editBtn.type = 'button';
    editBtn.title = '스케줄 편집';
    editBtn.innerHTML = '<i class="fa-solid fa-pen"></i>';
    editBtn.addEventListener('click', () => openEditPanel(item));
    icons.appendChild(editBtn);
    label.appendChild(icons);

    row.appendChild(label);
    row.appendChild(renderTimeline(item));
    return row;
  }

  function renderTimelineInto(container_, items) {
    const scopeOrder = [];
    const byScope = new Map();
    items.forEach((item) => {
      if (!byScope.has(item.scope)) {
        byScope.set(item.scope, []);
        scopeOrder.push(item);
      }
      byScope.get(item.scope).push(item);
    });

    scopeOrder.forEach((firstItem) => {
      const scopeKey = firstItem.scope;
      const scopeItems = byScope.get(scopeKey);
      const block = el('div', 'rm-scope-block');

      const header = el(
        'div',
        'rm-scope-header',
        `${firstItem.scope_label || scopeKey} (${scopeItems.length}개 라이브러리)`
      );
      block.appendChild(header);

      if (scopeItems.length === 0) {
        block.appendChild(el('div', 'rm-scope-empty', '등록된 라이브러리가 없습니다.'));
      } else {
        block.appendChild(renderAxis());
        scopeItems.forEach((item) => {
          block.appendChild(renderLibRow(item));
        });
      }

      container_.appendChild(block);
    });

    if (items.length === 0) {
      container_.appendChild(el('div', 'rm-scope-empty', '표시할 라이브러리가 없습니다.'));
    }
  }

  function hexToRgba(hex, alpha) {
    const h = (hex || '#64748b').replace('#', '');
    const num = parseInt(h, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // 요일(월~일) x 24시간 매트릭스 뷰. item._times(computeOverlapMap가 이미
  // 채워둔 값, dow/hour/minute 포함)를 그대로 재사용해 셀별로 묶는다.
  // "매일"(dow=null) 스케줄은 7개 요일 칸 모두에 나타난다.
  function renderGridTable(items) {
    const wrapper = el('div', 'rm-grid-wrapper');

    if (items.length === 0) {
      wrapper.appendChild(el('div', 'rm-scope-empty', '표시할 라이브러리가 없습니다.'));
      return wrapper;
    }

    // "dow:slot" -> [item, ...] (같은 항목 중복 없이). slot = hour*2 + (0|1),
    // 30분 단위(00분/30분)로 쪼갠 인덱스(0~47).
    const grid = {};
    items.forEach((item) => {
      const seenKeys = new Set();
      (item._times || []).forEach((t) => {
        const slot = t.hour * 2 + (t.minute >= 30 ? 1 : 0);
        const days = t.dow === null ? [0, 1, 2, 3, 4, 5, 6] : [t.dow];
        days.forEach((d) => {
          const key = `${d}:${slot}`;
          if (seenKeys.has(key)) return;
          seenKeys.add(key);
          if (!grid[key]) grid[key] = [];
          grid[key].push(item);
        });
      });
    });

    const table = el('table', 'rm-grid-table');

    const thead = el('thead');
    const headRow = el('tr');
    headRow.appendChild(el('th', 'rm-grid-corner', '시간'));
    GRID_DAYS.forEach((d) => headRow.appendChild(el('th', 'rm-grid-daycol', `${d.label}요일`)));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (let slot = 0; slot < 48; slot += 1) {
      const h = Math.floor(slot / 2);
      const m = slot % 2 === 0 ? '00' : '30';
      const row = el('tr', 'rm-grid-row' + (m === '00' ? ' rm-grid-hour-start' : ''));
      row.appendChild(el('td', 'rm-grid-hourcol', `${pad2(h)}:${m}`));
      GRID_DAYS.forEach((d) => {
        const key = `${d.dow}:${slot}`;
        const cellItems = grid[key] || [];
        const td = el('td', 'rm-grid-cell' + (cellItems.length > 1 ? ' rm-grid-overlap' : ''));
        cellItems.forEach((it) => {
          const isEditing = currentEditItem && itemKey(currentEditItem) === itemKey(it);
          const chip = el('span', 'rm-grid-chip' + (isEditing ? ' rm-grid-chip-editing' : ''), it.name);
          const color = SCOPE_COLORS[it.scope] || '#94a3b8';
          chip.style.background = hexToRgba(color, 0.22);
          chip.style.color = color;
          chip.title = `${it.scope_label || it.scope} · ${it.name} · ${d.label}요일 ${pad2(h)}:${m} (드래그해서 이동 가능)`;
          chip.draggable = true;
          chip.addEventListener('click', () => openEditPanel(it));
          chip.addEventListener('dragstart', (evt) => {
            evt.dataTransfer.setData('text/plain', itemKey(it));
            evt.dataTransfer.effectAllowed = 'move';
            chip.classList.add('rm-dragging');
          });
          chip.addEventListener('dragend', () => {
            chip.classList.remove('rm-dragging');
          });
          td.appendChild(chip);
        });
        const minuteVal = m === '00' ? 0 : 30;
        td.addEventListener('dragover', (evt) => {
          evt.preventDefault();
          evt.dataTransfer.dropEffect = 'move';
          td.classList.add('rm-grid-drop-target');
        });
        td.addEventListener('dragleave', () => {
          td.classList.remove('rm-grid-drop-target');
        });
        td.addEventListener('drop', (evt) => {
          evt.preventDefault();
          td.classList.remove('rm-grid-drop-target');
          handleGridDrop(evt.dataTransfer.getData('text/plain'), d.dow, h, minuteVal);
        });
        row.appendChild(td);
      });
      tbody.appendChild(row);
    }
    table.appendChild(tbody);

    wrapper.appendChild(table);
    return wrapper;
  }

  // 뷰 모드(그리드/타임라인)에 따라 실제 렌더링을 위임하는 진입점.
  function renderActive(items) {
    const container_ = container.querySelector('#rm-timetable');
    const summary = container.querySelector('#rm-summary');
    if (!container_) return;

    const overlapCount = computeOverlapMap(items); // item._times도 함께 채워짐(두 뷰 공용)

    if (summary) {
      summary.innerHTML = '';
      const text = el('span', null, `전체 라이브러리 ${items.length}개 · 겹치는 시간대 `);
      const strong = el('strong', null, `${overlapCount}건`);
      summary.appendChild(text);
      summary.appendChild(strong);
    }

    container_.innerHTML = '';
    if (viewMode === 'grid') {
      container_.appendChild(renderGridTable(items));
    } else {
      renderTimelineInto(container_, items);
    }
  }

  function applyFilter() {
    const searchInput = container.querySelector('#rm-search-input');
    const query = (searchInput ? searchInput.value : '').trim().toLowerCase();
    const filtered = query
      ? allItems.filter((item) => (item.name || '').toLowerCase().includes(query))
      : allItems;
    renderActive(filtered);
  }

  function setViewMode(mode) {
    if (viewMode === mode) return;
    viewMode = mode;
    const gridBtn = container.querySelector('#rm-view-grid-btn');
    const timelineBtn = container.querySelector('#rm-view-timeline-btn');
    const gridLegend = container.querySelector('#rm-grid-legend');
    const timelineLegend = container.querySelector('#rm-timeline-legend');
    gridBtn.classList.toggle('active', mode === 'grid');
    timelineBtn.classList.toggle('active', mode === 'timeline');
    gridLegend.hidden = mode !== 'grid';
    timelineLegend.hidden = mode !== 'timeline';
    applyFilter();
  }

  // ==================================================================
  // 스케줄 도우미 (편집 패널)
  // ==================================================================
  function dowLabel(dow) {
    const labels = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
    return labels[dow] || `요일(${dow})`;
  }

  // cron 문자열 -> 도우미 폼에 채울 값 추정. 표준 패턴(분 시 * * *) 또는
  // (분 시 * * 요일)만 도우미로 표현 가능하고, 그 외는 '직접 입력'으로 처리.
  function parseCronToHelper(cronStr) {
    const fields = (cronStr || '').trim().split(/\s+/);
    if (fields.length < 5) return { type: 'manual' };
    const [minute, hour, dom, month, dow] = fields;
    const isNum = (v) => /^\d+$/.test(v);
    if (isNum(minute) && isNum(hour) && dom === '*' && month === '*') {
      const hh = pad2(parseInt(hour, 10) % 24);
      const mm = pad2(parseInt(minute, 10) % 60);
      if (dow === '*') {
        return { type: 'daily', hh, mm };
      }
      if (/^[0-6]$/.test(dow)) {
        return { type: 'weekly', hh, mm, dow };
      }
    }
    return { type: 'manual' };
  }

  function readHelperFields() {
    return {
      type: container.querySelector('#rm-repeat-type').value,
      time: container.querySelector('#rm-repeat-time').value || '03:00',
      dow: container.querySelector('#rm-repeat-dow').value,
    };
  }

  function buildCronFromHelper() {
    const { type, time, dow } = readHelperFields();
    const [hh, mm] = time.split(':').map((v) => parseInt(v, 10) || 0);
    if (type === 'daily') return `${mm} ${hh} * * *`;
    if (type === 'weekly') return `${mm} ${hh} * * ${dow}`;
    return container.querySelector('#rm-cron-text').value.trim();
  }

  function buildSummaryText() {
    const { type, time, dow } = readHelperFields();
    if (type === 'daily') return `매일 ${time} 실행`;
    if (type === 'weekly') return `매주 ${dowLabel(parseInt(dow, 10))} ${time} 실행`;
    return '직접 입력한 Cron식을 그대로 사용합니다.';
  }

  function updateHelperVisibility() {
    const type = container.querySelector('#rm-repeat-type').value;
    const timeField = container.querySelector('#rm-time-field');
    const dowField = container.querySelector('#rm-dow-field');
    const cronInput = container.querySelector('#rm-cron-text');
    timeField.style.display = type === 'manual' ? 'none' : '';
    dowField.style.display = type === 'weekly' ? '' : 'none';
    cronInput.readOnly = type !== 'manual';
  }

  // 도우미 필드가 바뀔 때마다: cron 텍스트/요약을 갱신하고, 편집 중인 항목의
  // pendingCron을 갱신한 뒤 메인 타임테이블을 즉시 다시 그려 실시간 미리보기.
  function onHelperChanged() {
    updateHelperVisibility();
    const type = readHelperFields().type;
    const cronStr = buildCronFromHelper();

    if (type !== 'manual') {
      container.querySelector('#rm-cron-text').value = cronStr;
    }
    container.querySelector('#rm-helper-summary').textContent =
      `${buildSummaryText()} | Cron: ${cronStr}`;

    if (currentEditItem) {
      currentEditItem._pendingCron = cronStr;
      applyFilter();
    }
  }

  function onCronTextChanged() {
    const type = readHelperFields().type;
    if (type !== 'manual') return;
    const cronStr = container.querySelector('#rm-cron-text').value.trim();
    container.querySelector('#rm-helper-summary').textContent = `직접 입력: ${cronStr || '(비어 있음)'}`;
    if (currentEditItem) {
      currentEditItem._pendingCron = cronStr;
      applyFilter();
    }
  }

  function bindHelperListenersOnce() {
    if (helperListenersBound) return;
    helperListenersBound = true;
    container.querySelector('#rm-repeat-type').addEventListener('change', onHelperChanged);
    container.querySelector('#rm-repeat-time').addEventListener('input', onHelperChanged);
    container.querySelector('#rm-repeat-dow').addEventListener('change', onHelperChanged);
    container.querySelector('#rm-cron-text').addEventListener('input', onCronTextChanged);
    container.querySelector('#rm-edit-close-btn').addEventListener('click', () => closeEditPanel(true));
    container.querySelector('#rm-edit-overlay').addEventListener('click', (evt) => {
      if (evt.target.id === 'rm-edit-overlay') closeEditPanel(true);
    });
    container.querySelector('#rm-edit-save-btn').addEventListener('click', saveEdit);
  }

  function openEditPanel(item) {
    bindHelperListenersOnce();
    currentEditItem = item;
    item._pendingCron = item.cron_schedule;

    container.querySelector('#rm-edit-libname').textContent = `${item.scope_label || item.scope} · ${item.name}`;
    container.querySelector('#rm-save-error').hidden = true;

    const parsed = parseCronToHelper(item.cron_schedule);
    const typeSel = container.querySelector('#rm-repeat-type');
    const timeInput = container.querySelector('#rm-repeat-time');
    const dowSel = container.querySelector('#rm-repeat-dow');
    const cronInput = container.querySelector('#rm-cron-text');

    typeSel.value = parsed.type;
    if (parsed.type === 'daily') {
      timeInput.value = `${parsed.hh}:${parsed.mm}`;
    } else if (parsed.type === 'weekly') {
      timeInput.value = `${parsed.hh}:${parsed.mm}`;
      dowSel.value = parsed.dow;
    }
    cronInput.value = item.cron_schedule || '';

    updateHelperVisibility();
    container.querySelector('#rm-helper-summary').textContent =
      `${buildSummaryText()} | Cron: ${effectiveCron(item)}`;

    container.querySelector('#rm-edit-overlay').hidden = false;
    applyFilter();
  }

  // 그리드 뷰에서 라이브러리 칩을 다른 칸(요일/시간)에 드롭했을 때 호출.
  // 즉시 저장하지 않고, 편집 패널을 그 위치(매주 특정 요일)로 미리 채운 뒤
  // 미리보기만 반영한다 - 실수 방지를 위해 저장은 사용자가 직접 눌러야 함.
  function handleGridDrop(draggedKey, targetDow, targetHour, targetMinute) {
    if (!draggedKey) return;
    const item = allItems.find((it) => itemKey(it) === draggedKey);
    if (!item) return;

    if (!currentEditItem || itemKey(currentEditItem) !== draggedKey) {
      openEditPanel(item);
    }

    const typeSel = container.querySelector('#rm-repeat-type');
    const timeInput = container.querySelector('#rm-repeat-time');
    const dowSel = container.querySelector('#rm-repeat-dow');

    typeSel.value = 'weekly';
    timeInput.value = `${pad2(targetHour)}:${pad2(targetMinute)}`;
    dowSel.value = String(targetDow);

    onHelperChanged(); // pendingCron 재계산 + 요약 갱신 + 타임테이블 실시간 미리보기
    console.log(
      LOG_PREFIX,
      `드래그 이동 미리보기: ${item.name} -> ${DOW_LABELS[targetDow]}요일 ${pad2(targetHour)}:${pad2(targetMinute)} (저장 버튼을 눌러야 확정됨)`
    );
  }

  function closeEditPanel(discardPending) {
    if (currentEditItem && discardPending) {
      delete currentEditItem._pendingCron;
    }
    currentEditItem = null;
    container.querySelector('#rm-edit-overlay').hidden = true;
    applyFilter();
  }

  function saveEdit() {
    if (!currentEditItem) return;
    const cronStr = (currentEditItem._pendingCron || '').trim();
    const errorBox = container.querySelector('#rm-save-error');
    errorBox.hidden = true;

    if (!cronStr || cronStr.split(/\s+/).length < 5) {
      errorBox.textContent = '유효한 5필드 Cron식이 아닙니다 (예: 0 3 * * *).';
      errorBox.hidden = false;
      return;
    }

    const saveBtn = container.querySelector('#rm-edit-save-btn');
    const originalHtml = saveBtn.innerHTML;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 저장 중...';

    const item = currentEditItem;
    fetch('/api/media/books/0/apply-metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: item.scope,
        source: pluginId,
        item_data: {
          action: 'update_cron',
          scope: item.scope,
          id: item.id,
          cron_schedule: cronStr,
        },
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (!data || !data.success) {
          errorBox.textContent = (data && (data.error || data.message)) || '저장에 실패했습니다.';
          errorBox.hidden = false;
          return;
        }
        item.cron_schedule = cronStr;
        delete item._pendingCron;
        console.log(LOG_PREFIX, '저장 완료:', item.name, cronStr);
        closeEditPanel(false);
      })
      .catch((err) => {
        errorBox.textContent = `요청 중 오류: ${err}`;
        errorBox.hidden = false;
      })
      .finally(() => {
        saveBtn.disabled = false;
        saveBtn.innerHTML = originalHtml;
      });
  }

  // ==================================================================
  // 데이터 로딩
  // ==================================================================
  function fetchSchedules() {
    const status = container.querySelector('#rm-status');
    if (status) {
      status.style.display = 'block';
      status.textContent = '스케줄 불러오는 중...';
    }

    const params = new URLSearchParams({ type: 'general', limit: '999' });
    const url = `/api/media/dashboard/widgets/${pluginId}/data?${params.toString()}`;

    console.log(LOG_PREFIX, '1/3 데이터 요청 시작:', url);
    const t0 = performance.now();

    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
        if (!data.success) {
          console.warn(LOG_PREFIX, '2/3 서버 오류 응답 (' + elapsed + 's):', data.error);
          if (status) {
            status.style.display = 'block';
            status.textContent = '스케줄을 가져오지 못했습니다: ' + (data.error || '알 수 없는 오류');
          }
          return;
        }
        allItems = Array.isArray(data.items) ? data.items : [];
        console.log(LOG_PREFIX, `2/3 데이터 파싱 완료 (${elapsed}s): 항목 ${allItems.length}개`);
        if (Array.isArray(data.errors) && data.errors.length > 0) {
          console.warn(LOG_PREFIX, '일부 스코프 조회 실패:', data.errors);
          if (status) {
            status.style.display = 'block';
            status.style.color = '#fca5a5';
            status.textContent = `일부 스코프를 불러오지 못했습니다: ${data.errors.join(' / ')}`;
          }
        } else if (status) {
          status.style.display = 'none';
        }
        applyFilter();
        console.log(LOG_PREFIX, '3/3 렌더링 완료');
      })
      .catch((err) => {
        console.error(LOG_PREFIX, '1/3 요청 실패:', err);
        if (status) {
          status.style.display = 'block';
          status.textContent = '서버 연결 오류';
        }
      });
  }

  const searchInput = container.querySelector('#rm-search-input');
  if (searchInput) {
    let debounceTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(applyFilter, 200);
    });
  }

  const refreshBtn = container.querySelector('#rm-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', fetchSchedules);
  }

  const viewGridBtn = container.querySelector('#rm-view-grid-btn');
  if (viewGridBtn) {
    viewGridBtn.addEventListener('click', () => setViewMode('grid'));
  }
  const viewTimelineBtn = container.querySelector('#rm-view-timeline-btn');
  if (viewTimelineBtn) {
    viewTimelineBtn.addEventListener('click', () => setViewMode('timeline'));
  }

  fetchSchedules();
})();
