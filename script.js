// RCLONE_MANAGER 플러그인 풀페이지 스크립트
// jikji_sf와 동일하게 new Function('pluginId', 'container', ...)로 실행되므로
// import 없이 전역 API + 인자로 받는 pluginId/container만 사용합니다.

(function () {
  const LOG_PREFIX = '[RCLONE_MANAGER]';
  console.log(LOG_PREFIX, '0/3 Fullpage Timetable UI loaded.');

  let allItems = [];
  let currentEditItem = null; // 지금 편집 패널에서 다루고 있는 item (allItems의 원소 참조)
  let helperListenersBound = false;

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

  // cron 문자열 -> [{hour, minute}, ...]. 파싱 실패/빈 값이면 빈 배열.
  function cronToTimes(cronStr) {
    if (!cronStr || typeof cronStr !== 'string') return [];
    const fields = cronStr.trim().split(/\s+/);
    if (fields.length < 2) return [];
    try {
      const minutes = parseCronField(fields[0], 0, 59);
      const hours = parseCronField(fields[1], 0, 23);
      const times = [];
      hours.forEach((h) => {
        minutes.forEach((m) => {
          times.push({ hour: h, minute: m });
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

  // ------------------------------------------------------------------
  // 겹침 계산: scope 구분 없이 전체(같은 서버/스토리지 자원을 공유한다고
  // 가정)에서 동일 hour:minute에 2개 이상 라이브러리가 몰리면 "겹침"으로 표시.
  // 편집 중인 항목은 미리보기(pending) 값 기준으로 계산해 실시간 반영.
  // ------------------------------------------------------------------
  function computeOverlapMap(items) {
    const timeMap = new Map();
    items.forEach((item) => {
      const times = cronToTimes(effectiveCron(item));
      item._times = times;
      if (times.length > 96) return;
      times.forEach((t) => {
        const key = `${t.hour}:${t.minute}`;
        if (!timeMap.has(key)) timeMap.set(key, []);
        timeMap.get(key).push(item.name);
      });
    });
    const overlapKeys = new Set();
    timeMap.forEach((names, key) => {
      if (names.length > 1) overlapKeys.add(key);
    });
    return overlapKeys;
  }

  function renderAxis() {
    const row = el('div', 'rm-axis-row');
    for (let h = 0; h < 24; h += 1) {
      row.appendChild(el('span', 'rm-axis-cell', h % 3 === 0 ? `${pad2(h)}시` : ''));
    }
    return row;
  }

  function renderTimeline(item, overlapKeys) {
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
      const key = `${t.hour}:${t.minute}`;
      const isOverlap = overlapKeys.has(key);
      const marker = el('div', 'rm-marker' + (isOverlap ? ' rm-overlap' : ''));
      if (times.length > 12) marker.classList.add('rm-many');
      const pct = ((t.hour * 60 + t.minute) / 1440) * 100;
      marker.style.left = `${pct}%`;
      marker.title = `${item.name} · ${pad2(t.hour)}:${pad2(t.minute)}${
        isOverlap ? ' (다른 라이브러리와 겹침)' : ''
      }`;
      timeline.appendChild(marker);
    });

    return timeline;
  }

  function renderLibRow(item, overlapKeys) {
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
    row.appendChild(renderTimeline(item, overlapKeys));
    return row;
  }

  function renderTimetable(items) {
    const container_ = container.querySelector('#rm-timetable');
    const summary = container.querySelector('#rm-summary');
    if (!container_) return;
    container_.innerHTML = '';

    const overlapKeys = computeOverlapMap(items);

    const scopeOrder = [];
    const byScope = new Map();
    items.forEach((item) => {
      if (!byScope.has(item.scope)) {
        byScope.set(item.scope, []);
        scopeOrder.push(item);
      }
      byScope.get(item.scope).push(item);
    });

    if (summary) {
      const overlapCount = overlapKeys.size;
      summary.innerHTML = '';
      const text = el('span', null, `전체 라이브러리 ${items.length}개 · 겹치는 시간대 `);
      const strong = el('strong', null, `${overlapCount}건`);
      summary.appendChild(text);
      summary.appendChild(strong);
    }

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
          block.appendChild(renderLibRow(item, overlapKeys));
        });
      }

      container_.appendChild(block);
    });

    if (items.length === 0) {
      container_.appendChild(el('div', 'rm-scope-empty', '표시할 라이브러리가 없습니다.'));
    }
  }

  function applyFilter() {
    const searchInput = container.querySelector('#rm-search-input');
    const query = (searchInput ? searchInput.value : '').trim().toLowerCase();
    const filtered = query
      ? allItems.filter((item) => (item.name || '').toLowerCase().includes(query))
      : allItems;
    renderTimetable(filtered);
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
        if (status) status.style.display = 'none';
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

  fetchSchedules();
})();
