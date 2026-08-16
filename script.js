// RCLONE_MANAGER 플러그인 풀페이지 스크립트
// jikji_sf와 동일하게 new Function('pluginId', 'container', ...)로 실행되므로
// import 없이 전역 API + 인자로 받는 pluginId/container만 사용합니다.

(function () {
  const LOG_PREFIX = '[RCLONE_MANAGER]';
  console.log(LOG_PREFIX, '0/3 Fullpage Timetable UI loaded.');

  let allItems = [];

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

  // ------------------------------------------------------------------
  // 겹침 계산: scope 구분 없이 전체(같은 서버/스토리지 자원을 공유한다고
  // 가정)에서 동일 hour:minute에 2개 이상 라이브러리가 몰리면 "겹침"으로 표시.
  // ------------------------------------------------------------------
  function computeOverlapMap(items) {
    const timeMap = new Map(); // "H:M" -> [{scope, name}]
    items.forEach((item) => {
      const times = cronToTimes(item.cron_schedule);
      item._times = times; // 렌더링 단계 재사용
      // 너무 촘촘한 cron(예: 매분 실행)은 겹침 판정에서 제외
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

    if (times.length === 0) {
      const empty = el('span', 'rm-no-schedule', 'cron 없음/파싱불가');
      empty.style.position = 'absolute';
      empty.style.left = '4px';
      empty.style.top = '50%';
      empty.style.transform = 'translateY(-50%)';
      timeline.appendChild(empty);
      return timeline;
    }

    // 매우 촘촘한 스케줄은 개별 점 대신 "상시" 바로 표시
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
      bar.title = `${item.cron_schedule} (매우 잦은 주기)`;
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
    const row = el('div', 'rm-lib-row');

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
    if (icons.childNodes.length > 0) label.appendChild(icons);

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

    // scope별 그룹핑 (백엔드가 보내준 순서를 그대로 유지)
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
      const text = el(
        'span',
        null,
        `전체 라이브러리 ${items.length}개 · 겹치는 시간대 `
      );
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
      container_.appendChild(
        el('div', 'rm-scope-empty', '표시할 라이브러리가 없습니다.')
      );
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

  function fetchSchedules() {
    const status = container.querySelector('#rm-status');
    if (status) {
      status.style.display = 'block';
      status.textContent = '스케줄 불러오는 중...';
    }

    // type 파라미터는 백엔드에서 사용하지 않고(3개 스코프 전체를 항상 합쳐서
    // 반환) 요구되는 쿼리 형식만 맞춰서 보냅니다.
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
