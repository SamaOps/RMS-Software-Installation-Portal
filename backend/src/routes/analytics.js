import { Router } from 'express';
import { query } from '../db.js';
import { ah } from '../lib/errors.js';
import { limits, wrapper } from '../settings.js';
import { reportJoinSql } from '../lib/schema.js';

const r = Router();

/**
 * GET /api/admin/analytics/status
 * Aggregate success/failure statistics for the dashboard header + charts.
 * "Fleet" numbers use the latest attempt per (device, software) pair.
 */
r.get(
  '/status',
  ah(async (_req, res) => {
    const L = limits;
    const [inv, fleet, daily, errors] = await Promise.all([
      query(`
        SELECT COUNT(*)                                        AS total_softwares,
               COUNT(*) FILTER (WHERE isactive IS NOT FALSE)   AS active_deployments,
               COUNT(*) FILTER (WHERE isactive = FALSE)        AS paused,
               COUNT(*) FILTER (WHERE is_global)               AS global_count,
               COUNT(*) FILTER (WHERE source = 'rms-repository') AS repository_count,
               COUNT(*) FILTER (WHERE source = 'winget')       AS winget_count,
               COUNT(*) FILTER (WHERE source = 'external_url') AS external_count
        FROM softwares WHERE deleted_at IS NULL`),
      query(`
        WITH latest AS (
          SELECT DISTINCT ON (si.software_name, si.device_id) si.issuccessful
          FROM softwares_installed si
          JOIN softwares s ON s.software_name = si.software_name AND s.deleted_at IS NULL
          ORDER BY si.software_name, si.device_id, si.created_at DESC, si.id DESC
        )
        SELECT COUNT(*) AS pairs,
               COUNT(*) FILTER (WHERE issuccessful) AS succeeded,
               COUNT(*) FILTER (WHERE issuccessful IS NOT TRUE) AS failed,
               (SELECT COUNT(*) FROM softwares_installed WHERE created_at > NOW() - make_interval(hours => $1)) AS attempts_24h,
               (SELECT COUNT(DISTINCT device_id) FROM softwares_installed) AS devices_reporting
        FROM latest`, [L.analyticsRecentHours]),
      query(`
        SELECT to_char(d::date, 'YYYY-MM-DD') AS date,
               COUNT(si.id) FILTER (WHERE si.issuccessful)           AS success,
               COUNT(si.id) FILTER (WHERE si.issuccessful IS NOT TRUE AND si.id IS NOT NULL) AS failed
        FROM generate_series(CURRENT_DATE - ($1::int - 1), CURRENT_DATE, INTERVAL '1 day') d
        LEFT JOIN softwares_installed si ON si.created_at::date = d::date
        GROUP BY d ORDER BY d`, [L.analyticsDailyDays]),
      query(`
        SELECT COALESCE(NULLIF(left(COALESCE(si.error_message, rep.error_message), 120), ''),
                        CASE WHEN COALESCE(si.exit_code, rep.exit_code) IS NOT NULL THEN 'Exit code ' || COALESCE(si.exit_code, rep.exit_code) END,
                        'No error message reported') AS error,
               MAX(COALESCE(si.exit_code, rep.exit_code)) AS exit_code,
               COUNT(*) AS count
        FROM softwares_installed si
        ${reportJoinSql(wrapper.reportMatchBeforeMinutes, wrapper.reportMatchAfterMinutes)}
        WHERE si.issuccessful IS NOT TRUE AND si.created_at > NOW() - make_interval(days => $1)
        GROUP BY 1 ORDER BY 3 DESC LIMIT $2`, [L.analyticsErrorWindowDays, L.analyticsTopErrors]),
    ]);

    const f = fleet.rows[0];
    res.json({
      data: {
        inventory: inv.rows[0],
        fleet: {
          device_software_pairs: f.pairs,
          succeeded: f.succeeded,
          failed_needing_attention: f.failed,
          success_rate: f.pairs ? +((f.succeeded / f.pairs) * 100).toFixed(1) : null,
          attempts_24h: f.attempts_24h,
          devices_reporting: f.devices_reporting,
        },
        daily: daily.rows,
        top_errors: errors.rows,
        windows: {
          recent_hours: L.analyticsRecentHours,
          daily_days: L.analyticsDailyDays,
          error_window_days: L.analyticsErrorWindowDays,
        },
      },
    });
  }),
);

export default r;
