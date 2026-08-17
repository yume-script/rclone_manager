# -*- coding: utf-8 -*-
"""
scan_scheduler (스캔 스케줄러)
--------------
BookOasis 카테고리(DB 스코프: general/adult/audio) 하단 개별 라이브러리의
refresh(cron) 스케줄을 한 화면(타임테이블)에서 보여주고, 겹치는 시간대를
시각적으로 표시하기 위한 대시보드 전용 플러그인입니다.

- 검색/적용(search/apply)은 사용하지 않는 대시보드 전용 플러그인입니다.
- 스케줄 데이터는 REST API가 아니라 플러그인 표준 계약인
  self.get_db_gateway(scope)를 통해 DB에서 직접 조회합니다.
- get_dashboard_data()는 core가 넘겨주는 db_type(단일 스코프)을 무시하고,
  general/adult/audio 3개 스코프를 모두 순회해 하나의 리스트로 합쳐 반환합니다.
  (풀페이지 뷰인 index.html/script.js에서 한 번의 fetch로 전체 타임테이블을
  그릴 수 있도록 하기 위함)
"""

from plugins.metadata.base import BaseMetadataProvider


class ScanSchedulerMetadataProvider(BaseMetadataProvider):
    id = "scan_scheduler"
    name = "스캔 스케줄러"
    is_searchable = False
    config_schema = []

    update_manifest = {
        "enabled": True,
        "provider": "github-raw",
        "raw_base_url": "https://raw.githubusercontent.com/yume-script/scan_scheduler/refs/heads/main/",
        "files": [
            "scan_scheduler.py",
            "__init__.py",
            "VERSION",
            "index.html",
            "style.css",
            "script.js",
            "settings.html",
            "settings.css",
            "settings.js",
        ],
        "version_file": "VERSION",
        "version_key": "plugin version",
        "show_sample_update_button": True,
    }

    # 좌측 사이드바에 독립 카테고리 메뉴로 등록. (plugin_board, jikji_sf와 동일한
    # 방식) 이 계약이 있어야 index.html/script.js/style.css가 실제로 로드되어
    # 커스텀 풀페이지(타임테이블)가 렌더링됩니다. dashboard_widget/all_desk_tab은
    # "플러그인 데스크" 탭용 범용 도서 카드 템플릿이라 이 플러그인엔 필요 없습니다.
    category_tab = {
        "title": "스캔 스케줄러",
        "icon": "fa-solid fa-table-cells",
        "order": 95,
    }

    # BookOasis DB 스코프(카테고리) 목록. media_audio 등 스코프가 추가/변경되면
    # 여기만 수정하면 됩니다.
    SCOPES = [
        {"key": "general", "label": "일반 (general)"},
        {"key": "adult", "label": "성인 (adult)"},
        {"key": "audio", "label": "오디오 (audio)"},
    ]

    SCHEDULE_COLUMNS = (
        "id, name, cron_schedule, last_scanned_at, scan_status, "
        "is_remote, vfs_refresh_before_scan, rclone_rc_url"
    )

    # ------------------------------------------------------------------
    # 필수 계약 (대시보드 전용이라 실질 동작은 없음)
    # ------------------------------------------------------------------
    def search(self, db_type, query):
        return []

    def apply(self, db_type, book_id, item_data):
        """book_id=0으로 호출되는 범용 액션 채널 (plugin_board와 동일한 패턴).
        item_data = {"action": "update_cron", "scope": ..., "id": ..., "cron_schedule": ...}
        """
        try:
            return self._dispatch_apply(item_data)
        except Exception as exc:  # noqa: BLE001
            return False, "예상치 못한 오류가 발생했습니다: %s" % exc

    def _dispatch_apply(self, item_data):
        if not isinstance(item_data, dict):
            return False, "유효하지 않은 요청 데이터 형식입니다."

        action = str(item_data.get("action", "")).strip()
        if action != "update_cron":
            return False, "지원하지 않는 action입니다: %s" % action

        scope_key = str(item_data.get("scope", "")).strip()
        valid_scopes = {s["key"] for s in self.SCOPES}
        if scope_key not in valid_scopes:
            return False, "유효하지 않은 스코프입니다: %s" % scope_key

        try:
            library_id = int(item_data.get("id"))
        except (TypeError, ValueError):
            return False, "유효하지 않은 라이브러리 ID입니다."

        cron_schedule = str(item_data.get("cron_schedule", "")).strip()
        if not cron_schedule or len(cron_schedule.split()) < 5:
            return False, "유효하지 않은 cron 표현식입니다: %s" % cron_schedule

        try:
            gateway = self.get_db_gateway(scope_key)
            gateway.execute(
                "UPDATE libraries SET cron_schedule = %s WHERE id = %s",
                (cron_schedule, library_id),
            )
        except Exception as exc:  # noqa: BLE001
            return False, "저장 중 오류가 발생했습니다: %s" % exc

        return True, "스케줄이 저장되었습니다 (%s)" % cron_schedule

    # ------------------------------------------------------------------
    # 풀페이지 뷰(index.html/script.js)가 호출하는 데이터 소스
    # GET /api/media/dashboard/widgets/scan_scheduler/data?type=<아무거나>
    # ------------------------------------------------------------------
    def get_dashboard_data(self, db_type, limit=10):
        items = []
        errors = []

        for scope in self.SCOPES:
            scope_key = scope["key"]
            try:
                gateway = self.get_db_gateway(scope_key)
                rows = gateway.fetch_all(
                    "SELECT %s FROM libraries ORDER BY name" % self.SCHEDULE_COLUMNS
                )
            except Exception as exc:  # noqa: BLE001 - 스코프 하나 실패해도 나머지는 계속 진행
                err_msg = "%s: %s" % (scope_key, exc)
                errors.append(err_msg)
                # 서버 콘솔/로그에서 바로 원인을 확인할 수 있도록 출력
                print("[scan_scheduler] get_dashboard_data 오류: %s" % err_msg)
                rows = []

            for row in rows or []:
                row = dict(row) if row is not None else {}
                items.append(
                    {
                        "scope": scope_key,
                        "scope_label": scope["label"],
                        "id": row.get("id"),
                        "name": row.get("name") or "(이름 없음)",
                        "cron_schedule": row.get("cron_schedule") or "",
                        "last_scanned_at": row.get("last_scanned_at"),
                        "scan_status": row.get("scan_status") or "",
                        "is_remote": bool(row.get("is_remote")),
                        "vfs_refresh_before_scan": bool(
                            row.get("vfs_refresh_before_scan")
                        ),
                        "rclone_rc_url": row.get("rclone_rc_url") or "",
                    }
                )

        if errors and not items:
            return {"success": False, "error": "; ".join(errors)}

        return {"success": True, "items": items, "errors": errors}
