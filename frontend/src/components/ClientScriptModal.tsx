import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Download, RefreshCw, TerminalSquare } from 'lucide-react';
import { Badge, Button, Modal, Spinner } from './ui';
import { api, apiError } from '../lib/api';
import { timeAgo } from '../lib/format';
import type { Software } from '../lib/types';

/**
 * Shows the install script deployed RMS clients (1.4.0) run for this software.
 * The portal generates it from the software's parameters; laptops get it via winget_id.
 */
export function ClientScriptModal({ software, onClose, onSaved }: { software: Software | null; onClose: () => void; onSaved: (s: Software) => void }) {
  const [data, setData] = useState<{ content: string; url: string; current: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const load = (s: Software) => {
    setLoading(true);
    setData(null);
    api
      .clientScript(s.id)
      .then(setData)
      .catch((e) => toast.error(apiError(e).message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    if (software) load(software);
  }, [software]);

  const republish = async () => {
    if (!software) return;
    setPublishing(true);
    try {
      const s = await api.publishClientScript(software.id);
      toast.success('Install script published', { description: 'Laptops pick it up at their next check-in.' });
      onSaved(s);
      load(s);
    } catch (e) {
      toast.error(apiError(e).message);
    } finally {
      setPublishing(false);
    }
  };

  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([data.content], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: data.url.split('/').pop() || 'install.ps1' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Modal
      open={!!software}
      onClose={onClose}
      size="xl"
      title={
        <span className="flex items-center gap-2">
          <TerminalSquare className="h-5 w-5 text-brand-600" /> Install script
        </span>
      }
      subtitle={software?.software_name}
      footer={
        <>
          {data && (
            <>
              <Button variant="secondary" icon={<Copy className="h-4 w-4" />} onClick={() => navigator.clipboard.writeText(data.content).then(() => toast.success('Script copied'))}>
                Copy
              </Button>
              <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={download}>
                Download .ps1
              </Button>
            </>
          )}
          <Button onClick={republish} loading={publishing} icon={<RefreshCw className="h-4 w-4" />}>
            {data && !data.current ? 'Publish latest' : 'Republish'}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
        Laptops on the current RMS client (1.4.0) run this PowerShell script instead of the raw installer. It applies every parameter set in the portal:
        checksum, silent arguments, installer type, user/SYSTEM context, timeout, detection and success codes. It runs one install at a time and reports
        the exit code and log back to the portal. It is regenerated automatically whenever you save the software.
      </p>
      {loading || !data ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            {data.current ? <Badge color="green">Published</Badge> : <Badge color="amber">Out of date, click Publish latest</Badge>}
            {software?.client_script_generated_at && <span className="text-slate-500">generated {timeAgo(software.client_script_generated_at)}</span>}
            {data.url && (
              <code className="break-all rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800" title="What laptops download (stored as winget_id)">
                {data.url}
              </code>
            )}
          </div>
          <pre className="max-h-[55vh] overflow-auto whitespace-pre rounded-lg bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-200">{data.content.replace(/^﻿/, '')}</pre>
        </>
      )}
    </Modal>
  );
}
