import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FlaskConical } from 'lucide-react';
import { Button, Modal } from './ui';
import { api, apiError } from '../lib/api';
import { useDefaults } from '../lib/defaults';
import type { Software } from '../lib/types';

const RE = /^[A-Za-z0-9._\-/]{3,100}$/;

export function CanaryModal({ software, onClose, onSaved }: { software: Software | null; onClose: () => void; onSaved: (s: Software) => void }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const MAX = useDefaults()?.limits.canary_max_devices ?? 1;
  useEffect(() => setText(software?.test_device_serials.join('\n') ?? ''), [software]);

  const serials = [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
  const invalid = serials.filter((s) => !RE.test(s));
  const error = invalid.length ? `Invalid: ${invalid.join(', ')}` : serials.length > MAX ? `At most ${MAX} devices` : '';

  const save = async () => {
    if (!software) return;
    setSaving(true);
    try {
      const s = await api.setTestDevices(software.id, serials);
      toast.success(serials.length ? `Canary set on ${serials.length} device(s)` : 'Canary devices cleared');
      onSaved(s);
      onClose();
    } catch (e) {
      toast.error(apiError(e).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!software}
      onClose={onClose}
      size="sm"
      title={
        <span className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-amber-600" /> Canary test
        </span>
      }
      subtitle={software?.software_name}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!!error}>
            Save canary devices
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
        These laptops receive the software on their next check-in, in addition to any global/donor/NGO targeting
        {software && !software.is_active && <strong className="text-amber-600"> (the software is paused, so activate it first)</strong>}.
      </p>
      <textarea className="input min-h-[120px] font-mono" value={text} onChange={(e) => setText(e.target.value)} placeholder={'PF2X91AB\n5CD1234XYZ'} />
      <div className="mt-1 flex justify-between text-xs">
        <span className="text-red-600">{error}</span>
        <span className="text-slate-500">
          {serials.length}/{MAX}
        </span>
      </div>
    </Modal>
  );
}
