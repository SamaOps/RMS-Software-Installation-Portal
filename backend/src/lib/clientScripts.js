/**
 * Publishes the generated install script for a software (see wrapperScript.js):
 * uploads it next to the installers (so Nginx serves it at /softwares/<name>.ps1)
 * and points softwares.winget_id at it, which is what deployed RMS 1.4.0 clients run.
 */
import { config } from '../config.js';
import { HttpError } from './errors.js';
import { generateWrapper, needsWrapper } from './wrapperScript.js';
import { keyFor, putObject, publicUrlFor } from '../storage/s3.js';
import { wrapper } from '../settings.js';

const ROW_SQL = `SELECT id, software_name, version, source, file_name, file_url, winget_id, sha256_checksum, file_size_bytes,
                        installer_type, silent_args, execution_context, target_install_path, create_desktop_shortcut,
                        timeout_minutes, detection_type, detection_path, success_exit_codes, client_script_url
                 FROM softwares WHERE id = $1`;

/** Build the script for a DB row without publishing it (preview). */
export function buildForRow(row) {
  if (!needsWrapper(row)) return null;
  try {
    return generateWrapper(row, { publicDownloadBaseUrl: config.publicDownloadBaseUrl });
  } catch (e) {
    throw new HttpError(400, `Cannot build the install script: ${e.message}`);
  }
}

/**
 * Generate + upload + repoint winget_id. Idempotent: same content -> same name, no re-upload.
 * When the wrapper does not apply (winget, or feature off) it restores winget_id to the file name.
 * @returns {{ url: string, key: string, sha256: string } | null}
 */
export async function publishClientScript(db, softwareId) {
  const r = await db.query(ROW_SQL, [softwareId]);
  if (!r.rowCount) throw new HttpError(404, 'Software not found');
  const row = r.rows[0];

  if (!needsWrapper(row)) {
    if (row.client_script_url && row.source !== 'winget' && row.file_name) {
      await db.query(
        `UPDATE softwares SET winget_id = file_name, client_script_url = NULL, client_script_key = NULL,
                client_script_sha256 = NULL, client_script_generated_at = NULL WHERE id = $1`,
        [row.id],
      );
    }
    return null;
  }
  if (!config.publicDownloadBaseUrl)
    throw new HttpError(400, 'Set PUBLIC_DOWNLOAD_BASE_URL so laptops can download the generated install script.');

  const built = buildForRow(row);
  const key = keyFor(built.fileName);
  const url = publicUrlFor(built.fileName);
  if (url.length > 255) throw new HttpError(400, 'Install script URL is longer than 255 characters; shorten PUBLIC_DOWNLOAD_BASE_URL or the name.');

  if (row.client_script_url !== url) {
    await putObject(key, Buffer.from(built.content, 'utf8'), {
      contentType: 'text/plain; charset=utf-8',
      cacheControl: wrapper.cacheControl,
    });
  }
  await db.query(
    `UPDATE softwares SET winget_id = $2::text, client_script_url = $2::text, client_script_key = $3::text, client_script_sha256 = $4::text,
            client_script_generated_at = CASE WHEN client_script_url IS DISTINCT FROM $2::text THEN NOW() ELSE client_script_generated_at END
     WHERE id = $1`,
    [row.id, url, key, built.sha256],
  );
  return { url, key, sha256: built.sha256 };
}
